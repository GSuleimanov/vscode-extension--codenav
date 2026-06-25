import * as vscode from 'vscode';
import { createPeekFilteredCommand } from './commands/filteredPeek';
import { GraphSideView } from './commands/graphView';
import { ReferencesSideView } from './views/referencesSideView';

export function activate(context: vscode.ExtensionContext): void {
  const referencesView = new ReferencesSideView(context);
  const graphView = new GraphSideView(context);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      ReferencesSideView.viewId,
      referencesView,
      { webviewOptions: { retainContextWhenHidden: true } }
    ),
    vscode.commands.registerCommand(
      'codenav.findReferences',
      createPeekFilteredCommand(referencesView, (uri) => graphView.focusUri(uri.toString()))
    ),
    vscode.commands.registerCommand('codenav.openGraph', () => graphView.reveal())
  );

  void signalJavaReadiness(referencesView, graphView);
}

async function signalJavaReadiness(view: ReferencesSideView, graphView: GraphSideView): Promise<void> {
  const ext = vscode.extensions.getExtension('redhat.java');
  if (!ext) {
    // No Java extension — mark both views ready immediately so they don't stay in loading state.
    view.setJavaReady(true);
    graphView.setJavaReady(true);
    return;
  }

  await vscode.window.withProgress(
    { location: { viewId: ReferencesSideView.viewId }, title: 'Java language server starting…' },
    async () => {
      try {
        if (!ext.isActive) { await ext.activate(); }
        const api = ext.exports as { serverReady?: () => Promise<boolean> } | undefined;
        if (api?.serverReady) { await api.serverReady(); }
        view.setJavaReady(true);
        graphView.setJavaReady(true);
      } catch {
        /* leave idle screens showing "starting" if readiness can't be determined */
      }
    }
  );
}

export function deactivate(): void {}
