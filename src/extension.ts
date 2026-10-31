import * as vscode from 'vscode';
import * as crypto from 'crypto';

// ---------- Types ----------
interface Component {
  name: string;
  responsibility: string;
  dependsOn: string[];
}

interface FileEntry {
  path: string;
  purpose: string;
}

interface Step {
  title: string;
  detail: string;
}

interface Plan {
  goal: string;
  components: Component[];
  files: FileEntry[];
  steps: Step[];
}

interface ProviderConfig {
  name: string;
  baseUrl: string;
  model: string;
  maxTokens?: number;
  keyFrom?: string;
}

interface LlmOptions {
  task: 'plan' | 'explain';
  json?: boolean;
  temperature?: number;
}

interface LlmResult {
  text: string;
  provider: string;
  model: string;
}

// Cooldown map to avoid hitting rate-limited providers repeatedly
const providerCooldowns = new Map<string, number>();

// Status bar item to show current active provider
let statusBarItem: vscode.StatusBarItem;

function updateStatusBar(providerName: string, modelName: string) {
  if (statusBarItem) {
    statusBarItem.text = `$(hubot) Handbook: ${providerName}/${modelName}`;
    statusBarItem.tooltip = `Handbook active LLM: ${providerName} (${modelName})`;
    statusBarItem.show();
  }
}

// ---------- Prompts (the "no code" guardrail lives here) ----------
// Placed first and kept byte-identical across calls to leverage prompt caching
const PLAN_SYSTEM = `You are a software construction handbook. You teach architecture and NEVER write implementation code.
Rules: no code blocks, no snippets, no function bodies. Describe responsibilities, relationships and order of work only.
Return ONLY valid JSON of this exact shape:
{"components":[{"name":"","responsibility":"","dependsOn":[""]}],"files":[{"path":"","purpose":""}],"steps":[{"title":"","detail":""}]}
Use 4-8 components, a realistic file tree (forward-slash paths), and 6-10 ordered build steps. Keep each text field under 25 words.`;

const EXPLAIN_SYSTEM = `You are a software construction handbook. Explain concepts so the developer can build it themselves.
NEVER write implementation code or code blocks. Use plain prose and short bullet points under 200 words.
Structure: What it is / Why it exists in this project / How it relates to other parts / What to read next (name official documentation topics, no URLs).`;

// Safety net: even if the model ignores the rules, code fences never reach the developer.
const stripCode = (t: string): string =>
  t.replace(/```[\s\S]*?```/g, '_[code omitted by Handbook: you build this part]_');

// ---------- Multi-Provider LLM Fallback Chain ----------
const DEFAULT_PROVIDERS: ProviderConfig[] = [
  {
    name: 'groq-gpt-oss',
    baseUrl: 'https://api.groq.com/openai/v1',
    model: 'openai/gpt-oss-120b'
  },
  {
    name: 'groq-qwen',
    baseUrl: 'https://api.groq.com/openai/v1',
    model: 'qwen/qwen3.8-27b',
    keyFrom: 'groq-gpt-oss'
  },
  {
    name: 'gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    model: 'TODO: Enter your Gemini Flash model id here (e.g. gemini-2.5-flash)'
  },
  {
    name: 'ollama',
    baseUrl: 'http://localhost:11434/v1',
    model: 'llama3.1:8b'
  }
];

function getProviders(): ProviderConfig[] {
  const config = vscode.workspace.getConfiguration('handbook');
  const configured = config.get<ProviderConfig[]>('providers');
  if (Array.isArray(configured) && configured.length > 0) {
    return configured;
  }
  return DEFAULT_PROVIDERS;
}

async function getProviderKey(secrets: vscode.SecretStorage, provider: ProviderConfig): Promise<string | undefined> {
  const keyTarget = provider.keyFrom || provider.name;
  let key = await secrets.get(`handbook.key.${keyTarget}`);

  // Backward compatibility: fallback to legacy 'handbook.groqKey' for groq providers
  if (!key && (keyTarget.includes('groq') || provider.baseUrl.includes('api.groq.com'))) {
    key = await secrets.get('handbook.groqKey');
  }

  return key;
}

