import type { RelationshipSchema, TableSchema } from './models';

/**
 * Chooses which tables to show the model. Pure and deterministic so it can be tested.
 *
 *  1. Small schemas are sent whole: nothing can be missing.
 *  2. Otherwise tables are scored by meaning (names, columns, comments, light stemming and a
 *     few business synonyms), giving "seed" tables.
 *  3. Seeds are connected through the foreign-key graph: every pair of seeds is joined by its
 *     shortest path, so intermediate tables (customers -> orders -> order_items -> products)
 *     are included regardless of the order the tables were discovered in.
 *  4. Remaining budget goes to neighbours by distance from the seeds (a lone seed still
 *     brings in the tables that hold the numbers you would aggregate).
 *
 * Priority when the budget is tight: seeds > bridge tables > neighbours > fallback.
 */

export interface SchemaSelectOptions {
  maxTables: number;
  /** At or below this many tables, everything is sent. Defaults to maxTables. */
  sendAllAtOrBelow?: number;
  /** Longest FK path used to bridge two seed tables. */
  maxBridgeHops?: number;
  /** How far past the seeds to look for neighbours. */
  neighbourDepth?: number;
}

export interface SchemaSelection {
  tables: string[];
  seeds: string[];
  bridges: string[];
  omitted: string[];
  reason: 'all-tables' | 'relevance' | 'fallback';
}

const STOP_WORDS = new Set([
  'the', 'and', 'for', 'with', 'this', 'that', 'from', 'show', 'find', 'list', 'get', 'all', 'how', 'many',
  'much', 'what', 'which', 'who', 'top', 'per', 'each', 'give', 'last', 'first', 'total', 'count', 'sum',
  'average', 'avg', 'group', 'order', 'sort', 'between', 'over', 'under', 'only', 'those', 'them', 'these',
  'did', 'does', 'was', 'were', 'have', 'has', 'our', 'their', 'you', 'your', 'are', 'not', 'any', 'more',
  'less', 'than', 'then', 'now', 'same', 'data', 'new', 'month', 'year', 'week', 'day', 'this', 'compare',
]);

/** Business words that rarely appear as identifiers -> words that do. */
const SYNONYMS: Record<string, string[]> = {
  revenue: ['amount', 'price', 'total', 'sales', 'payment', 'revenue', 'cost'],
  sales: ['amount', 'price', 'total', 'order', 'revenue'],
  spending: ['amount', 'total', 'payment', 'price'],
  spend: ['amount', 'total', 'payment', 'price'],
  spent: ['amount', 'total', 'payment', 'price'],
  income: ['amount', 'total', 'payment', 'revenue'],
  purchase: ['order', 'sale', 'invoice'],
  purchases: ['order', 'sale', 'invoice'],
  client: ['customer', 'user', 'account'],
  clients: ['customer', 'user', 'account'],
  buyer: ['customer', 'user'],
  buyers: ['customer', 'user'],
  employee: ['staff', 'employee', 'worker'],
  staff: ['employee'],
  item: ['product', 'item', 'sku'],
  items: ['product', 'item', 'sku'],
  city: ['city', 'address', 'location'],
  location: ['city', 'address', 'country', 'region'],
  product: ['product', 'item', 'sku'],
  stock: ['inventory', 'stock', 'quantity'],
};

export function stem(word: string): string {
  let w = word.toLowerCase();
  if (w.length > 4 && w.endsWith('ies')) return `${w.slice(0, -3)}y`;
  if (w.length > 4 && /(sses|shes|ches|xes)$/.test(w)) return w.slice(0, -2);
  if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) w = w.slice(0, -1);
  return w;
}

/** Splits identifiers like OrderItems / order_items / orderItems into stemmed words. */
export function identifierWords(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .map(stem);
}

export function questionTerms(question: string): string[] {
  const out = new Set<string>();
  for (const raw of question.toLowerCase().replace(/[^a-z0-9_\s]/g, ' ').split(/\s+/)) {
    if (raw.length < 3 || STOP_WORDS.has(raw)) continue;
    out.add(stem(raw));
    for (const syn of SYNONYMS[raw] ?? SYNONYMS[stem(raw)] ?? []) out.add(stem(syn));
  }
  return [...out];
}

function scoreTable(table: TableSchema, terms: string[]): number {
  const nameWords = new Set(identifierWords(table.name));
  const columnWords = new Set(table.columns.flatMap((c) => identifierWords(c.name)));
  const commentWords = new Set(
    [table.comment ?? '', ...table.columns.map((c) => c.comment ?? '')].flatMap((t) => identifierWords(t)),
  );
  let score = 0;
  for (const term of terms) {
    if (nameWords.has(term)) score += 6;
    else if (columnWords.has(term)) score += 2;
    else if (commentWords.has(term)) score += 1;
  }
  return score;
}

