import * as vscode from 'vscode';
import { getConfig } from '../util/javaUtils';

export async function findEventHandlers(): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document.languageId !== 'java') {
    return;
  }

  const { document, selection } = editor;
  const position = selection.active;
  const wordRange = document.getWordRangeAtPosition(position);
  const eventClassName = wordRange ? document.getText(wordRange) : '';

  if (!eventClassName) {
    vscode.window.showWarningMessage('Java Navigator: Place cursor on an event class name.');
    return;
  }

  const handlers = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Window, title: `Finding handlers for ${eventClassName}…` },
    () => discoverHandlers(document.uri, position, eventClassName)
  );

  if (handlers.length === 0) {
    vscode.window.showInformationMessage(
      `Java Navigator: No event handlers found for ${eventClassName}.`
    );
    return;
  }

  await vscode.commands.executeCommand(
    'editor.action.peekLocations',
    document.uri,
    position,
    handlers,
    'peek'
  );
}

async function discoverHandlers(
  uri: vscode.Uri,
  position: vscode.Position,
  eventClassName: string
): Promise<vscode.Location[]> {
  const locations: vscode.Location[] = [];

  // ApplicationListener<EventClass> implementors via LSP
  try {
    const implLocs = await vscode.commands.executeCommand<vscode.Location[]>(
      'vscode.executeImplementationProvider',
      uri,
      position
    );
    if (implLocs) {
      locations.push(...implLocs);
    }
  } catch {
    // implementation provider unavailable — continue
  }

  // Annotation-based handlers via text search
  const annotations: string[] = getConfig().get('listenerAnnotations') ?? ['@EventListener'];
  const annotationRegex = new RegExp(
    `(${annotations.map(a => a.replace('@', '\\@')).join('|')})[\\s\\S]{0,300}${eventClassName}`
  );

  try {
    const javaFiles = await vscode.workspace.findFiles('**/*.java', '**/test/**');
    for (const fileUri of javaFiles) {
      const doc = await vscode.workspace.openTextDocument(fileUri);
      const text = doc.getText();
      let match: RegExpExecArray | null;
      const re = new RegExp(annotationRegex.source, 'g');
      while ((match = re.exec(text)) !== null) {
        const pos = doc.positionAt(match.index);
        locations.push(new vscode.Location(fileUri, pos));
      }
    }
  } catch {
    // text search unavailable — continue
  }

  return dedup(locations);
}

function dedup(locations: vscode.Location[]): vscode.Location[] {
  const seen = new Set<string>();
  return locations.filter(loc => {
    const key = `${loc.uri.fsPath}:${loc.range.start.line}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}