async function executeSingleProviderCall(
  provider: ProviderConfig,
  key: string | undefined,
  system: string,
  user: string,
  opts: LlmOptions
): Promise<string> {
  const isLocal = provider.baseUrl.includes('localhost') || provider.baseUrl.includes('127.0.0.1');

  // Token controls
  let maxTokens = provider.maxTokens;
  if (!maxTokens) {
    maxTokens = opts.task === 'plan' ? 1500 : 600;
  }

  // Temperature
  let temperature = opts.temperature;
  if (temperature === undefined) {
    temperature = isLocal ? 0.2 : 0.3;
  }

  // Headers
  const headers: Record<string, string> = {
    'Content-Type': 'application/json'
  };
  if (key && !isLocal) {
    headers['Authorization'] = `Bearer ${key}`;
  }

  // Body construction (system prompt placed byte-identical and first for prompt caching)
  const body: any = {
    model: provider.model,
    temperature,
    max_tokens: maxTokens,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user }
    ]
  };

  // Extra parameters: reasoning_effort low for models starting with openai/gpt-oss only
  if (provider.model.startsWith('openai/gpt-oss')) {
    body.reasoning_effort = 'low';
  }

  // JSON mode
  if (opts.json) {
    body.response_format = { type: 'json_object' };
  }

  const endpoint = `${provider.baseUrl.replace(/\/+$/, '')}/chat/completions`;
  const res = await fetch(endpoint, {
    method: 'POST',
    headers,
    body: JSON.stringify(body)
  });

  if (!res.ok) {
    const errorText = await res.text();
    const error: any = new Error(`HTTP ${res.status}: ${errorText}`);
    error.status = res.status;
    error.headers = res.headers;
    throw error;
  }

  const data: any = await res.json();
  const content = data?.choices?.[0]?.message?.content;
  if (typeof content !== 'string') {
    throw new Error('LLM response returned empty content.');
  }

  return content;
}

async function llm(
  secrets: vscode.SecretStorage,
  system: string,
  user: string,
  opts: LlmOptions
): Promise<LlmResult> {
  const providers = getProviders();
  const errors: string[] = [];
  let isFirstAttempt = true;

  for (const provider of providers) {
    const now = Date.now();
    const cooldownUntil = providerCooldowns.get(provider.name);
    if (cooldownUntil && now < cooldownUntil) {
      const waitSec = Math.ceil((cooldownUntil - now) / 1000);
      errors.push(`[${provider.name}] skipped (cooldown active for ${waitSec}s)`);
      continue;
    }

    const isLocal = provider.baseUrl.includes('localhost') || provider.baseUrl.includes('127.0.0.1');
    const key = await getProviderKey(secrets, provider);

    // Skip provider if API key is required but missing
    if (!key && !isLocal) {
      errors.push(`[${provider.name}] skipped (no API key configured for ${provider.keyFrom || provider.name})`);
      continue;
    }

    // Inform user if we failover from a previously failing provider
    if (!isFirstAttempt) {
      vscode.window.showInformationMessage(`Handbook: Failover active, trying provider "${provider.name}" (${provider.model}).`);
    }
    isFirstAttempt = false;

    try {
      const content = await executeSingleProviderCall(provider, key, system, user, opts);
      updateStatusBar(provider.name, provider.model);
      return {
        text: content,
        provider: provider.name,
        model: provider.model
      };
    } catch (err: any) {
      const status = err.status;

      // Handle 401 / 403: notify user explicitly, do not silently skip
      if (status === 401 || status === 403) {
        vscode.window.showErrorMessage(
          `Handbook: Authentication failed for provider "${provider.name}" (${status}). Check API key with "Handbook: Set API Key".`
        );
        errors.push(`[${provider.name}] auth failure (${status}): ${err.message}`);
        continue;
      }

      // Handle 429: set cooldown (retry-after or 10 min default)
      if (status === 429) {
        let cooldownMs = 10 * 60 * 1000;
        try {
          const retryHeader = err.headers?.get ? err.headers.get('retry-after') : undefined;
          if (retryHeader) {
            const parsed = parseInt(retryHeader, 10);
            if (!isNaN(parsed) && parsed > 0) {
              cooldownMs = parsed * 1000;
            }
          }
        } catch {
          // ignore header parse error
        }
        providerCooldowns.set(provider.name, Date.now() + cooldownMs);
        vscode.window.showWarningMessage(
          `Handbook: Provider "${provider.name}" quota/rate limit hit (429). Cooldown set for ${Math.ceil(cooldownMs / 60000)}m.`
        );
        errors.push(`[${provider.name}] rate limited (429): ${err.message}`);
        continue;
      }

      // Handle 404 (model gone), 5xx, network errors: log and fallback to next provider
      errors.push(`[${provider.name}] failed: ${err.message}`);
      continue;
    }
  }

  throw new Error(`All LLM providers failed:\n${errors.join('\n')}`);
}

