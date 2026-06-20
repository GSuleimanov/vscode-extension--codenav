import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { expandViaTypeDefinitions, Loc, TypeExpansionExecutor } from '../expandViaType';

// ── Helpers ───────────────────────────────────────────────────────────────────

function loc(fsPath: string, line: number, character = 0): Loc {
  return {
    uri: { toString: () => `file://${fsPath}`, fsPath },
    range: { start: { line, character } },
  };
}

function executor(overrides: Partial<TypeExpansionExecutor> = {}): TypeExpansionExecutor {
  return {
    executeReferences:  async () => [],
    executeDefinitions: async () => [],
    getLineText:        async () => null,
    ...overrides,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('expandViaTypeDefinitions', () => {

  it('returns unchanged results when no type definitions exist', async () => {
    const raw = [loc('/CoachService.java', 117)];
    const result = await expandViaTypeDefinitions(
      { rawLocations: raw, typeDefLocations: [], defLocations: [], symbolName: 'repo' },
      executor()
    );
    assert.equal(result.rawLocations.length, 1);
    assert.equal(result.defLocations.length, 0);
  });

  it('merges cross-file type references into rawLocations', async () => {
    const typeDef = loc('/Repo.java', 4);
    const existing = loc('/ServiceA.java', 10);
    const crossFile = loc('/ServiceB.java', 18);

    const result = await expandViaTypeDefinitions(
      { rawLocations: [existing], typeDefLocations: [typeDef], defLocations: [], symbolName: 'repo' },
      executor({
        executeReferences: async (uri) => {
          if (uri.fsPath === '/Repo.java') { return [existing, crossFile]; }
          return [];
        },
      })
    );

    assert.equal(result.rawLocations.length, 2, 'should include existing + cross-file, no duplicate');
    assert.ok(result.rawLocations.some(l => l.uri.fsPath === '/ServiceB.java'));
  });

  it('classifies cross-file field declarations as definitions', async () => {
    const typeDef = loc('/Repo.java', 4);
    const fieldDecl = loc('/ServiceB.java', 18, 30); // col 30 = type name position

    const result = await expandViaTypeDefinitions(
      { rawLocations: [], typeDefLocations: [typeDef], defLocations: [], symbolName: 'repo' },
      executor({
        executeReferences:  async (uri) => uri.fsPath === '/Repo.java' ? [fieldDecl] : [],
        executeDefinitions: async (uri) => uri.fsPath === '/ServiceB.java' ? [typeDef] : [],
        getLineText:        async () => 'private final Repo repo;',
      })
    );

    assert.ok(result.defLocations.some(l => l.uri.fsPath === '/ServiceB.java'),
      'field declaration should be in defLocations');
  });

  it('does not classify non-declaration references as definitions', async () => {
    const typeDef = loc('/Repo.java', 4);
    const methodCall = loc('/ServiceB.java', 55);
    const someOtherDef = loc('/OtherClass.java', 10);

    const result = await expandViaTypeDefinitions(
      { rawLocations: [], typeDefLocations: [typeDef], defLocations: [], symbolName: 'repo' },
      executor({
        executeReferences:  async (uri) => uri.fsPath === '/Repo.java' ? [methodCall] : [],
        // definition does NOT point back to typeDef
        executeDefinitions: async () => [someOtherDef],
      })
    );

    assert.equal(result.defLocations.length, 0, 'method call should not be classified as definition');
  });

  it('fetches method-call usages at the variable name column, not the type name column', async () => {
    const typeDef = loc('/Repo.java', 4);
    // LSP returns fieldDecl with range.start at column 14 (where "Repo" starts)
    const fieldDecl = loc('/ServiceB.java', 18, 14);
    // Line text: "  private final Repo repo;"  → "repo" starts at index 20
    const lineText = '  private final Repo repo;';
    const repoIdx = lineText.indexOf('repo');

    let capturedCharacter: number | undefined;

    const result = await expandViaTypeDefinitions(
      { rawLocations: [], typeDefLocations: [typeDef], defLocations: [], symbolName: 'repo' },
      executor({
        executeReferences: async (uri, pos) => {
          if (uri.fsPath === '/Repo.java') { return [fieldDecl]; }
          if (uri.fsPath === '/ServiceB.java') {
            capturedCharacter = pos.character;
            return [loc('/ServiceB.java', 25)]; // method call usage
          }
          return [];
        },
        executeDefinitions: async (uri) => uri.fsPath === '/ServiceB.java' ? [typeDef] : [],
        getLineText: async () => lineText,
      })
    );

    assert.equal(capturedCharacter, repoIdx,
      'reference provider should be called at the variable name column, not the type name column');
    assert.ok(result.rawLocations.some(l => l.range.start.line === 25),
      'method call usage should appear in rawLocations');
  });

  it('deduplicates locations that appear in multiple fetches', async () => {
    const typeDef = loc('/Repo.java', 4);
    const fieldDecl = loc('/ServiceB.java', 18, 14);
    const usage = loc('/ServiceB.java', 25);

    const result = await expandViaTypeDefinitions(
      { rawLocations: [usage], typeDefLocations: [typeDef], defLocations: [], symbolName: 'repo' },
      executor({
        executeReferences: async (uri) => {
          if (uri.fsPath === '/Repo.java') { return [fieldDecl]; }
          if (uri.fsPath === '/ServiceB.java') { return [usage, loc('/ServiceB.java', 30)]; }
          return [];
        },
        executeDefinitions: async (uri) => uri.fsPath === '/ServiceB.java' ? [typeDef] : [],
        getLineText: async () => 'private final Repo repo;',
      })
    );

    const lines = result.rawLocations.map(l => l.range.start.line);
    const unique = new Set(lines);
    assert.equal(lines.length, unique.size, 'no duplicate locations');
  });

  it('skips field-level ref fetch when symbolName is not found on the declaration line', async () => {
    const typeDef = loc('/Repo.java', 4);
    const fieldDecl = loc('/ServiceB.java', 18, 14);
    let fieldRefCalled = false;

    await expandViaTypeDefinitions(
      { rawLocations: [], typeDefLocations: [typeDef], defLocations: [], symbolName: 'differentName' },
      executor({
        executeReferences: async (uri, pos) => {
          if (uri.fsPath === '/Repo.java') { return [fieldDecl]; }
          if (uri.fsPath === '/ServiceB.java') { fieldRefCalled = true; return []; }
          return [];
        },
        executeDefinitions: async (uri) => uri.fsPath === '/ServiceB.java' ? [typeDef] : [],
        getLineText: async () => 'private final Repo repo;', // "differentName" not in line
      })
    );

    assert.equal(fieldRefCalled, false, 'should not call reference provider when variable name not found');
  });

});
