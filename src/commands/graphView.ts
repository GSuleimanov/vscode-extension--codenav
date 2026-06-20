import * as vscode from 'vscode';
import { parseJavaSource, buildGraph, Graph, ParsedClass } from './graphModel';

export class GraphSideView implements vscode.WebviewViewProvider {
  static readonly viewId = 'javaNavigator.graphView';

  private view?: vscode.WebviewView;
  private graph: Graph = { nodes: [], edges: [] };
  private loaded = false;

  constructor(private readonly context: vscode.ExtensionContext) {}

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    webviewView.webview.options = { enableScripts: true };
    webviewView.webview.html = this.getHtml();

    webviewView.webview.onDidReceiveMessage(async (msg) => {
      if (msg.command === 'navigate' && msg.uri) {
        const doc = await vscode.workspace.openTextDocument(vscode.Uri.parse(msg.uri));
        await vscode.window.showTextDocument(doc, {
          viewColumn: vscode.ViewColumn.One,
          selection: new vscode.Range(msg.line ?? 0, 0, msg.line ?? 0, 0),
        });
      } else if (msg.command === 'refresh') {
        await this.reload();
      } else if (msg.command === 'recenter') {
        const uri = vscode.window.activeTextEditor?.document.uri.toString();
        if (uri) { this.focusUri(uri); }
      }
    }, undefined, this.context.subscriptions);

    // Re-focus the graph on the active file whenever it changes.
    this.context.subscriptions.push(
      vscode.window.onDidChangeActiveTextEditor((editor) => {
        if (editor?.document.languageId === 'java') {
          this.focusUri(editor.document.uri.toString());
        }
      })
    );

    // Initial load shows the whole graph zoomed out (no auto-focus on a node).
    void this.loadGraph();
  }

  /** Reveal the graph pane (whole graph, zoomed out). */
  reveal(): void {
    if (this.view) {
      this.view.show?.(true);
    } else {
      // View not yet resolved — opening it triggers resolveWebviewView.
      void vscode.commands.executeCommand(`${GraphSideView.viewId}.focus`);
    }
  }

  /** Reveal the graph pane and center it on the current file's class. */
  revealAndFocus(): void {
    this.reveal();
    const uri = vscode.window.activeTextEditor?.document.uri.toString();
    if (uri) { this.focusUri(uri); }
  }

  /** Focus the graph on the file with the given uri (no-op if not loaded yet). */
  focusUri(uri: string): void {
    this.view?.webview.postMessage({ command: 'focusNode', uri });
  }

  /** Rebuild the graph from current sources (keeps the whole graph in view). */
  private async reload(): Promise<void> {
    this.loaded = false;
    await this.loadGraph();
  }

  /** Discover Java sources, parse them, build the deduped graph, push to webview. */
  private async loadGraph(): Promise<void> {
    if (this.loaded) { return; }
    this.loaded = true;
    // Only real Java source roots (Maven/Gradle layout) — skips sample/snippet
    // .java files under tooling dirs like .claude, docs, etc.
    const files = await vscode.workspace.findFiles(
      '**/src/{main,test,it,integration-test,testFixtures}/**/*.java',
      '**/{node_modules,target,build,bin,out}/**'
    );
    const parsed: ParsedClass[] = [];

    // Read files concurrently in bounded batches for efficiency on large projects.
    const BATCH = 50;
    for (let i = 0; i < files.length; i += BATCH) {
      const batch = files.slice(i, i + BATCH);
      const texts = await Promise.all(
        batch.map(async (uri) => {
          try {
            const bytes = await vscode.workspace.fs.readFile(uri);
            return { uri, text: Buffer.from(bytes).toString('utf8') };
          } catch {
            return { uri, text: '' };
          }
        })
      );
      for (const { uri, text } of texts) {
        if (text) { parsed.push(...parseJavaSource(text, uri.toString())); }
      }
    }

    this.graph = buildGraph(parsed);
    this.view?.webview.postMessage({ command: 'loadGraph', graph: this.graph });
  }

  private getHtml(): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Java Project Graph</title>
  <style>
    body { margin: 0; background: var(--vscode-editor-background); color: var(--vscode-editor-foreground); font-family: var(--vscode-font-family); display: flex; flex-direction: column; height: 100vh; overflow: hidden; }
    #toolbar { padding: 6px 12px; display: flex; gap: 8px; align-items: center; justify-content: flex-end; border-bottom: 1px solid var(--vscode-panel-border); }
    .chip { background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); border: 1px solid var(--vscode-panel-border); padding: 3px 11px; border-radius: 11px; cursor: pointer; font-size: 11px; user-select: none; transition: opacity .12s ease; }
    .chip.off { opacity: 0.4; }
    .chip:hover { filter: brightness(1.15); }
    #cy { flex: 1; position: relative; min-height: 0; overflow: hidden; }
    canvas { display: block; position: absolute; inset: 0; }
    #floatBtns { position: absolute; right: 14px; bottom: 14px; display: flex; gap: 8px; }
    #floatBtns button { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; padding: 6px 13px; border-radius: 5px; cursor: pointer; font-size: 12px; box-shadow: 0 1px 5px rgba(0,0,0,0.35); opacity: 0.92; }
    #floatBtns button:hover { opacity: 1; background: var(--vscode-button-hoverBackground); }
    #status { padding: 4px 12px; font-size: 11px; color: var(--vscode-descriptionForeground); border-top: 1px solid var(--vscode-panel-border); }
  </style>