// ---------- Plan Validation & Generation ----------
function validateAndCleanPlan(data: any): { valid: boolean; plan?: Plan; error?: string } {
  if (!data || typeof data !== 'object') {
    return { valid: false, error: 'Output is not a valid JSON object.' };
  }

  // Validate components: coerce missing fields, drop malformed entries
  const cleanedComponents: Component[] = [];
  if (Array.isArray(data.components)) {
    for (const raw of data.components) {
      if (raw && typeof raw === 'object') {
        const name = typeof raw.name === 'string' ? raw.name.trim() : '';
        const responsibility = typeof raw.responsibility === 'string' ? raw.responsibility.trim() : '';
        const dependsOn: string[] = Array.isArray(raw.dependsOn)
          ? raw.dependsOn.filter((d: any) => typeof d === 'string' && d.trim().length > 0).map((d: string) => d.trim())
          : [];

        if (name.length > 0) {
          cleanedComponents.push({ name, responsibility, dependsOn });
        }
      }
    }
  }

  // Empty components list is treated as a validation failure
  if (cleanedComponents.length === 0) {
    return { valid: false, error: '"components" list is empty or contained only malformed entries.' };
  }

  // Validate files: coerce missing fields, drop malformed entries
  const cleanedFiles: FileEntry[] = [];
  if (Array.isArray(data.files)) {
    for (const raw of data.files) {
      if (raw && typeof raw === 'object') {
        const path = typeof raw.path === 'string' ? raw.path.trim() : '';
        const purpose = typeof raw.purpose === 'string' ? raw.purpose.trim() : '';
        if (path.length > 0) {
          cleanedFiles.push({ path, purpose });
        }
      }
    }
  }

  // Validate steps: coerce missing fields, drop malformed entries
  const cleanedSteps: Step[] = [];
  if (Array.isArray(data.steps)) {
    for (const raw of data.steps) {
      if (raw && typeof raw === 'object') {
        const title = typeof raw.title === 'string' ? raw.title.trim() : '';
        const detail = typeof raw.detail === 'string' ? raw.detail.trim() : '';
        if (title.length > 0) {
          cleanedSteps.push({ title, detail });
        }
      }
    }
  }

  return {
    valid: true,
    plan: {
      goal: typeof data.goal === 'string' ? data.goal : '',
      components: cleanedComponents,
      files: cleanedFiles,
      steps: cleanedSteps
    }
  };
}

