import * as vscode from 'vscode';
import { createPeekFilteredCommand } from './commands/filteredPeek';
import { findEventHandlers } from './commands/eventHandlerDiscovery';
import { GraphViewPanel } from './commands/graphView';
import { ReferencesSideView } from './views/referencesSideView';

export function activate(context: vscode.ExtensionContext): void {
  const referencesView = new ReferencesSideView(context);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      ReferencesSideView.viewId,
      referencesView,
      { webviewOptions: { retainContextWhenHidden: true } }
    ),
    vscode.commands.registerCommand('javaNavigator.peekFiltered', createPeekFilteredCommand(referencesView)),
    vscode.commands.registerCommand('javaNavigator.findEventHandlers', findEventHandlers),
    vscode.commands.registerCommand('javaNavigator.openGraph', () =>
      GraphViewPanel.createOrShow(context)
    ),
    vscode.commands.registerCommand('javaNavigator.focusGraph', () =>
      GraphViewPanel.focusCurrentFile(context)
    )
  );
}

export function deactivate(): void {}
