// Interactive Mermaid Architecture Diagram (Webview script)
(function () {
  const vscode = acquireVsCodeApi();

  let state = {
    definition: '',
    nodes: [], // [{ id: 'n0', name: 'Auth', responsibility: '...' }]
    edges: [], // [{ from: 'n0', to: 'n1' }]
    highlightedName: null
  };

  // Pan & Zoom state
  let scale = 1;
  let panX = 0;
  let panY = 0;
  let isPanning = false;
  let startX = 0;
  let startY = 0;

  const viewport = document.getElementById('viewport');
  const canvas = document.getElementById('canvas');
  const resetBtn = document.getElementById('btnReset');
  const emptyState = document.getElementById('emptyState');
  const errorState = document.getElementById('errorState');

  function updateTransform() {
    canvas.style.transform = `translate(${panX}px, ${panY}px) scale(${scale})`;
  }

  function resetView() {
    scale = 1;
    panX = 0;
    panY = 0;
    updateTransform();
  }

  resetBtn.addEventListener('click', resetView);

  // Wheel zoom
  viewport.addEventListener('wheel', function (e) {
    e.preventDefault();
    const zoomFactor = 0.1;
    if (e.deltaY < 0) {
      scale = Math.min(scale * (1 + zoomFactor), 4);
    } else {
      scale = Math.max(scale * (1 - zoomFactor), 0.25);
    }
    updateTransform();
  }, { passive: false });

  // Pan / Drag
  viewport.addEventListener('mousedown', function (e) {
    // Only drag with left click or middle click
    if (e.button !== 0 && e.button !== 1) return;
    // Don't pan if clicking directly on a node
    if (e.target.closest('.node')) return;

    isPanning = true;
    startX = e.clientX - panX;
    startY = e.clientY - panY;
    viewport.classList.add('grabbing');
  });

  window.addEventListener('mousemove', function (e) {
    if (!isPanning) return;
    panX = e.clientX - startX;
    panY = e.clientY - startY;
    updateTransform();
  });

  window.addEventListener('mouseup', function () {
    isPanning = false;
    viewport.classList.remove('grabbing');
  });

  // Theme detection
  function getTheme() {
    const isDark = document.body.classList.contains('vscode-dark') || document.body.classList.contains('vscode-high-contrast');
    return isDark ? 'dark' : 'default';
  }

  // Observe theme changes on body class
  const themeObserver = new MutationObserver(function () {
    if (state.definition) {
      renderDiagram();
    }
  });
  themeObserver.observe(document.body, { attributes: true, attributeFilter: ['class'] });

  async function renderDiagram() {
    if (!state.definition) {
      emptyState.style.display = 'flex';
      errorState.style.display = 'none';
      canvas.innerHTML = '';
      return;
    }

    emptyState.style.display = 'none';
    errorState.style.display = 'none';

    try {
      mermaid.initialize({
        startOnLoad: false,
        theme: getTheme(),
        securityLevel: 'strict',
        flowchart: {
          curve: 'basis',
          htmlLabels: true,
          useMaxWidth: false
        }
      });

      const uniqueId = 'mermaid-' + Date.now();
      const { svg } = await mermaid.render(uniqueId, state.definition);
      canvas.innerHTML = svg;

      attachNodeListeners();
      applyHighlight();
    } catch (err) {
      console.error('Mermaid render error:', err);
      canvas.innerHTML = '';
      errorState.style.display = 'block';
      errorState.innerHTML = `
        <h3>Diagram Render Error</h3>
        <p>${err && err.message ? err.message : String(err)}</p>
        <pre>${state.definition}</pre>
      `;
    }
  }

  function attachNodeListeners() {
    const svg = canvas.querySelector('svg');
    if (!svg) return;

    // Build map from id prefix to component
    const idMap = new Map();
    state.nodes.forEach(n => idMap.set(n.id, n));

    const nodeElements = svg.querySelectorAll('.node');
    nodeElements.forEach(el => {
      // Mermaid node id format: flowchart-n0-12
      const match = el.id.match(/flowchart-(n\d+)-/);
      const nodeId = match ? match[1] : null;
      const comp = nodeId ? idMap.get(nodeId) : null;

      if (comp) {
        // Set tooltip
        el.setAttribute('title', `${comp.name}: ${comp.responsibility || 'Component'}`);

        // Click to explain and select
        el.addEventListener('click', function (e) {
          e.stopPropagation();
          vscode.postMessage({ type: 'select', name: comp.name });
          vscode.postMessage({ type: 'explain', name: comp.name, responsibility: comp.responsibility });
        });
      }
    });
  }

  function applyHighlight() {
    const svg = canvas.querySelector('svg');
    if (!svg) return;

    const allNodes = svg.querySelectorAll('.node');
    const allEdges = svg.querySelectorAll('.edgePath');

    if (!state.highlightedName) {
      // Remove all dimming & highlights
      allNodes.forEach(n => n.classList.remove('highlighted', 'related', 'dimmed'));
      allEdges.forEach(e => e.classList.remove('highlighted', 'dimmed'));
      return;
    }

    const targetNode = state.nodes.find(n => n.name.toLowerCase() === state.highlightedName.toLowerCase());
    if (!targetNode) {
      allNodes.forEach(n => n.classList.remove('highlighted', 'related', 'dimmed'));
      allEdges.forEach(e => e.classList.remove('highlighted', 'dimmed'));
      return;
    }

    // Find related nodes (dependencies + dependents)
    const relatedIds = new Set();
    const highlightEdgeIndices = new Set();

    state.edges.forEach((edge, idx) => {
      if (edge.from === targetNode.id) {
        relatedIds.add(edge.to);
        highlightEdgeIndices.add(idx);
      }
      if (edge.to === targetNode.id) {
        relatedIds.add(edge.from);
        highlightEdgeIndices.add(idx);
      }
    });

    allNodes.forEach(el => {
      const match = el.id.match(/flowchart-(n\d+)-/);
      const nodeId = match ? match[1] : null;

      el.classList.remove('highlighted', 'related', 'dimmed');
      if (nodeId === targetNode.id) {
        el.classList.add('highlighted');
      } else if (relatedIds.has(nodeId)) {
        el.classList.add('related');
      } else {
        el.classList.add('dimmed');
      }
    });

    allEdges.forEach((el, idx) => {
      el.classList.remove('highlighted', 'dimmed');
      if (highlightEdgeIndices.has(idx)) {
        el.classList.add('highlighted');
      } else {
        el.classList.add('dimmed');
      }
    });
  }

  // Handle incoming messages from extension host
  window.addEventListener('message', function (event) {
    const message = event.data;
    switch (message.type) {
      case 'render':
        state.definition = message.definition || '';
        state.nodes = message.nodes || [];
        state.edges = message.edges || [];
        state.highlightedName = null;
        renderDiagram();
        break;
      case 'highlight':
        state.highlightedName = message.name;
        applyHighlight();
        break;
    }
  });

  // Signal ready to extension to avoid race condition
  vscode.postMessage({ type: 'ready' });
})();