async function requestPlanWithRetry(secrets: vscode.SecretStorage, goal: string): Promise<Plan> {
  const providers = getProviders();
  const errors: string[] = [];

  for (const provider of providers) {
    const now = Date.now();
    const cooldownUntil = providerCooldowns.get(provider.name);
    if (cooldownUntil && now < cooldownUntil) {
      continue;
    }

    const isLocal = provider.baseUrl.includes('localhost') || provider.baseUrl.includes('127.0.0.1');
    const key = await getProviderKey(secrets, provider);
    if (!key && !isLocal) {
      continue;
    }

    // Try up to 2 attempts on this provider (initial + 1 retry on malformed JSON or empty components)
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const temp = isLocal ? (attempt === 2 ? 0.1 : 0.2) : 0.3;
        const userPrompt = attempt === 1
          ? `Project: ${goal}`
          : `Project: ${goal}\nPrevious attempt output invalid JSON or empty components. Return ONLY valid JSON with 4-8 components, file tree and steps.`;

        const raw = await executeSingleProviderCall(
          provider,
          key,
          PLAN_SYSTEM,
          userPrompt,
          { task: 'plan', json: true, temperature: temp }
        );

        let parsed: any;
        try {
          parsed = JSON.parse(raw);
        } catch {
          // If JSON parse fails and we have another attempt on this provider, retry
          if (attempt < 2) continue;
          throw new Error('Malformed JSON output from model.');
        }

        const validation = validateAndCleanPlan(parsed);
        if (validation.valid && validation.plan) {
          validation.plan.goal = goal;
          updateStatusBar(provider.name, provider.model);
          return validation.plan;
        }

        if (attempt < 2) continue;
        throw new Error(validation.error || 'Plan validation failed.');
      } catch (err: any) {
        if (attempt === 2) {
          errors.push(`[${provider.name}] failed plan generation: ${err.message}`);
          if (err.status === 429) {
            providerCooldowns.set(provider.name, Date.now() + 10 * 60 * 1000);
          }
        }
      }
    }
  }

  throw new Error(`Plan generation failed across all providers:\n${errors.join('\n')}`);
}

// ---------- Tree View Items & Data Provider ----------
export class Node extends vscode.TreeItem {
  children: Node[] = [];
  parent?: Node;
  componentName?: string;

  constructor(
    label: string,
    collapsible = vscode.TreeItemCollapsibleState.None,
    public detail?: string
  ) {
    super(label, collapsible);
    if (detail) {
      this.tooltip = detail;
    }
  }
}

function buildFileTree(files: FileEntry[]): Node[] {
  const root: Node = new Node('root');
  for (const f of files) {
    const parts = f.path.replace(/\\/g, '/').split('/').filter(Boolean);
    let cur = root;
    parts.forEach((part, i) => {
      const isFile = i === parts.length - 1;
      let next = cur.children.find(c => c.label === part);
      if (!next) {
        next = new Node(
          part,
          isFile ? vscode.TreeItemCollapsibleState.None : vscode.TreeItemCollapsibleState.Expanded
        );
        next.parent = cur;
        if (isFile) {
          next.description = f.purpose;
          next.tooltip = `${f.path}: ${f.purpose}`;
          next.contextValue = 'explainable';
          next.iconPath = vscode.ThemeIcon.File;
        } else {
          next.iconPath = vscode.ThemeIcon.Folder;
        }
        cur.children.push(next);
      }
      cur = next;
    });
  }
  return root.children;
}

export class HandbookTree implements vscode.TreeDataProvider<Node> {
  private _change = new vscode.EventEmitter<Node | undefined | void>();
  readonly onDidChangeTreeData = this._change.event;
  plan?: Plan;
  roots: Node[] = [];
  componentNodes: Map<string, Node> = new Map();

