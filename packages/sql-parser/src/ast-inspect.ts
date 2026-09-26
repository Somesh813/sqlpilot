import { isDangerousFunction, normalizeFunctionName } from './policy';

/**
 * Statement node types that must never appear anywhere in an AST except (in write mode) at
 * the root. node-sql-parser emits these lower-case; `ORDER BY ... DESC` uses upper-case
 * `type: 'DESC'`, so the exact-case match below does not collide with it.
 */
const STATEMENT_TYPES = new Set([
  'insert', 'update', 'delete', 'replace', 'create', 'alter', 'drop', 'truncate', 'rename',
  'grant', 'revoke', 'call', 'exec', 'execute', 'transaction', 'lock', 'unlock', 'show',
  'explain', 'analyze', 'load_data', 'copy', 'merge', 'prepare', 'deallocate', 'use', 'set',
]);

export interface AstFacts {
  /** `type` of each root statement. */
  rootTypes: string[];
  /** Statement-typed nodes found below the root (data-modifying CTEs, nested DML, ...). */
  nestedStatements: string[];
  /** Normalised names of every function call. */
  functions: string[];
  dangerousFunctions: string[];
  /** A SELECT ... INTO (table / variable / OUTFILE / DUMPFILE). */
  hasInto: boolean;
  /** FOR UPDATE / FOR SHARE and friends. */
  hasLocking: boolean;
  cteNames: string[];
  topLevelLimit: number | null;
}

type Node = Record<string, unknown>;
const isNode = (v: unknown): v is Node => typeof v === 'object' && v !== null;

const MAX_DEPTH = 400;
const MAX_NODES = 200_000;

export function inspectAst(roots: unknown[]): AstFacts {
  const facts: AstFacts = {
    rootTypes: [],
    nestedStatements: [],
    functions: [],
    dangerousFunctions: [],
    hasInto: false,
    hasLocking: false,
    cteNames: [],
    topLevelLimit: null,
  };
  const functions = new Set<string>();
  let visited = 0;

  const visit = (value: unknown, depth: number, isRoot: boolean): void => {
    if (depth > MAX_DEPTH) throw new Error('AST too deep');
    if (Array.isArray(value)) {
      for (const item of value) visit(item, depth + 1, false);
      return;
    }
    if (!isNode(value)) return;
    if (++visited > MAX_NODES) throw new Error('AST too large');

    const type = typeof value.type === 'string' ? value.type : undefined;

    if (type && STATEMENT_TYPES.has(type) && !isRoot) facts.nestedStatements.push(type);

    if (type === 'function' || type === 'aggr_func' || type === 'window_func') {
      const name = normalizeFunctionName(value.name);
      if (name) functions.add(name);
    }

    if (type === 'select') {
      const into = value.into;
      if (isNode(into) && (into.type === 'into' || into.expr != null || into.position != null || into.keyword != null)) {
        facts.hasInto = true;
      }
      if (value.locking_read) facts.hasLocking = true;
    }

    // WITH x AS (...): record the alias so callers can tell CTEs from real tables.
    if (Array.isArray(value.with)) {
      for (const cte of value.with as Node[]) {
        const nm = isNode(cte?.name) ? (cte.name as Node).value : undefined;
        if (typeof nm === 'string') facts.cteNames.push(nm.toLowerCase());
      }
    }

    for (const key of Object.keys(value)) visit(value[key], depth + 1, false);
  };

  for (const root of roots) {
    if (isNode(root) && typeof root.type === 'string') facts.rootTypes.push(root.type);
    visit(root, 0, true);
  }

  facts.functions = [...functions].sort();
  facts.dangerousFunctions = facts.functions.filter(isDangerousFunction);
  facts.topLevelLimit = roots.length === 1 ? readLimit(roots[0]) : null;
  return facts;
}

function readLimit(root: unknown): number | null {
  if (!isNode(root)) return null;
  // UNION chains keep their LIMIT on the last member.
  let node: Node = root;
  while (isNode(node._next)) node = node._next as Node;
  const limit = node.limit;
  if (!isNode(limit) || !Array.isArray(limit.value) || limit.value.length === 0) return null;
  const values = limit.value as Node[];
  // `LIMIT n OFFSET m` -> value[0] is n; MySQL `LIMIT m, n` -> value[1] is n.
  const pick = limit.seperator === ',' && values.length > 1 ? values[1] : values[0];
  const n = isNode(pick) && pick.type === 'number' ? Number(pick.value) : NaN;
  return Number.isFinite(n) ? n : null;
}