type Graph = Map<string, Set<string>>;

function buildGraph(tables: TableSchema[], relationships: RelationshipSchema[]): Graph {
  const known = new Set(tables.map((t) => t.name));
  const g: Graph = new Map(tables.map((t) => [t.name, new Set<string>()]));
  for (const r of relationships) {
    if (!known.has(r.fromTable) || !known.has(r.toTable) || r.fromTable === r.toTable) continue;
    g.get(r.fromTable)!.add(r.toTable);
    g.get(r.toTable)!.add(r.fromTable);
  }
  return g;
}

/** Shortest path (inclusive of both ends) or null. Neighbours are visited in sorted order for determinism. */
function shortestPath(g: Graph, from: string, to: string, maxHops: number): string[] | null {
  if (from === to) return [from];
  const prev = new Map<string, string>();
  const seen = new Set([from]);
  let frontier = [from];
  for (let depth = 0; depth < maxHops && frontier.length; depth++) {
    const next: string[] = [];
    for (const node of frontier) {
      for (const nb of [...(g.get(node) ?? [])].sort()) {
        if (seen.has(nb)) continue;
        seen.add(nb);
        prev.set(nb, node);
        if (nb === to) {
          const path = [to];
          while (path[0] !== from) path.unshift(prev.get(path[0])!);
          return path;
        }
        next.push(nb);
      }
    }
    frontier = next;
  }
  return null;
}

export function selectSchemaTables(
  tables: TableSchema[],
  relationships: RelationshipSchema[],
  question: string,
  options: SchemaSelectOptions,
): SchemaSelection {
  const { maxTables } = options;
  const sendAll = options.sendAllAtOrBelow ?? maxTables;
  const names = tables.map((t) => t.name);

  if (tables.length <= sendAll) {
    return { tables: names, seeds: [], bridges: [], omitted: [], reason: 'all-tables' };
  }

  const g = buildGraph(tables, relationships);
  const terms = questionTerms(question);
  const scored = tables
    .map((t) => ({ name: t.name, score: scoreTable(t, terms) }))
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));

  const chosen: string[] = [];
  const add = (name: string) => {
    if (chosen.length < maxTables && !chosen.includes(name)) chosen.push(name);
  };

  if (scored.length === 0) {
    // Nothing matched: show the best-connected tables, which are usually the core entities.
    const byDegree = [...names].sort((a, b) => (g.get(b)?.size ?? 0) - (g.get(a)?.size ?? 0) || a.localeCompare(b));
    byDegree.slice(0, maxTables).forEach(add);
    return { tables: chosen, seeds: [], bridges: [], omitted: names.filter((n) => !chosen.includes(n)), reason: 'fallback' };
  }

  // Seeds: strong matches. Keep the budget for bridges and neighbours.
  const seedBudget = Math.max(2, Math.ceil(maxTables / 2));
  const seeds = scored.slice(0, seedBudget).map((s) => s.name);

  // Bridges: shortest FK path between every pair of seeds (order independent).
  const maxHops = options.maxBridgeHops ?? 4;
  const bridgeSet = new Set<string>();
  for (let i = 0; i < seeds.length; i++) {
    for (let j = i + 1; j < seeds.length; j++) {
      const path = shortestPath(g, seeds[i], seeds[j], maxHops);
      path?.slice(1, -1).forEach((n) => bridgeSet.add(n));
    }
  }
  const bridges = [...bridgeSet].filter((n) => !seeds.includes(n)).sort();

  seeds.forEach(add);
  bridges.forEach(add);

  // Neighbours by distance from any seed, nearest first.
  const depthLimit = options.neighbourDepth ?? 2;
  let frontier = [...seeds, ...bridges];
  const seen = new Set(frontier);
  for (let depth = 1; depth <= depthLimit && frontier.length; depth++) {
    const next: string[] = [];
    for (const node of frontier) {
      for (const nb of [...(g.get(node) ?? [])].sort()) {
        if (seen.has(nb)) continue;
        seen.add(nb);
        next.push(nb);
      }
    }
    // within a ring, tables with more foreign keys (fact/link tables) first
    next.sort((a, b) => (g.get(b)?.size ?? 0) - (g.get(a)?.size ?? 0) || a.localeCompare(b));
    next.forEach(add);
    frontier = next;
  }

  return {
    tables: chosen,
    seeds,
    bridges,
    omitted: names.filter((n) => !chosen.includes(n)),
    reason: 'relevance',
  };
}