  set(plan: Plan) {
    this.plan = plan;
    this.componentNodes.clear();
    const open = vscode.TreeItemCollapsibleState.Expanded;
    const closed = vscode.TreeItemCollapsibleState.Collapsed;

    // 1. Components
    const comps = new Node('Components', open);
    comps.iconPath = new vscode.ThemeIcon('symbol-class');
    comps.children = plan.components.map(c => {
      const hasDeps = Array.isArray(c.dependsOn) && c.dependsOn.filter(Boolean).length > 0;
      const n = new Node(
        c.name,
        hasDeps ? closed : vscode.TreeItemCollapsibleState.None,
        c.responsibility
      );
      n.description = c.responsibility;
      n.contextValue = 'explainable';
      n.iconPath = new vscode.ThemeIcon('symbol-module');
      n.parent = comps;
      n.componentName = c.name;

      if (hasDeps) {
        n.children = c.dependsOn.filter(Boolean).map(d => {
          const dep = new Node(`depends on: ${d}`, vscode.TreeItemCollapsibleState.None);
          dep.iconPath = new vscode.ThemeIcon('arrow-right');
          dep.parent = n;
          return dep;
        });
      }
      this.componentNodes.set(c.name.trim().toLowerCase(), n);
      return n;
    });

    // 2. File Structure
    const files = new Node('File Structure', open);
    files.iconPath = new vscode.ThemeIcon('list-tree');
    files.children = buildFileTree(plan.files);
    files.children.forEach(c => (c.parent = files));

    // 3. Build Steps
    const steps = new Node('Build Steps', open);
    steps.iconPath = new vscode.ThemeIcon('checklist');
    steps.children = plan.steps.map((s, i) => {
      const n = new Node(`${i + 1}. ${s.title}`, vscode.TreeItemCollapsibleState.None, s.detail);
      n.description = s.detail;
      n.contextValue = 'explainable';
      n.iconPath = new vscode.ThemeIcon('circle-outline');
      n.parent = steps;
      return n;
    });

    this.roots = [comps, files, steps];
    this._change.fire();
  }

  getTreeItem(n: Node): vscode.TreeItem {
    return n;
  }

  getChildren(n?: Node): Node[] {
    return n ? n.children : this.roots;
  }

  getParent(n: Node): Node | undefined {
    return n.parent;
  }
}

// ---------- UI Helpers & Explanation Cache ----------
async function showMarkdownPreview(title: string, markdown: string, footer: string) {
  const content = `# ${title}\n\n${markdown}\n\n---\n*${footer}*\n`;
  const doc = await vscode.workspace.openTextDocument({
    language: 'markdown',
    content
  });
  try {
    await vscode.commands.executeCommand('markdown.showPreviewToSide', doc.uri);
  } catch {
    await vscode.window.showTextDocument(doc, vscode.ViewColumn.Beside);
  }
}

// Explanation cache in workspaceState, keyed by hash of goal + label + detail
function getCacheKey(goal: string, label: string, detail?: string): string {
  const raw = `${goal}:::${label}:::${detail || ''}`;
  return 'handbook.explain.' + crypto.createHash('sha256').update(raw).digest('hex');
}

// Reusable explain function for Tree, Command Palette, and Diagram
async function explainComponent(
  context: vscode.ExtensionContext,
  plan: Plan | undefined,
  label: string,
  detail?: string
) {
  const goal = plan?.goal || 'General Software Construction';
  const cacheKey = getCacheKey(goal, label, detail);

  // Check explanation cache
  const cached = context.workspaceState.get<{ text: string }>(cacheKey);
  if (cached && cached.text) {
    await showMarkdownPreview(label, stripCode(cached.text), 'Generated by cached');
    return;
  }

  const otherComps = (plan?.components ?? []).map(c => c.name).join(', ');
  const prompt =
    `Project: ${goal}\nExplain: "${label}"${detail ? ` (${detail})` : ''}\n` +
    `Other components: ${otherComps}\n\n` +
    `Explain this concept so the developer can build it themselves without showing any implementation code.`;

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `Handbook: Explaining "${label}"...`
    },
    async () => {
      try {
        const res = await llm(context.secrets, EXPLAIN_SYSTEM, prompt, { task: 'explain', json: false });
        // Store in workspaceState cache
        await context.workspaceState.update(cacheKey, { text: res.text });
        const footer = `Generated by ${res.provider}/${res.model}`;
        await showMarkdownPreview(label, stripCode(res.text), footer);
      } catch (e: any) {
        vscode.window.showErrorMessage(`Handbook: ${e.message}`);
      }
    }
  );
}

