# Handbook IDE

**Software construction handbook: decomposes a project into components, file structure and build steps without writing the code for you.**

A VS Code extension that helps you plan, visualize, and document software architecture using a multi-provider LLM fallback chain.

---

## Quick Start

### 1. Install dependencies

```bash
npm install
```

### 2. Compile the extension

```bash
npm run compile
```

or watch for changes:

```bash
npm run watch
```

### 3. Run the extension

Press **F5** or select **"Run Extension"** from the debug menu. This launches VS Code in development mode with the Handbook IDE extension loaded.

Alternatively, use the command palette (`Cmd+Shift+P` / `Ctrl+Shift+P`) and run:
- `Handbook: Plan Project`
- `Handbook: Show Architecture Diagram`
- `Handbook: Explain` (on any component)

---

## Features

| Feature | Description |
|---------|-------------|
| **Multi-Provider LLM Fallback** | Ordered chain: Groq GPT-OSS → Groq Qwen → Gemini → Ollama (local) |
| **Project Planning** | Decompose a project into components, files, and build steps via LLM |
| **Architecture Diagram** | Interactive Mermaid.js flowchart with pan/zoom, highlighting, and theming |
| **Component Explanations** | Explain any component in plain prose without code blocks |
| **File Structure Tree** | Visual file tree in the Handbook sidebar |
| **Mermaid Source Copy** | Copy the generated Mermaid diagram definition to clipboard |

---

## Configuration

The extension is configured via VS Code settings (`Ctrl+,` → **Handbook IDE**):

### Multi-Provider Chain

Default provider order (fallback):

| Name | Base URL | Model |
|------|----------|-------|
| `groq-gpt-oss` | `https://api.groq.com/openai/v1` | `openai/gpt-oss-120b` |
| `groq-qwen` | `https://api.groq.com/openai/v1` | `qwen/qwen3.8-27b` (shares key with `groq-gpt-oss`) |
| `gemini` | `https://generativelanguage.googleapis.com/v1beta/openai` | TODO: Enter your Gemini Flash model id |
| `ollama` | `http://localhost:11434/v1` | `llama3.1:8b` (local) |

To configure API keys:

1. Run **Handbook: Set API Key** from the command palette
2. Select a provider and enter its API key (stored securely in VS Code SecretStorage)
3. For Groq providers, the key is also saved as `handbook.groqKey` for backward compatibility

### Customizing the Provider Chain

Override the default providers in your VS Code `settings.json`:

```json
"handbook.providers": [
  {
    "name": "my-provider",
    "baseUrl": "https://api.example.com/v1",
    "model": "my-model-id"
  }
]
```

### Local Ollama Setup

If using the local Ollama provider (`llama3.1:8b`), ensure Ollama is running:

```bash
# Start Ollama server
ollama serve

# Pull the model
ollama pull llama3.1:8b
```

---

## Usage Workflow

### 1. Plan a Project

Command: **Handbook: Plan Project**

- Enter your project goal (e.g., "A student management system with login and course enrollment")
- The extension queries the multi-provider LLM chain and returns:
  - **Components**: Responsibilities and dependencies
  - **Files**: Paths and purposes
  - **Build Steps**: Ordered construction workflow
- The plan appears in the **Handbook** sidebar

### 2. View Architecture Diagram

Command: **Handbook: Show Architecture Diagram**

- Opens a webview panel with an interactive Mermaid flowchart
- Nodes represent components with responsibilities
- Edges show dependencies
- **Controls**:
  - Scroll wheel: zoom in/out (0.25x to 4x)
  - Left-click + drag: pan the diagram
  - Click a component node: highlight it and show related components
  - Reset view button: return to default zoom/pan

### 3. Explain a Component

Command: **Handbook: Explain** (or click the inline info icon on any component in the tree)

- Explain any component in plain prose
- Results are cached per (goal, label, detail) so repeated explanations are instant
- Explanations follow the rule: **no code blocks, no snippets, no function bodies**

### 4. Copy Mermaid Source

Command: **Handbook: Copy Mermaid Source**

- Copies the raw Mermaid diagram definition to clipboard
- Useful for pasting into other tools or customizing the diagram

---

## Development

### Project Structure

```
handbook-ide/
├── out/                 # Compiled JS (generated)
├── media/               # Static assets for webview
│   ├── diagram.css
│   ├── diagram.js
│   └── mermaid.min.js
├── scripts/             # Build utilities
│   └── copy-mermaid.js
├── src/                 # TypeScript source
│   └── extension.ts
├── package.json
├── tsconfig.json
└── .gitignore
```

### Build Pipeline

The `compile` script (`npm run compile`) performs two steps:

1. **Copy Mermaid**: `node scripts/copy-mermaid.js` — copies `mermaid.min.js` from `node_modules` to `media/`
2. **Compile TypeScript**: `tsc -p ./` — compiles `src/extension.ts` to `out/extension.js`

### Adding New Features

1. Edit `src/extension.ts` for new commands/behavior
2. Add static assets to `media/` if needed for webviews
3. Re-run `npm run compile` to rebuild

---

## WSL Bashrc Alias

Add this to your `~/.bashrc` (WSL) to compile and launch the extension in one command:

```bash
alias handbook-ide="cd /path/to/handbook-ide && npm run compile && code --extensions-dir ~/.vscode-extensions --force-save-events"
```

**Explanation**:

- `cd /path/to/handbook-ide` — navigate to the extension workspace
- `npm run compile` — copies Mermaid JS and compiles TypeScript
- `code --extensions-dir ~/.vscode-extensions --force-save-events` — opens VS Code with the extension

**After adding the alias, reload bash**:

```bash
source ~/.bashrc
```

Then simply run:

```bash
handbook-ide
```

To quickly plan a project from WSL:

```bash
handbook-ide --plan "Your project goal here"
```

Or add a second alias:

```bash
alias handbook-plan="cd /path/to/handbook-ide && code --command handbook.plan"
```

---

## Requirements

- VS Code 1.90.0 or newer
- Node.js (for compilation)
- Groq API key (for cloud providers) **or** Ollama running locally
- Internet access for cloud LLM providers, or local network for Ollama

---

## License

Local / unpublished.