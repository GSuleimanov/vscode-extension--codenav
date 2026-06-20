// Pure, VSCode-free graph model. Parses Java source text into class nodes and
// inheritance / implementation / usage edges, then resolves edges so each class
// appears exactly once (deduped by fully-qualified name) and edges only connect
// classes that actually exist in the project.

export type TypeKind = 'class' | 'interface' | 'enum';

export interface GraphNode {
  id: string;        // fully-qualified name, e.g. com.example.OrderService
  name: string;      // simple name, e.g. OrderService
  package: string;   // e.g. com.example
  uri: string;       // source file uri (string form)
  line: number;      // 0-based line of the type declaration
  kind: TypeKind;    // class | interface | enum (for filtering)
}

export type EdgeKind = 'extends' | 'implements' | 'uses';

export interface GraphEdge {
  from: string;      // FQN of source class
  to: string;        // FQN of target class
  kind: EdgeKind;
}

export interface Graph {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

// What a single parsed type declaration yields before cross-file resolution.
export interface ParsedClass {
  name: string;
  package: string;
  uri: string;
  line: number;
  kind: TypeKind;           // class | interface | enum
  extendsNames: string[];   // simple names referenced in `extends`
  implementsNames: string[]; // simple names referenced in `implements`
  fieldTypes: string[];     // simple type names used in field declarations
}

const JAVA_KEYWORDS = new Set([
  'class', 'interface', 'enum', 'extends', 'implements', 'public', 'private',
  'protected', 'static', 'final', 'abstract', 'void', 'return', 'new', 'this',
  'super', 'package', 'import', 'int', 'long', 'short', 'byte', 'boolean',
  'char', 'float', 'double', 'String', 'if', 'else', 'for', 'while', 'switch',
  'case', 'try', 'catch', 'finally', 'throw', 'throws', 'synchronized',
  'volatile', 'transient', 'native', 'default', 'do', 'break', 'continue',
]);

const BUILTIN_TYPES = new Set([
  'int', 'long', 'short', 'byte', 'boolean', 'char', 'float', 'double', 'void',
  'String', 'Object', 'Integer', 'Long', 'Short', 'Byte', 'Boolean', 'Character',
  'Float', 'Double', 'List', 'Map', 'Set', 'Collection', 'Optional',
  'ArrayList', 'HashMap', 'HashSet', 'LinkedList', 'Iterable',
]);

/** Strip line and block comments so they don't pollute parsing. */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\n]*/g, '');
}