// ---------- Mermaid Generation & Diagram Webview ----------
interface DiagramPayload {
  definition: string;
  nodes: { id: string; name: string; responsibility: string }[];
  edges: { from: string; to: string }[];
}

function sanitizeLabel(text: string): string {
  if (!text) return '';
  return text
    .replace(/["\\]/g, '#quot;')
    .replace(/[`<>]/g, '')
    .trim()
    .substring(0, 50);
}

function buildMermaidDiagram(plan?: Plan): DiagramPayload {
  if (!plan || !plan.components || plan.components.length === 0) {
    return { definition: '', nodes: [], edges: [] };
  }

  const nodes: { id: string; name: string; responsibility: string }[] = [];
  const edges: { from: string; to: string }[] = [];
  const compMap = new Map<string, string>(); // lowercase name -> safe id

  // Assign safe ids: n0, n1, ...
  plan.components.forEach((c, idx) => {
    const id = `n${idx}`;
    compMap.set(c.name.trim().toLowerCase(), id);
    nodes.push({
      id,
      name: c.name,
      responsibility: c.responsibility || ''
    });
  });

  const lines: string[] = ['flowchart TD'];

  // Nodes
  nodes.forEach(n => {
    const safeName = sanitizeLabel(n.name);
    lines.push(`  ${n.id}["${safeName}"]`);
  });

  // Edges: A --> B means "A depends on B"
  const edgeSet = new Set<string>();
  let extCounter = 0;

  plan.components.forEach((c, idx) => {
    const sourceId = `n${idx}`;
    if (!Array.isArray(c.dependsOn)) return;

    c.dependsOn.forEach(depRaw => {
      if (!depRaw || typeof depRaw !== 'string') return;
      const depKey = depRaw.trim().toLowerCase();
      if (!depKey) return;

      const targetId = compMap.get(depKey);
      if (targetId) {
        if (targetId !== sourceId) {
          const edgeKey = `${sourceId}->${targetId}`;
          if (!edgeSet.has(edgeKey)) {
            edgeSet.add(edgeKey);
            lines.push(`  ${sourceId} --> ${targetId}`);
            edges.push({ from: sourceId, to: targetId });
          }
        }
      } else {
        // Unknown/external dependency
        const extId = `ext${extCounter++}`;
        const safeExt = sanitizeLabel(depRaw);
        lines.push(`  ${extId}["${safeExt}"]`);
        lines.push(`  style ${extId} stroke-dasharray: 5 5`);
        lines.push(`  ${sourceId} -.-> ${extId}`);
      }
    });
  });

  return {
    definition: lines.join('\n'),
    nodes,
    edges
  };
}

let diagramPanel: vscode.WebviewPanel | undefined = undefined;

function getNonce(): string {
  return crypto.randomBytes(16).toString('base64');
}

function getWebviewHtml(webview: vscode.Webview, extensionUri: vscode.Uri): string {
  const nonce = getNonce();
  const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'diagram.js'));
  const cssUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'diagram.css'));
  const mermaidUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'mermaid.min.js'));

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} data:; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <link rel="stylesheet" href="${cssUri}">
  <title>Architecture Diagram</title>
</head>
<body>
  <div class="toolbar">
    <div class="toolbar-info">
      <div class="toolbar-title">🧱 Component Architecture</div>
      <div class="toolbar-hint">Click a component to explain • Scroll to zoom • Drag to pan</div>
    </div>
    <div class="toolbar-actions">
      <button id="btnReset" class="btn">Reset View</button>
    </div>
  </div>

  <div id="viewport" class="viewport">
    <div id="emptyState" class="empty-state" style="display: none;">
      <div>No plan yet. Run <strong>Handbook: Plan Project</strong> to generate the architecture diagram.</div>
    </div>
    <div id="errorState" class="error-state" style="display: none;"></div>
    <div id="canvas" class="canvas"></div>
  </div>

  <script nonce="${nonce}" src="${mermaidUri}"></script>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
}

function sendDiagramState(panel: vscode.WebviewPanel, plan?: Plan) {
  const payload = buildMermaidDiagram(plan);
  panel.webview.postMessage({
    type: 'render',
    definition: payload.definition,
    nodes: payload.nodes,
    edges: payload.edges
  });
}

function openOrRevealDiagram(
  context: vscode.ExtensionContext,
  tree: HandbookTree,
  treeView: vscode.TreeView<Node>
) {
  if (diagramPanel) {
    diagramPanel.reveal(vscode.ViewColumn.Beside);
    sendDiagramState(diagramPanel, tree.plan);
    return;
  }

  const mediaUri = vscode.Uri.joinPath(context.extensionUri, 'media');
  diagramPanel = vscode.window.createWebviewPanel(
    'handbook.diagram',
    'Handbook: Architecture Diagram',
    vscode.ViewColumn.Beside,
    {
      enableScripts: true,
      retainContextWhenHidden: false,
      localResourceRoots: [mediaUri]
    }
  );

  diagramPanel.webview.html = getWebviewHtml(diagramPanel.webview, context.extensionUri);

  // Handle messages from the webview
  diagramPanel.webview.onDidReceiveMessage(
    async (msg: any) => {
      switch (msg.type) {
        case 'ready':
          if (diagramPanel) {
            sendDiagramState(diagramPanel, tree.plan);
          }
          break;
        case 'explain':
          await explainComponent(context, tree.plan, msg.name, msg.responsibility);
          break;
        case 'select':
          if (msg.name) {
            const targetNode = tree.componentNodes.get(msg.name.trim().toLowerCase());
            if (targetNode) {
              treeView.reveal(targetNode, { select: true, focus: false, expand: true });
            }
          }
          break;
      }
    },
    undefined,
    context.subscriptions
  );

  diagramPanel.onDidChangeViewState(
    e => {
      if (e.webviewPanel.visible) {
        sendDiagramState(e.webviewPanel, tree.plan);
      }
    },
    undefined,
    context.subscriptions
  );

  diagramPanel.onDidDispose(
    () => {
      diagramPanel = undefined;
    },
    undefined,
    context.subscriptions
  );
}

// ---------- Activate ----------
export function activate(ctx: vscode.ExtensionContext) {
  const tree = new HandbookTree();

  // Status Bar Item
  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  ctx.subscriptions.push(statusBarItem);
  statusBarItem.text = '$(hubot) Handbook: Ready';
  statusBarItem.show();

  // Register Tree View with createTreeView for two-way reveal/selection support
  const treeView = vscode.window.createTreeView('handbook.tree', {
    treeDataProvider: tree
  });
  ctx.subscriptions.push(treeView);

  // Two-way highlight: selecting a component in the tree highlights its node in the diagram
  treeView.onDidChangeSelection(e => {
    if (!diagramPanel || e.selection.length === 0) return;
    const selected = e.selection[0];
    if (selected.componentName) {
      diagramPanel.webview.postMessage({
        type: 'highlight',
        name: selected.componentName
      });
    }
  });

  // Command: Set API Key (QuickPick for provider, then SecretStorage)
  ctx.subscriptions.push(
    vscode.commands.registerCommand('handbook.setKey', async () => {
      const providers = getProviders().filter(p => !p.baseUrl.includes('localhost') && !p.baseUrl.includes('127.0.0.1'));
      const items = providers.map(p => ({
        label: p.name,
        description: p.baseUrl,
        detail: p.keyFrom ? `Shares key with: ${p.keyFrom}` : undefined,
        keyName: p.keyFrom || p.name
      }));

      const picked = await vscode.window.showQuickPick(items, {
        placeHolder: 'Select a provider to configure its API key'
      });
      if (!picked) return;

      const key = await vscode.window.showInputBox({
        prompt: `Enter API key for provider "${picked.keyName}"`,
        password: true,
        ignoreFocusOut: true
      });
      if (key !== undefined && key.trim().length > 0) {
        await ctx.secrets.store(`handbook.key.${picked.keyName}`, key.trim());
        // For groq providers, also update legacy handbook.groqKey for full backward compatibility
        if (picked.keyName.includes('groq')) {
          await ctx.secrets.store('handbook.groqKey', key.trim());
        }
        vscode.window.showInformationMessage(`Handbook: API key saved for "${picked.keyName}".`);
      }
    })
  );

  // Command: Clear Explanation Cache
  ctx.subscriptions.push(
    vscode.commands.registerCommand('handbook.clearCache', async () => {
      const keys = ctx.workspaceState.keys().filter(k => k.startsWith('handbook.explain.'));
      for (const k of keys) {
        await ctx.workspaceState.update(k, undefined);
      }
      vscode.window.showInformationMessage(`Handbook: Cleared ${keys.length} cached explanations.`);
    })
  );

  // Command: Plan Project (with multi-provider fallback and retry)
  ctx.subscriptions.push(
    vscode.commands.registerCommand('handbook.plan', async () => {
      const goal = await vscode.window.showInputBox({
        prompt: 'What are you building?',
        placeHolder: 'e.g. A student management system with login and course enrolment',
        ignoreFocusOut: true
      });
      if (!goal) {
        return;
      }

      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: 'Handbook: decomposing project with multi-provider chain...'
        },
        async () => {
          try {
            const plan = await requestPlanWithRetry(ctx.secrets, goal.trim());
            tree.set(plan);
            vscode.commands.executeCommand('handbook.tree.focus');

            // Live update: if diagram panel is open, re-render it
            if (diagramPanel) {
              sendDiagramState(diagramPanel, plan);
            }

            vscode.window.showInformationMessage('Handbook: Project plan created.');
          } catch (e: any) {
            vscode.window.showErrorMessage(`Handbook: ${e.message}`);
          }
        }
      );
    })
  );

  // Command: Show Architecture Diagram
  ctx.subscriptions.push(
    vscode.commands.registerCommand('handbook.diagram', () => {
      openOrRevealDiagram(ctx, tree, treeView);
    })
  );

  // Command: Copy Mermaid Source
  ctx.subscriptions.push(
    vscode.commands.registerCommand('handbook.copyMermaid', async () => {
      if (!tree.plan) {
        vscode.window.showWarningMessage('Handbook: No plan available to copy Mermaid source from.');
        return;
      }
      const { definition } = buildMermaidDiagram(tree.plan);
      await vscode.env.clipboard.writeText(definition);
      vscode.window.showInformationMessage('Handbook: Mermaid diagram source copied to clipboard.');
    })
  );

  // Command: Explain (Tree inline icon or Command Palette)
  ctx.subscriptions.push(
    vscode.commands.registerCommand('handbook.explain', async (node?: Node) => {
      let label = '';
      let detail = '';

      if (node) {
        label = typeof node.label === 'string' ? node.label : node.label?.label || '';
        detail = node.detail || (typeof node.description === 'string' ? node.description : '');
      } else {
        const input = await vscode.window.showInputBox({
          prompt: 'What architectural concept or component do you want explained?',
          placeHolder: 'e.g. Auth Middleware, Database Repository, or Event Bus',
          ignoreFocusOut: true
        });
        if (!input) {
          return;
        }
        label = input.trim();
      }

      await explainComponent(ctx, tree.plan, label, detail);
    })
  );
}

export function deactivate() {}
