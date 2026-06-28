// Parses a single source file using the registered tree-sitter provider.
// Reuses the existing parse cache so repeated calls for the same content are free.

import * as vscode from 'vscode';
import { ParsedType } from '../core/types';
import { providerForUri } from '../lang/registry';
import { parseCached } from '../core/cache';
import { newParser, SyntaxNode } from '../lang/treesitter';

export interface CommentRange {
  startLine: number; startCol: number; endLine: number; endCol: number;
}

export async function parseSingleFile(uri: vscode.Uri): Promise<ParsedType[]> {
  const provider = providerForUri(uri.toString());
  if (!provider) { return []; }
  await provider.init();  // no-op once the wasm grammar is loaded
  const bytes = await vscode.workspace.fs.readFile(uri);
  const text = Buffer.from(bytes).toString('utf8');
  return parseCached(uri.toString(), text, provider.parse);
}

export async function readFileText(uri: vscode.Uri): Promise<string> {
  const bytes = await vscode.workspace.fs.readFile(uri);
  return Buffer.from(bytes).toString('utf8');
}

/**
 * Tree-sitter comment-node ranges in a file, used to discard LSP references that
 * land inside a comment (a class named in a comment is not a real caller). Returns
 * [] for unsupported files. Every grammar names comments with a type containing
 * "comment" (comment / line_comment / block_comment / doc_comment).
 */
export async function commentRangesForFile(uri: vscode.Uri): Promise<CommentRange[]> {
  const provider = providerForUri(uri.toString());
  if (!provider) { return []; }
  await provider.init();
  let tree;
  try {
    const text = await readFileText(uri);
    tree = newParser(provider.id).parse(text);
  } catch { return []; }

  const out: CommentRange[] = [];
  const walk = (node: SyntaxNode) => {
    if (/comment/.test(node.type)) {
      out.push({
        startLine: node.startPosition.row, startCol: node.startPosition.column,
        endLine: node.endPosition.row, endCol: node.endPosition.column,
      });
      return;   // comments have no children worth descending into
    }
    for (const c of node.namedChildren) { walk(c); }
  };
  walk(tree.rootNode);
  return out;
}