</head>
<body>
  <div id="toolbar">
    <span class="chip" id="chipDtoEnum" title="Show/hide DTOs and enums">DTOs/Enums</span>
    <span class="chip" id="chipTests" title="Show/hide test classes">Tests</span>
  </div>
  <div id="cy">
    <canvas id="canvas"></canvas>
    <div id="floatBtns">
      <button id="recenter" title="Center on the currently opened class">Recenter</button>
      <button id="reset" title="Rebuild the graph from current sources">Reset</button>
    </div>
  </div>
  <div id="status">Loading project graph — indexing by Java Language Server…</div>
  <script>
    const vscode = acquireVsCodeApi();
    const canvas = document.getElementById('canvas');
    const ctx = canvas.getContext('2d');
    const statusEl = document.getElementById('status');

    let nodes = [];   // {id, name, package, uri, line, kind, x, y, vx, vy}
    let edges = [];   // {from, to, kind}
    let nodeById = new Map();
    let view = { x: 0, y: 0, scale: 1 };
    let focusId = null;
    let neighbors = new Set();
    // True once the user manually pans: the dragged viewport is kept through
    // zoom/resize instead of snapping back to the focused node (highlight stays).
    let manualView = false;

    // Category filters (chips). true = included, false = filtered out.
    const filters = { dtoEnum: true, test: true };

    // Classify a node for filtering: 'test', 'dtoEnum', or 'normal'.
    function categoryOf(n) {
      const uri = n.uri || '';
      if (/\\/(test|tests|it|integration-test)\\//i.test(uri) ||
          /(Test|Tests|TestCase|Spec|IT)\\.java$/.test(uri)) {
        return 'test';
      }
      if (n.kind === 'enum') { return 'dtoEnum'; }
      if (/(DTO|Dto|Request|Response|Payload|VO)$/.test(n.name)) { return 'dtoEnum'; }
      return 'normal';
    }

    function isVisible(n) {
      const c = categoryOf(n);
      if (c === 'test' && !filters.test) { return false; }
      if (c === 'dtoEnum' && !filters.dtoEnum) { return false; }
      return true;
    }

    // Canvas can't consume CSS var(--...) values, so resolve theme variables to
    // real color strings. Recomputed each draw so it tracks live theme changes.
    function cssVar(name, fallback) {
      const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
      return v || fallback;
    }
    let theme = {};
    function refreshTheme() {
      theme = {
        nodeFill:   cssVar('--vscode-button-background', '#0e639c'),
        nodeText:   cssVar('--vscode-foreground', '#cccccc'),
        nodeBorder: cssVar('--vscode-panel-border', '#80808060'),
        match:      cssVar('--vscode-charts-yellow', '#d7ba7d'),
        focus:      cssVar('--vscode-charts-green', '#4ec9b0'),
        labelBg:    cssVar('--vscode-editorHoverWidget-background', '#252526'),
        labelBorder:cssVar('--vscode-editorHoverWidget-border', '#454545'),
        edge: {
          extends:    cssVar('--vscode-charts-green', '#4ec9b0'),
          implements: cssVar('--vscode-charts-purple', '#c586c0'),
          uses:       cssVar('--vscode-charts-blue', '#569cd6'),
        },
      };
    }

    function resize() {
      const r = canvas.parentElement.getBoundingClientRect();
      canvas.width = r.width; canvas.height = r.height;
    }

    function screenToWorld(sx, sy) {
      return { x: (sx - view.x) / view.scale, y: (sy - view.y) / view.scale };
    }

    // Re-measure the canvas when the pane is resized/moved/revealed, keeping the
    // opened class (or, failing that, the current center) anchored in view.
    function handleResize() {
      const r = canvas.parentElement.getBoundingClientRect();
      const newW = Math.round(r.width), newH = Math.round(r.height);
      const oldW = canvas.width, oldH = canvas.height;
      // Only touch canvas.width/height when it actually changed — assigning it
      // clears the canvas, so a no-op resize must not blank the graph.
      if (newW === oldW && newH === oldH) { return; }
      const center = (oldW && oldH) ? screenToWorld(oldW / 2, oldH / 2) : null;
      canvas.width = newW; canvas.height = newH;   // (this clears the canvas)
      if (!nodes.length) { draw(); return; }
      const focusNode = (!manualView && focusId) ? nodeById.get(focusId) : null;
      if (focusNode) {
        focusOnNode(focusNode);   // re-anchor the opened class at center
      } else if (center) {
        view.x = newW / 2 - center.x * view.scale;
        view.y = newH / 2 - center.y * view.scale;
        draw();
      } else {
        draw();
      }
    }

    // ResizeObserver catches pane-only resizes that window 'resize' misses.
    new ResizeObserver(() => handleResize()).observe(canvas.parentElement);
    window.addEventListener('resize', () => handleResize());

    window.addEventListener('message', event => {
      const msg = event.data;
      if (msg.command === 'loadGraph') {
        initGraph(msg.graph);
      }
      if (msg.command === 'focusNode') {
        if (canvas.width === 0 || canvas.height === 0) { resize(); }
        const n = nodes.find(n => n.uri === msg.uri);
        if (n) { setFocus(n.id); focusOnNode(n); }
      }
    });

    function initGraph(graph) {
      resize();
      // Preserve positions of nodes that survived the refresh.
      const prevPos = new Map(nodes.map(n => [n.id, { x: n.x, y: n.y }]));
      const isRefresh = prevPos.size > 0;

      // Centroid of existing layout (fallback spawn point for new nodes).
      let cx = canvas.width / 2, cy = canvas.height / 2;
      if (isRefresh && prevPos.size > 0) {
        let sx = 0, sy = 0;
        for (const p of prevPos.values()) { sx += p.x; sy += p.y; }
        cx = sx / prevPos.size; cy = sy / prevPos.size;
      }

      edges = graph.edges;

      const total = graph.nodes.length || 1;
      nodes = graph.nodes.map((n, i) => {
        if (prevPos.has(n.id)) {
          const p = prevPos.get(n.id);
          return { ...n, x: p.x, y: p.y, vx: 0, vy: 0 };
        }
        if (!isRefresh) {
          // First load: deterministic spread (rings) so the layout is stable and
          // idempotent — no Math.random seeding, no degenerate central cloud.
          const a = (i / total) * Math.PI * 2;
          const rad = 150 + (i % 13) * 40;
          return { ...n, x: cx + Math.cos(a) * rad, y: cy + Math.sin(a) * rad, vx: 0, vy: 0 };
        }
        // Refresh: spawn a newly-added node near a connected neighbor if one exists, else near centroid.
        let spawnX = cx + (Math.random() - 0.5) * 60;
        let spawnY = cy + (Math.random() - 0.5) * 60;
        for (const e of edges) {
          const neighborId = e.from === n.id ? e.to : (e.to === n.id ? e.from : null);
          if (neighborId && prevPos.has(neighborId)) {
            const p = prevPos.get(neighborId);
            spawnX = p.x + (Math.random() - 0.5) * 80;
            spawnY = p.y + (Math.random() - 0.5) * 80;
            break;
          }
        }
        return { ...n, x: spawnX, y: spawnY, vx: 0, vy: 0 };
      });

      nodeById = new Map(nodes.map(n => [n.id, n]));
      recomputeDegree();
      statusEl.textContent = nodes.length + ' classes, ' + edges.length + ' relationships';

      if (!isRefresh) {
        runLayout();              // first load: full layout, then fit-all centered
      } else {
        // Reset: keep existing positions, settle any new nodes, then re-fit so the
        // whole graph is centered and zoomed to fit (same as a fresh open).
        const movable = new Set(nodes.filter(n => !prevPos.has(n.id)).map(n => n.id));
        focusId = null; neighbors = new Set(); manualView = false;
        runLayout(movable.size > 0 ? 120 : 0, true, movable);
      }
    }

    // Simple force-directed layout (Fruchterman-Reingold-ish), fixed iterations.
    // movable: optional Set of node ids allowed to move; others stay pinned and
    // act as fixed anchors (used on refresh to preserve the existing structure).
    function runLayout(iterations, fit, movable) {
      const W = canvas.width || 800, H = canvas.height || 600;
      const area = W * H;
      const k = Math.sqrt(area / Math.max(nodes.length, 1)) * 0.6;
      let temp = W / 8;
      if (iterations === undefined) { iterations = Math.min(300, 120 + nodes.length); fit = true; }

      for (let it = 0; it < iterations; it++) {
        // repulsion
        for (let i = 0; i < nodes.length; i++) {
          const a = nodes[i]; a.vx = 0; a.vy = 0;
          for (let j = 0; j < nodes.length; j++) {
            if (i === j) continue;
            const b = nodes[j];
            let dx = a.x - b.x, dy = a.y - b.y;
            let d = Math.sqrt(dx * dx + dy * dy) || 0.01;
            const rep = (k * k) / d;
            a.vx += (dx / d) * rep; a.vy += (dy / d) * rep;
          }
        }
        // attraction along edges
        for (const e of edges) {
          const a = nodeById.get(e.from), b = nodeById.get(e.to);
          if (!a || !b) continue;
          let dx = a.x - b.x, dy = a.y - b.y;
          let d = Math.sqrt(dx * dx + dy * dy) || 0.01;
          const att = (d * d) / k;
          const fx = (dx / d) * att, fy = (dy / d) * att;
          a.vx -= fx; a.vy -= fy; b.vx += fx; b.vy += fy;
        }
        for (const n of nodes) {
          if (movable && !movable.has(n.id)) continue;  // pinned node: don't move
          let d = Math.sqrt(n.vx * n.vx + n.vy * n.vy) || 0.01;
          n.x += (n.vx / d) * Math.min(d, temp);
          n.y += (n.vy / d) * Math.min(d, temp);
        }
        temp *= 0.97;
      }
      if (fit) { fitView(); }
      draw();
    }

    // Center the whole graph in the canvas and zoom so every (visible) node fits.
    function fitView() {
      const shown = nodes.filter(isVisible);
      if (!shown.length) return;
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const n of shown) { minX = Math.min(minX, n.x); minY = Math.min(minY, n.y); maxX = Math.max(maxX, n.x); maxY = Math.max(maxY, n.y); }
      const pad = 80;  // screen-px margin to keep node radii + labels on-screen
      const gw = (maxX - minX) || 1, gh = (maxY - minY) || 1;
      const scale = Math.min((canvas.width - pad) / gw, (canvas.height - pad) / gh, 1.6);
      view.scale = scale;
      // Place the bounding-box center exactly at the canvas center.
      const bcx = (minX + maxX) / 2, bcy = (minY + maxY) / 2;
      view.x = canvas.width / 2 - bcx * scale;
      view.y = canvas.height / 2 - bcy * scale;
    }

    // Center a class precisely at the canvas center and zoom so that all of its
    // active (visible) connected neighbors fit on screen.
    const FOCUS_MAX_ZOOM = 1.8;
    function focusOnNode(n) {
      manualView = false;  // an explicit focus re-anchors the viewport
      // Active connected neighbors (respecting the current chip filters).
      const connected = [];
      for (const e of edges) {
        let other = null;
        if (e.from === n.id) { other = nodeById.get(e.to); }
        else if (e.to === n.id) { other = nodeById.get(e.from); }
        if (other && isVisible(other)) { connected.push(other); }
      }
      // Largest offset from n to any neighbor in each axis. We center n, so to
      // keep every neighbor on screen each must fit within half the viewport.
      let maxDx = 0, maxDy = 0;
      for (const c of connected) {
        maxDx = Math.max(maxDx, Math.abs(c.x - n.x));
        maxDy = Math.max(maxDy, Math.abs(c.y - n.y));
      }
      const PAD = 70;  // screen-px margin covering node radius + labels
      const halfW = Math.max(canvas.width / 2 - PAD, 1);
      const halfH = Math.max(canvas.height / 2 - PAD, 1);
      let scale = FOCUS_MAX_ZOOM;
      if (maxDx > 0) { scale = Math.min(scale, halfW / maxDx); }
      if (maxDy > 0) { scale = Math.min(scale, halfH / maxDy); }
      if (!isFinite(scale) || scale <= 0) { scale = FOCUS_MAX_ZOOM; }
      view.scale = scale;
      // n sits exactly at the canvas center.
      view.x = canvas.width / 2 - n.x * scale;
      view.y = canvas.height / 2 - n.y * scale;
      draw();
    }

    function setFocus(id) {
      focusId = id;
      neighbors = new Set([id]);
      for (const e of edges) {
        if (e.from === id) neighbors.add(e.to);
        if (e.to === id) neighbors.add(e.from);
      }
      draw();
    }

    let hoverNode = null;
    const NAME_MIN_ZOOM = 0.7;  // hide names below this zoom even when a node is selected

    function toScreen(n) { return { x: n.x * view.scale + view.x, y: n.y * view.scale + view.y }; }

    function draw() {
      refreshTheme();
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      // edges
      for (const e of edges) {
        const a = nodeById.get(e.from), b = nodeById.get(e.to);
        if (!a || !b) continue;
        if (!isVisible(a) || !isVisible(b)) continue;   // hide edges to filtered nodes
        const dim = focusId && !(neighbors.has(e.from) && neighbors.has(e.to));
        const baseAlpha = dim ? 0.08 : 0.7;
        const A = toScreen(a), B = toScreen(b);
        ctx.globalAlpha = baseAlpha;
        ctx.strokeStyle = theme.edge[e.kind];
        ctx.fillStyle = theme.edge[e.kind];
        ctx.lineWidth = 1.2;
        ctx.beginPath(); ctx.moveTo(A.x, A.y); ctx.lineTo(B.x, B.y); ctx.stroke();
        // Arrowheads only when a component is selected, and only on that
        // component's own connections; everything else stays a plain line.
        const incidentToFocus = focusId && (e.from === focusId || e.to === focusId);
        if (incidentToFocus) {
          ctx.globalAlpha = baseAlpha;
          const ang = Math.atan2(B.y - A.y, B.x - A.x);
          const r = 6 + 4;
          const ex = B.x - Math.cos(ang) * (nodeRadius(b) + 2), ey = B.y - Math.sin(ang) * (nodeRadius(b) + 2);
          ctx.beginPath();
          ctx.moveTo(ex, ey);
          ctx.lineTo(ex - Math.cos(ang - 0.4) * r, ey - Math.sin(ang - 0.4) * r);
          ctx.lineTo(ex - Math.cos(ang + 0.4) * r, ey - Math.sin(ang + 0.4) * r);
          ctx.closePath(); ctx.fill();
        }
      }
      ctx.globalAlpha = 1;
      // nodes — draw hovered node last so it's always on top
      const visibleNodes = nodes.filter(isVisible);
      const drawOrder = hoverNode
        ? [...visibleNodes.filter(n => n !== hoverNode), hoverNode]
        : visibleNodes;
      for (const n of drawOrder) {
        const s = toScreen(n);
        const matches = false;
        const dimmed = focusId && !neighbors.has(n.id);
        const isHover = n === hoverNode;
        const rad = nodeRadius(n) + (isHover ? 3 : 0);
        ctx.globalAlpha = dimmed ? 0.2 : 1;

        // subtle glow ring on hover
        if (isHover) {
          ctx.beginPath();
          ctx.arc(s.x, s.y, rad + 5, 0, Math.PI * 2);
          ctx.fillStyle = theme.nodeFill;
          ctx.globalAlpha = dimmed ? 0.05 : 0.18;
          ctx.fill();
          ctx.globalAlpha = 1;
        }

        ctx.beginPath();
        ctx.arc(s.x, s.y, rad, 0, Math.PI * 2);
        ctx.fillStyle = matches ? theme.match : (n.id === focusId ? theme.focus : theme.nodeFill);
        ctx.fill();
        ctx.strokeStyle = isHover ? theme.nodeText : theme.nodeBorder;
        ctx.lineWidth = (matches || n.id === focusId || isHover) ? 2 : 0.5;
        ctx.stroke();

        if (isHover) {
          // Tooltip badge drawn on top of everything.
          ctx.font = 'bold 12px var(--vscode-font-family)';
          const tw = ctx.measureText(n.name).width;
          const padX = 7, padY = 4, corner = 4;
          const bw = tw + padX * 2, bh = 13 + padY * 2;
          const bx = s.x - bw / 2;
          const by = s.y - rad - 8 - bh;
          ctx.fillStyle = theme.labelBg;
          ctx.beginPath();
          ctx.roundRect(bx, by, bw, bh, corner);
          ctx.fill();
          ctx.strokeStyle = theme.labelBorder;
          ctx.lineWidth = 0.8;
          ctx.stroke();
          ctx.fillStyle = theme.nodeText;
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText(n.name, s.x, by + bh / 2);
          ctx.textBaseline = 'alphabetic';  // restore default
        } else if (focusId && view.scale > NAME_MIN_ZOOM) {
          // A selection reveals every component's name (not just active ones),
          // but only once zoomed in enough to avoid clutter when zoomed out.
          ctx.fillStyle = theme.nodeText;
          ctx.font = '11px var(--vscode-font-family)';
          ctx.textAlign = 'center';
          ctx.fillText(n.name, s.x, s.y - rad - 4);
        }
      }
      ctx.globalAlpha = 1;
    }

    function nodeRadius(n) {
      const deg = degree.get(n.id) || 1;
      return Math.min(14, 5 + deg);
    }
    let degree = new Map();
    function recomputeDegree() {
      degree = new Map();
      for (const e of edges) {
        degree.set(e.from, (degree.get(e.from) || 0) + 1);
        degree.set(e.to, (degree.get(e.to) || 0) + 1);
      }
    }

    // -- interaction (drag nodes, pan canvas, zoom, single-click navigate, hover) --
    let dragging = null, panning = false, last = null, mouseDownPos = null, didMove = false;

    canvas.addEventListener('mousedown', e => {
      mouseDownPos = { x: e.offsetX, y: e.offsetY };
      last = { x: e.offsetX, y: e.offsetY };
      didMove = false;
      const hit = pick(e.offsetX, e.offsetY);
      if (hit) { dragging = hit; }
      else { panning = true; }
    });
    canvas.addEventListener('mousemove', e => {
      const dx = e.offsetX - (last?.x ?? e.offsetX);
      const dy = e.offsetY - (last?.y ?? e.offsetY);
      if (Math.abs(dx) + Math.abs(dy) > 3) { didMove = true; }
      if (dragging) {
        dragging.x += dx / view.scale;
        dragging.y += dy / view.scale;
        draw();
      } else if (panning && last) {
        // Manual pan takes over the viewport (keeps the focus highlight); the
        // dragged center persists through subsequent zoom and pane resizes.
        if (didMove) { manualView = true; }
        view.x += dx; view.y += dy;
        draw();
      }
      last = { x: e.offsetX, y: e.offsetY };
      // hover
      const hit = pick(e.offsetX, e.offsetY);
      if (hit !== hoverNode) {
        hoverNode = hit;
        canvas.style.cursor = hit ? 'pointer' : 'default';
        draw();
      }
    });
    window.addEventListener('mouseup', () => {
      if (!didMove && mouseDownPos) {
        const hit = pick(mouseDownPos.x, mouseDownPos.y);
        if (hit) { vscode.postMessage({ command: 'navigate', uri: hit.uri, line: hit.line }); }
      }
      dragging = null; panning = false; last = null; mouseDownPos = null;
    });
    canvas.addEventListener('mouseleave', () => {
      if (hoverNode) { hoverNode = null; canvas.style.cursor = 'default'; draw(); }
    });

    canvas.addEventListener('wheel', e => {
      e.preventDefault();
      const factor = e.deltaY < 0 ? 1.06 : 0.94;
      // Zoom about the viewport center so the centered point persists.
      const cx = canvas.width / 2, cy = canvas.height / 2;
      view.x = cx - (cx - view.x) * factor;
      view.y = cy - (cy - view.y) * factor;
      view.scale *= factor;
      draw();
    }, { passive: false });

    function pick(px, py) {
      for (let i = nodes.length - 1; i >= 0; i--) {
        if (!isVisible(nodes[i])) continue;   // can't pick filtered-out nodes
        const s = toScreen(nodes[i]);
        const r = nodeRadius(nodes[i]) + 3;
        if ((px - s.x) ** 2 + (py - s.y) ** 2 <= r * r) return nodes[i];
      }
      return null;
    }

    // Filter chips: active = included, '.off' = darkened/filtered out.
    function wireChip(elId, key) {
      const el = document.getElementById(elId);
      const sync = () => el.classList.toggle('off', !filters[key]);
      sync();
      el.addEventListener('click', () => {
        filters[key] = !filters[key];
        sync();
        draw();
      });
    }
    wireChip('chipDtoEnum', 'dtoEnum');
    wireChip('chipTests', 'test');

    document.getElementById('reset').addEventListener('click', () => {
      statusEl.textContent = 'Rebuilding graph…';
      vscode.postMessage({ command: 'refresh' });
    });
    document.getElementById('recenter').addEventListener('click', () => {
      const n = focusId ? nodeById.get(focusId) : null;
      if (n) { focusOnNode(n); }       // recenter on the already-focused class
      else { vscode.postMessage({ command: 'recenter' }); }  // ask host for active file
    });

    // VSCode updates data-vscode-theme-kind / data-vscode-theme-name on body
    // whenever the user switches themes. Observe that and redraw so canvas
    // colors re-resolve from the updated CSS variables.
    new MutationObserver(() => draw()).observe(document.body, {
      attributes: true,
      attributeFilter: ['data-vscode-theme-kind', 'data-vscode-theme-name', 'class'],
    });
  </script>
</body>
</html>`;
  }
}
