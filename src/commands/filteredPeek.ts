import * as vscode from 'vscode';
import { ReferencesSideView, PanelInput } from '../views/referencesSideView';
import { expandViaTypeDefinitions, TypeExpansionExecutor } from './expandViaType';

export function createPeekFilteredCommand(
  view: ReferencesSideView,
  onFocusClass?: (uri: vscode.Uri) => void
) {
  return async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.languageId !== 'java') { return; }

    const { document, selection } = editor;

    // Center the project graph (if open) on the class being peeked.
    onFocusClass?.(document.uri);
    const position = selection.active;
    const wordRange = document.getWordRangeAtPosition(position);
    const symbolName = wordRange ? document.getText(wordRange) : 'symbol';

    let rawLocations: vscode.Location[] | undefined;
    let typeDefLocations: vscode.Location[] = [];
    let defLocations: vscode.Location[] = [];
    let implLocations: vscode.Location[] = [];

    try {
      [rawLocations, typeDefLocations, defLocations, implLocations] = await Promise.all([
        vscode.commands.executeCommand<vscode.Location[]>(
          'vscode.executeReferenceProvider', document.uri, position
        ),
        Promise.resolve(vscode.commands.executeCommand<vscode.Location[]>(
          'vscode.executeTypeDefinitionProvider', document.uri, position
        )).then(r => r ?? []).catch(() => []),
        Promise.resolve(vscode.commands.executeCommand<vscode.Location[]>(
          'vscode.executeDefinitionProvider', document.uri, position
        )).then(r => r ?? []).catch(() => []),
        Promise.resolve(vscode.commands.executeCommand<vscode.Location[]>(
          'vscode.executeImplementationProvider', document.uri, position
        )).then(r => r ?? []).catch(() => []),
      ]);
    } catch {
      vscode.window.showErrorMessage(
        'Java Navigator: Java Language Server is required but not available.'
      );
      return;
    }

    if (!rawLocations || rawLocations.length === 0) {
      vscode.window.showInformationMessage('Java Navigator: No references found.');
      return;
    }

    const executor: TypeExpansionExecutor = {
      executeReferences: (uri, pos) =>
        Promise.resolve(vscode.commands.executeCommand<vscode.Location[]>(
          'vscode.executeReferenceProvider', uri, new vscode.Position(pos.line, pos.character)
        )).then(r => r ?? []).catch(() => []),
      executeDefinitions: (uri, pos) =>
        Promise.resolve(vscode.commands.executeCommand<vscode.Location[]>(
          'vscode.executeDefinitionProvider', uri, new vscode.Position(pos.line, pos.character)
        )).then(r => r ?? []).catch(() => []),
      getLineText: async (uri, line) => {
        const doc = await vscode.workspace.openTextDocument(uri as vscode.Uri);
        return doc.lineAt(line).text;
      },
    };

    const expanded = await expandViaTypeDefinitions(
      { rawLocations: rawLocations as vscode.Location[], typeDefLocations, defLocations, symbolName },
      executor
    );
    rawLocations = expanded.rawLocations as vscode.Location[];
    defLocations = expanded.defLocations as vscode.Location[];

    const input: PanelInput = {
      symbolName,
      originUri: document.uri,
      originPosition: position,
      rawLocations,
      typeDefLocations,
      defLocations,
      implLocations,
    };
    await view.show(input);
  };
}