/** Split a comma-separated type list, taking the first identifier of each generic type. */
function simpleNames(list: string): string[] {
  return list
    .split(',')
    .map(s => s.trim())
    // drop generic params, array brackets, annotations
    .map(s => s.replace(/<.*$/, '').replace(/\[.*$/, '').replace(/^@\S+\s*/, '').trim())
    // keep last segment of a dotted name (java.util.List -> List handled elsewhere)
    .map(s => s.split('.').pop() || s)
    .filter(s => /^[A-Z][A-Za-z0-9_]*$/.test(s));
}

/**
 * Parse a single Java source file. Returns one ParsedClass per top-level type
 * declaration. Inner types are ignored to keep one node per file/class.
 */
export function parseJavaSource(rawSource: string, uri: string): ParsedClass[] {
  const source = stripComments(rawSource);
  const lines = source.split('\n');

  const pkgMatch = source.match(/^\s*package\s+([\w.]+)\s*;/m);
  const pkg = pkgMatch ? pkgMatch[1] : '';

  const results: ParsedClass[] = [];

  // Find each top-level type declaration with its header (may span lines).
  const declRe = /(?:^|\s)(?:public\s+|final\s+|abstract\s+|sealed\s+|non-sealed\s+)*(class|interface|enum)\s+([A-Z][A-Za-z0-9_]*)([^{]*)\{/g;
  let m: RegExpExecArray | null;
  while ((m = declRe.exec(source)) !== null) {
    const kind = m[1] as TypeKind;
    const name = m[2];
    const header = m[3] || '';

    const line = source.slice(0, m.index).split('\n').length - 1;

    const extendsMatch = header.match(/extends\s+([^{]*?)(?:implements|$)/);
    const implementsMatch = header.match(/implements\s+([^{]*)$/);

    const extendsNames = extendsMatch ? simpleNames(extendsMatch[1]) : [];
    const implementsNames = implementsMatch ? simpleNames(implementsMatch[1]) : [];

    results.push({
      name,
      package: pkg,
      uri,
      line: line >= 0 ? line : 0,
      kind,
      extendsNames,
      implementsNames,
      fieldTypes: extractUsedTypes(name, header),
    });
  }

  return results;

  // -- helpers that close over `lines` / `source` --

  function keep(type: string, into: Set<string>) {
    if (JAVA_KEYWORDS.has(type) || BUILTIN_TYPES.has(type)) { return; }
    if (/^[A-Z][A-Za-z0-9_]*$/.test(type)) { into.add(type); }
  }

  // Scan any string for all uppercase type-like identifiers.
  function scanTypes(s: string, into: Set<string>) {
    const re = /[A-Z][A-Za-z0-9_]*/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(s)) !== null) { keep(m[0], into); }
  }

  // Collect all `uses` relationships for this class:
  //   - generic args from extends/implements header (JpaRepository<Venue, Long> → Venue)
  //   - field types + their generic args (List<Venue> → List, Venue)
  //   - constructor param types
  //   - method return types and all param types (covers ResponseEntity<Venue> etc.)
  //   - @Autowired/@Inject/@Resource setter injection
  //   - .class literals in annotation arguments
  function extractUsedTypes(className: string, header: string): string[] {
    const types = new Set<string>();

    // Generic args from the class declaration header.
    // Only scan inside <...> — the raw base/interface names are already
    // in extendsNames/implementsNames and get their own edge kinds.
    const headerGenRe = /<([^<>]*)>/g;
    let hg: RegExpExecArray | null;
    while ((hg = headerGenRe.exec(header)) !== null) { scanTypes(hg[1], types); }

    // Field declarations + generic args (e.g. `private List<Venue> venues`).
    const fieldRe = /^\s*(?:@\w+(?:\([^)]*\))?\s+)*(?:(?:private|protected|public|final|static|volatile|transient)\s+)*([A-Z][A-Za-z0-9_]*(?:<[^>]*>)?(?:\[\])?)\s+[a-z_$]\w*\s*[;=]/;
    for (const ln of lines) {
      const fm = ln.match(fieldRe);
      if (fm) { scanTypes(fm[1], types); }
    }

    // Constructor parameters.
    const ctorRe = new RegExp(`(?:public|protected|private)?\\s*${className}\\s*\\(([^)]*)\\)`, 'g');
    let cm: RegExpExecArray | null;
    while ((cm = ctorRe.exec(source)) !== null) { scanTypes(cm[1], types); }

    // Method return types + all parameter types (covers `public Venue get()`,
    // `public ResponseEntity<Venue> create(VenueCreateRequest req)`, etc.)
    const methodRe = /(?:public|protected|private)\s+(?:(?:static|final|synchronized|abstract|default)\s+)*([A-Z][A-Za-z0-9_]*(?:<[^>]*>)?(?:\[\])?)\s+[a-z_$]\w*\s*\(([^)]*)\)/g;
    let mm: RegExpExecArray | null;
    while ((mm = methodRe.exec(source)) !== null) {
      scanTypes(mm[1], types);
      scanTypes(mm[2], types);
    }

    // @Autowired / @Inject / @Resource setter injection.
    const injRe = /@(?:Autowired|Inject|Resource)\b[\s\S]{0,160}?\(([^)]*)\)/g;
    let im: RegExpExecArray | null;
    while ((im = injRe.exec(source)) !== null) { scanTypes(im[1], types); }

    // .class literals in annotations: @Import(Foo.class), @SpringBootTest(classes=Bar.class).
    const classLitRe = /([A-Z][A-Za-z0-9_]*)\.class\b/g;
    let cl: RegExpExecArray | null;
    while ((cl = classLitRe.exec(source)) !== null) { keep(cl[1], types); }

    // Method references: GomatchApplication::run — common in Spring Boot test stubs.
    const methodRefRe = /([A-Z][A-Za-z0-9_]*)::/g;
    let mr: RegExpExecArray | null;
    while ((mr = methodRefRe.exec(source)) !== null) { keep(mr[1], types); }

    return [...types];
  }
}

/**
 * Build the resolved graph from parsed classes.
 *
 * Dedup guarantee: nodes are keyed by FQN (package.Name); if the same FQN is
 * parsed twice only the first wins. Edges are resolved by simple name against
 * the set of project classes, so external/library types are dropped and every
 * edge connects two existing nodes. Duplicate edges are collapsed.
 */
export function buildGraph(parsed: ParsedClass[]): Graph {
  const nodeMap = new Map<string, GraphNode>();
  const fqn = (p: ParsedClass) => (p.package ? `${p.package}.${p.name}` : p.name);

  for (const p of parsed) {
    const id = fqn(p);
    if (!nodeMap.has(id)) {
      nodeMap.set(id, { id, name: p.name, package: p.package, uri: p.uri, line: p.line, kind: p.kind });
    }
  }

  // simple name -> candidate FQNs (for resolving unqualified references)
  const bySimple = new Map<string, string[]>();
  for (const node of nodeMap.values()) {
    const arr = bySimple.get(node.name) ?? [];
    arr.push(node.id);
    bySimple.set(node.name, arr);
  }

  // Resolve a simple name from the perspective of a source package. Prefer a
  // class in the same package, otherwise a unique match anywhere.
  function resolve(simple: string, fromPkg: string): string | undefined {
    const candidates = bySimple.get(simple);
    if (!candidates || candidates.length === 0) { return undefined; }
    if (candidates.length === 1) { return candidates[0]; }
    const samePkg = candidates.find(id => id === (fromPkg ? `${fromPkg}.${simple}` : simple));
    return samePkg ?? candidates[0];
  }

  const edgeSet = new Set<string>();
  const edges: GraphEdge[] = [];
  function addEdge(from: string, simple: string, fromPkg: string, kind: EdgeKind) {
    const to = resolve(simple, fromPkg);
    if (!to || to === from) { return; }
    const key = `${from}->${to}:${kind}`;
    if (edgeSet.has(key)) { return; }
    edgeSet.add(key);
    edges.push({ from, to, kind });
  }

  for (const p of parsed) {
    const from = fqn(p);
    for (const e of p.extendsNames) { addEdge(from, e, p.package, 'extends'); }
    for (const i of p.implementsNames) { addEdge(from, i, p.package, 'implements'); }
    for (const t of p.fieldTypes) { addEdge(from, t, p.package, 'uses'); }
  }

  return { nodes: [...nodeMap.values()], edges };
}
