import * as vscode from 'vscode';

export function getConfig() {
  return vscode.workspace.getConfiguration('javaNavigator');
}

export function isTestLocation(loc: vscode.Location): boolean {
  const fsPath = loc.uri.fsPath;
  const cfg = getConfig();
  const testRoots: string[] = cfg.get('testSourceRoots') ?? ['src/test/', 'src/it/'];
  const testSuffixes: string[] = cfg.get('testFilePatterns') ?? ['Test.java', 'Tests.java', 'TestCase.java'];

  if (testRoots.some(root => fsPath.includes(root))) {
    return true;
  }
  return testSuffixes.some(suffix => fsPath.endsWith(suffix));
}

export async function isImportLocation(loc: vscode.Location): Promise<boolean> {
  try {
    const doc = await vscode.workspace.openTextDocument(loc.uri);
    const lineText = doc.lineAt(loc.range.start.line).text.trimStart();
    return lineText.startsWith('import ');
  } catch {
    return false;
  }
}

export async function filterLocations(
  locations: vscode.Location[],
  filterTests: boolean,
  filterImports: boolean
): Promise<vscode.Location[]> {
  const results: vscode.Location[] = [];

  for (const loc of locations) {
    if (filterTests && isTestLocation(loc)) {
      continue;
    }
    if (filterImports && (await isImportLocation(loc))) {
      continue;
    }
    results.push(loc);
  }

  return results;
}
