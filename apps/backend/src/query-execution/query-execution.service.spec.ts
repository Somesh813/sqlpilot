import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DatabaseType, QueryStatus } from '@sqlpilot/shared';
import { QueryExecutionService } from './query-execution.service';

jest.mock('@sqlpilot/database', () => ({
  withDriver: jest.fn(),
}));
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { withDriver } = jest.requireMock('@sqlpilot/database') as { withDriver: jest.Mock };

describe('QueryExecutionService', () => {
  const connection = {
    id: 'conn1',
    name: 'Test DB',
    type: DatabaseType.POSTGRES,
    writeEnabled: false,
  };

  let connections: { get: jest.Mock; resolveDriverConfig: jest.Mock };
  let history: { record: jest.Mock };
  let audit: { record: jest.Mock };
  let config: ConfigService;
  let service: QueryExecutionService;

  beforeEach(() => {
    jest.clearAllMocks();
    connections = {
      get: jest.fn().mockResolvedValue(connection),
      resolveDriverConfig: jest.fn().mockResolvedValue({ type: DatabaseType.POSTGRES }),
    };
    history = { record: jest.fn().mockResolvedValue({ id: 'hist1' }) };
    audit = { record: jest.fn().mockResolvedValue(undefined) };
    config = {
      get: (key: string) => {
        const values: Record<string, unknown> = {
          'query.maxRows': 1000,
          'query.timeoutMs': 15000,
          'query.defaultPageSize': 100,
          'query.allowWriteQueries': false,
        };
        return values[key];
      },
    } as unknown as ConfigService;
    service = new QueryExecutionService(connections as never, history as never, audit as never, config);
  });

  describe('validate', () => {
    it('reports a safe SELECT as valid and read-only', async () => {
      const result = await service.validate('u1', 'conn1', 'SELECT * FROM customers');
      expect(result.valid).toBe(true);
      expect(result.isReadOnly).toBe(true);
    });
  });

  describe('execute', () => {
    it('rejects an invalid query before touching the database', async () => {
      await expect(
        service.execute('u1', 'conn1', { sql: 'DROP TABLE customers', confirmed: true }, {}),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(withDriver).not.toHaveBeenCalled();
      expect(history.record).toHaveBeenCalledWith(expect.objectContaining({ status: QueryStatus.BLOCKED }));
    });

    it('requires confirmation even for a valid query', async () => {
      await expect(
        service.execute('u1', 'conn1', { sql: 'SELECT 1', confirmed: false }, {}),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(withDriver).not.toHaveBeenCalled();
    });

    it('blocks a write statement when the connection has write disabled', async () => {
      await expect(
        service.execute('u1', 'conn1', { sql: 'DELETE FROM customers', confirmed: true }, {}),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(withDriver).not.toHaveBeenCalled();
    });

    it('executes a valid confirmed SELECT and records success in history', async () => {
      withDriver.mockResolvedValue({
        columns: [{ name: 'id', type: 'int' }],
        rows: [{ id: 1 }],
        rowCount: 1,
        totalRowCount: 1,
        executionTimeMs: 5,
        truncated: false,
        page: 1,
        pageSize: 100,
        status: QueryStatus.SUCCESS,
        historyId: null,
      });

      const result = await service.execute(
        'u1',
        'conn1',
        { sql: 'SELECT * FROM customers', confirmed: true },
        {},
      );

      expect(result.historyId).toBe('hist1');
      expect(history.record).toHaveBeenCalledWith(
        expect.objectContaining({ status: QueryStatus.SUCCESS, rowCount: 1 }),
      );
      expect(audit.record).toHaveBeenCalled();
    });

    it('allows write statements once the connection has write enabled and the global flag is on', async () => {
      connections.get.mockResolvedValue({ ...connection, writeEnabled: true });
      (config.get as jest.Mock) = jest.fn((key: string) => {
        const values: Record<string, unknown> = {
          'query.maxRows': 1000,
          'query.timeoutMs': 15000,
          'query.defaultPageSize': 100,
          'query.allowWriteQueries': true,
        };
        return values[key];
      });
      withDriver.mockResolvedValue({
        columns: [],
        rows: [],
        rowCount: 0,
        totalRowCount: 0,
        executionTimeMs: 3,
        truncated: false,
        page: 1,
        pageSize: 100,
        status: QueryStatus.SUCCESS,
        historyId: null,
      });

      await service.execute(
        'u1',
        'conn1',
        { sql: "DELETE FROM customers WHERE id = 1", confirmed: true },
        {},
      );
      expect(withDriver).toHaveBeenCalled();
    });
  });
});
