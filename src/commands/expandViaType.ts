// Pure expansion logic — injectable executor makes this unit-testable without VSCode.

export interface Loc {
  uri: { toString(): string; fsPath: string };
  range: { start: { line: number; character: number } };
}

export interface TypeExpansionExecutor {
  executeReferences(uri: Loc['uri'], pos: { line: number; character: number }): Promise<Loc[]>;
  executeDefinitions(uri: Loc['uri'], pos: { line: number; character: number }): Promise<Loc[]>;
  getLineText(uri: Loc['uri'], line: number): Promise<string | null>;
}

export interface TypeExpansionInput {
  rawLocations: Loc[];
  typeDefLocations: Loc[];
  defLocations: Loc[];
  symbolName: string;
}

export interface TypeExpansionResult {
  rawLocations: Loc[];
  defLocations: Loc[];
}

/**
 * Expands a reference search by following the type definition of a symbol:
 * 1. Fetches all cross-file locations that reference the type (field declarations in other classes)
 * 2. Classifies each: if its own definition points back to the type → it's a field declaration
 * 3. For each confirmed field declaration, fetches method-call usages at the variable name position
 *
 * This ensures that invoking on an instance variable shows the same cross-file usages
 * as invoking on the type name directly.
 */
export async function expandViaTypeDefinitions(
  input: TypeExpansionInput,
  executor: TypeExpansionExecutor
): Promise<TypeExpansionResult> {
  const { symbolName, typeDefLocations } = input;
  const rawLocations = [...input.rawLocations];
  const defLocations = [...input.defLocations];

  if (typeDefLocations.length === 0) { return { rawLocations, defLocations }; }

  const typeDefKeys = new Set(
    typeDefLocations.map(l => `${l.uri.fsPath}:${l.range.start.line}`)
  );

  // Step 1: find all cross-file type references
  const typeRefResults = await Promise.all(
    typeDefLocations.map(loc =>
      executor.executeReferences(loc.uri, loc.range.start).catch(() => [])
    )
  );

  const seen = new Set(rawLocations.map(l => `${l.uri.toString()}:${l.range.start.line}`));
  const newLocs: Loc[] = [];
  for (const locs of typeRefResults) {
    for (const loc of locs) {
      const key = `${loc.uri.toString()}:${loc.range.start.line}`;
      if (!seen.has(key)) { seen.add(key); rawLocations.push(loc); newLocs.push(loc); }
    }
  }

  // Step 2: classify new locations — field declaration if definition points back to the type
  const classified = await Promise.all(
    newLocs.map(async loc => {
      const defs = await executor.executeDefinitions(loc.uri, loc.range.start).catch(() => []);
      const isFieldDecl = defs.some(d => typeDefKeys.has(`${d.uri.fsPath}:${d.range.start.line}`));
      return { loc, isFieldDecl };
    })
  );

  const fieldDecls: Loc[] = [];
  for (const { loc, isFieldDecl } of classified) {
    if (isFieldDecl) { defLocations.push(loc); fieldDecls.push(loc); }
  }

  // Step 3: fetch method-call usages on each field declaration.
  // The type-ref location points at the type name in the declaration; we need
  // the variable name column, so we search for symbolName on that line.
  const fieldRefResults = await Promise.all(
    fieldDecls.map(async loc => {
      const lineText = await executor.getLineText(loc.uri, loc.range.start.line).catch(() => null);
      if (!lineText) { return []; }
      const varIdx = lineText.indexOf(symbolName);
      if (varIdx < 0) { return []; }
      return executor.executeReferences(loc.uri, { line: loc.range.start.line, character: varIdx }).catch(() => []);
    })
  );

  for (const locs of fieldRefResults) {
    for (const loc of locs) {
      const key = `${loc.uri.toString()}:${loc.range.start.line}`;
      if (!seen.has(key)) { seen.add(key); rawLocations.push(loc); }
    }
  }

  return { rawLocations, defLocations };
}
