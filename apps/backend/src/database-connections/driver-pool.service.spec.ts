import { ConfigService } from '@nestjs/config';
import { DatabaseType } from '@sqlpilot/shared';
import { DriverPoolService } from './driver-pool.service';

const config = (pool: Record<string, number>) => ({ get: (k: string) => (k === 'pool' ? pool : undefined) }) as unknown as ConfigService;
const pg = { type: DatabaseType.POSTGRES, host: 'db', database: 'app', username: 'u', password: 'p' };

describe('DriverPoolService', () => {
  it('passes the configured pool size and a bounded idle time to the driver', async () => {
    const service = new DriverPoolService(config({ maxConnections: 7, idleMs: 600_000, maxDrivers: 10 }));
    const registry = (service as unknown as { registry: { run: jest.Mock } }).registry;
    registry.run = jest.fn().mockResolvedValue('ok');
    await service.run('c1', pg, async () => 'x');
    expect(registry.run).toHaveBeenCalledWith('c1', expect.objectContaining({ pool: { max: 7, idleMs: 30_000 } }), expect.any(Function));
    await service.onModuleDestroy();
  });

  it('falls back to safe defaults when nothing is configured', async () => {
    const service = new DriverPoolService(config(undefined as never));
    const registry = (service as unknown as { registry: { run: jest.Mock } }).registry;
    registry.run = jest.fn().mockResolvedValue('ok');
    await service.run('c1', pg, async () => 'x');
    expect(registry.run).toHaveBeenCalledWith('c1', expect.objectContaining({ pool: { max: 5, idleMs: 30_000 } }), expect.any(Function));
    await service.onModuleDestroy();
  });

  it('invalidate() and shutdown reach the registry', async () => {
    const service = new DriverPoolService(config({ maxConnections: 5, idleMs: 1000, maxDrivers: 5 }));
    const registry = (service as unknown as { registry: { invalidate: jest.Mock; closeAll: jest.Mock } }).registry;
    registry.invalidate = jest.fn();
    registry.closeAll = jest.fn().mockResolvedValue(undefined);
    service.invalidate('c1');
    await service.onModuleDestroy();
    expect(registry.invalidate).toHaveBeenCalledWith('c1');
    expect(registry.closeAll).toHaveBeenCalled();
  });
});
