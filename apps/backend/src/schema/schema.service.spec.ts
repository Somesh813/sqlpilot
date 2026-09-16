import { DatabaseType } from '@sqlpilot/shared';
import { SchemaService } from './schema.service';

function table(name: string, columns: string[]) {
  return {
    name,
    schema: null,
    kind: 'table' as const,
    rowEstimate: null,
    comment: null,
    columns: columns.map((c) => ({
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
  };
}

describe('SchemaService.buildContext', () => {
  const snapshot = {
    id: 's1',
    connectionId: 'c1',
    databaseType: DatabaseType.POSTGRES,
    databaseName: 'app',
    tables: [
      table('customers', ['id', 'name', 'email']),
      table('orders', ['id', 'customer_id', 'total', 'created_at']),
      table('products', ['id', 'name', 'price']),
      table('audit_logs', ['id', 'action', 'created_at']),
    ],
    relationships: [
      { fromTable: 'orders', fromColumn: 'customer_id', toTable: 'customers', toColumn: 'id', constraintName: null },
    ],
    functions: [],
    discoveredAt: new Date().toISOString(),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  function makeService(): SchemaService {
    const service = Object.create(SchemaService.prototype) as SchemaService;
    jest.spyOn(service, 'get').mockResolvedValue(snapshot);
    return service;
  }

  it('selects tables relevant to the question plus their related tables', async () => {
    const service = makeService();
    const ctx = await service.buildContext('u1', 'c1', 'total spending per customer', 10);
    const names = ctx.tables.map((t) => t.name).sort();
    expect(names).toContain('customers');
    expect(names).toContain('orders');
    expect(names).not.toContain('audit_logs');
  });

  it('falls back to the first tables when nothing matches the question', async () => {
    const service = makeService();
    const ctx = await service.buildContext('u1', 'c1', 'xyzzy plugh', 2);
    expect(ctx.tables.length).toBeLessThanOrEqual(2);
  });

  it('caps the number of included tables and reports the rest as omitted', async () => {
    const service = makeService();
    const ctx = await service.buildContext('u1', 'c1', 'customers orders products audit', 2);
    expect(ctx.tables.length).toBeLessThanOrEqual(2);
    expect(ctx.omittedTables.length).toBeGreaterThan(0);
  });

  it('only keeps relationships between included tables', async () => {
    const service = makeService();
    const ctx = await service.buildContext('u1', 'c1', 'products price', 10);
    if (!ctx.tables.some((t) => t.name === 'orders') || !ctx.tables.some((t) => t.name === 'customers')) {
      expect(ctx.relationships).toEqual([]);
    }
  });
});
