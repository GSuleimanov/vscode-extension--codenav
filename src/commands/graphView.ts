import * as vscode from 'vscode';

export class GraphViewPanel {
  private static current: GraphViewPanel | undefined;
  private readonly panel: vscode.WebviewPanel;
  private readonly context: vscode.ExtensionContext;

  private constructor(panel: vscode.WebviewPanel, context: vscode.ExtensionContext) {
    this.panel = panel;
    this.context = context;

    this.panel.webview.html = this.getHtml();
    this.panel.onDidDispose(() => {
      GraphViewPanel.current = undefined;
    });

    this.panel.webview.onDidReceiveMessage(async (msg) => {
      if (msg.command === 'navigate' && msg.uri) {
        const doc = await vscode.workspace.openTextDocument(vscode.Uri.parse(msg.uri));
        await vscode.window.showTextDocument(doc, {
          selection: new vscode.Range(msg.line ?? 0, 0, msg.line ?? 0, 0),
        });
      }
    });
  }

  static createOrShow(context: vscode.ExtensionContext): void {
    if (GraphViewPanel.current) {
      GraphViewPanel.current.panel.reveal();
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      'javaNavigatorGraph',
      'Java Project Graph',
      vscode.ViewColumn.Beside,
      { enableScripts: true, retainContextWhenHidden: true }
    );

    GraphViewPanel.current = new GraphViewPanel(panel, context);
  }

  static focusCurrentFile(context: vscode.ExtensionContext): void {
    GraphViewPanel.createOrShow(context);
    const currentUri = vscode.window.activeTextEditor?.document.uri.toString();
    if (currentUri) {
      GraphViewPanel.current?.panel.webview.postMessage({
        command: 'focusNode',
        uri: currentUri,
      });
    }
  }

  private getHtml(): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Java Project Graph</title>
  <style>
    body { margin: 0; background: var(--vscode-editor-background); color: var(--vscode-editor-foreground); font-family: var(--vscode-font-family); display: flex; flex-direction: column; height: 100vh; }
    #toolbar { padding: 8px 12px; display: flex; gap: 8px; align-items: center; border-bottom: 1px solid var(--vscode-panel-border); }
    #toolbar input { flex: 1; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border); padding: 4px 8px; border-radius: 3px; }
    #cy { flex: 1; }
    #status { padding: 4px 12px; font-size: 11px; color: var(--vscode-descriptionForeground); border-top: 1px solid var(--vscode-panel-border); }
  </style>
</head>
<body>
  <div id="toolbar">
    <input id="search" type="text" placeholder="Search classes…" />
  </div>
  <div id="cy"></div>
  <div id="status">Loading project graph — indexing by Java Language Server…</div>
  <script>
    const vscode = acquireVsCodeApi();

    window.addEventListener('message', event => {
      const msg = event.data;
      if (msg.command === 'focusNode') {
        document.getElementById('status').textContent = 'Focused: ' + msg.uri;
      }
      if (msg.command === 'loadGraph') {
        document.getElementById('status').textContent =
          msg.nodes.length + ' classes loaded';
        // TODO: render with Cytoscape.js in Phase 3
      }
    });

    document.getElementById('search').addEventListener('input', e => {
      vscode.postMessage({ command: 'search', query: e.target.value });
    });
  </script>
</body>
</html>`;
  }
}
