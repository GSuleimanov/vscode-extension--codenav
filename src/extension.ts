import * as vscode from 'vscode';
import { createPeekFilteredCommand } from './commands/filteredPeek';
import { findEventHandlers } from './commands/eventHandlerDiscovery';
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
    vscode.window.registerWebviewViewProvider(
      GraphSideView.viewId,
      graphView,
      { webviewOptions: { retainContextWhenHidden: true } }
    ),
    vscode.commands.registerCommand(
      'javaNavigator.peekFiltered',
      createPeekFilteredCommand(referencesView, (uri) => graphView.focusUri(uri.toString()))
    ),
    vscode.commands.registerCommand('javaNavigator.findEventHandlers', findEventHandlers),
    vscode.commands.registerCommand('javaNavigator.openGraph', () => graphView.reveal()),
    vscode.commands.registerCommand('javaNavigator.focusGraph', () => graphView.revealAndFocus())
  );
}

export function deactivate(): void {}
