import type { RelationshipSchema, TableSchema } from './models';
import { identifierWords, questionTerms, selectSchemaTables, stem } from './schema-select';

const table = (name: string, cols: string[], comment: string | null = null): TableSchema => ({
  name,
  schema: null,
  kind: 'table',
  rowEstimate: null,
  comment,
  columns: cols.map((c) => ({
    name: c,
    dataType: 'text',
    nullable: true,
    defaultValue: null,
    isPrimaryKey: c === 'id',
    isForeignKey: false,
    references: null,
    comment: null,
  })),
  indexes: [],
});
const fk = (fromTable: string, fromColumn: string, toTable: string): RelationshipSchema => ({
  fromTable,
  fromColumn,
  toTable,
  toColumn: 'id',
  constraintName: null,
});

const core: TableSchema[] = [
  table('customers', ['id', 'name', 'city', 'email']),
  table('orders', ['id', 'customer_id', 'status', 'created_at']),
  table('order_items', ['id', 'order_id', 'product_id', 'quantity', 'amount_inr']),
  table('products', ['id', 'name', 'price', 'category_id']),
  table('categories', ['id', 'title']),
];
const coreRels = [
  fk('orders', 'customer_id', 'customers'),
  fk('order_items', 'order_id', 'orders'),
  fk('order_items', 'product_id', 'products'),
  fk('products', 'category_id', 'categories'),
];
// unrelated tables, each linked to the previous one so the graph is not trivially disconnected
const noise: TableSchema[] = Array.from({ length: 30 }, (_, i) => table(`sys_log_${i}`, ['id', 'payload', 'level']));
const noiseRels = noise.slice(1).map((t, i) => fk(t.name, 'prev_id', noise[i].name));
const big = [...core, ...noise];
const bigRels = [...coreRels, ...noiseRels];

const opts = { maxTables: 8 };

describe('selectSchemaTables', () => {
  it('sends the complete schema when it is small', () => {
    const r = selectSchemaTables(core, coreRels, 'anything at all', { maxTables: 25 });
    expect(r.reason).toBe('all-tables');
    expect(r.tables.sort()).toEqual(core.map((t) => t.name).sort());
    expect(r.omitted).toEqual([]);
  });

  it('a lone seed still pulls in the table holding the numbers (the F8 bug: order_items was omitted)', () => {
    const r = selectSchemaTables(big, bigRels, 'Total revenue for customers in Mumbai', opts);
    expect(r.tables).toEqual(expect.arrayContaining(['customers', 'orders', 'order_items']));
  });

  it('bridges multiple hops: customers -> orders -> order_items -> products', () => {
    const r = selectSchemaTables(big, bigRels, 'Which customers bought which products?', opts);
    expect(r.tables).toEqual(expect.arrayContaining(['customers', 'orders', 'order_items', 'products']));
  });

  it('adds intermediate tables the question never mentions', () => {
    const r = selectSchemaTables(big, bigRels, 'customers by category title', opts);
    expect(r.tables).toEqual(expect.arrayContaining(['customers', 'orders', 'order_items', 'products', 'categories']));
    expect(r.bridges).toContain('order_items'); // reached only through the graph
  });

  it('bridges a long chain across five tables', () => {
    const r = selectSchemaTables(big, bigRels, 'customers by product category', opts);
    expect(r.tables).toEqual(expect.arrayContaining(['customers', 'orders', 'order_items', 'products', 'categories']));
  });

  it('is independent of table and relationship discovery order', () => {
    const q = 'Which customers bought which products?';
    const a = selectSchemaTables(big, bigRels, q, opts);
    const b = selectSchemaTables([...big].reverse(), [...bigRels].reverse(), q, opts);
    expect([...b.tables].sort()).toEqual([...a.tables].sort());
  });

  it('does not fill the budget with unrelated tables ahead of related ones', () => {
    const r = selectSchemaTables(big, bigRels, 'How many customers are there?', opts);
    expect(r.tables.slice(0, 3)).toContain('customers');
    expect(r.tables.filter((t) => t.startsWith('sys_log')).length).toBe(0);
  });

  it('never exceeds maxTables and reports what it left out', () => {
    const r = selectSchemaTables(big, bigRels, 'customers orders products categories order items', { maxTables: 4 });
    expect(r.tables.length).toBeLessThanOrEqual(4);
    expect(r.omitted.length).toBe(big.length - r.tables.length);
  });

  it('matches table comments (descriptions)', () => {
    const tables = [...big.filter((t) => t.name !== 'sys_log_3'), table('sys_log_3', ['id'], 'Refund requests raised by shoppers')];
    const r = selectSchemaTables(tables, bigRels, 'show refund requests', opts);
    expect(r.tables).toContain('sys_log_3');
  });

  it('falls back to the best-connected tables when nothing matches', () => {
    const r = selectSchemaTables(big, bigRels, 'zzqx wibble', opts);
    expect(r.reason).toBe('fallback');
    expect(r.tables.length).toBeLessThanOrEqual(8);
    expect(r.tables.length).toBeGreaterThan(0);
  });

  it('copes with a disconnected graph and views without foreign keys', () => {
    const r = selectSchemaTables(big, [], 'customers and products', opts);
    expect(r.tables).toEqual(expect.arrayContaining(['customers', 'products']));
  });

  it('handles CamelCase and plural identifiers', () => {
    const tables = [...noise, table('OrderItems', ['Id', 'OrderId', 'UnitPrice']), table('Customer', ['Id', 'FullName'])];
    const r = selectSchemaTables(tables, [], 'list customers and order items', opts);
    expect(r.tables).toEqual(expect.arrayContaining(['Customer', 'OrderItems']));
  });
});

describe('helpers', () => {
  it('stems plurals', () => {
    expect(stem('customers')).toBe('customer');
    expect(stem('categories')).toBe('category');
    expect(stem('address')).toBe('address');
    expect(stem('boxes')).toBe('box');
  });
  it('splits identifiers', () => {
    expect(identifierWords('order_items')).toEqual(['order', 'item']);
    expect(identifierWords('OrderItems')).toEqual(['order', 'item']);
  });
  it('expands business synonyms', () => {
    expect(questionTerms('total revenue')).toEqual(expect.arrayContaining(['amount', 'price']));
  });
});
