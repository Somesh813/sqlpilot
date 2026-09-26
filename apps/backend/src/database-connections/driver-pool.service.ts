import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DriverConfig, DriverRegistry, SqlDriver } from '@sqlpilot/database';

/**
 * One persistent connection pool per configured database, shared by every request, instead of
 * a new pool (TCP + TLS + login) for each query. Settings come from configuration:
 *
 *   DB_POOL_MAX_CONNECTIONS  connections per database (default 5)
 *   DB_POOL_IDLE_MS          a pool unused this long is closed (default 5 min)
 *   DB_POOL_MAX_DRIVERS      pools kept at once across all connections (default 50)
 *
 * Pools are dropped when a connection is edited or deleted and when the app shuts down.
 * Connection tests deliberately do NOT use this: a test must prove a fresh connection works.
 */
@Injectable()
export class DriverPoolService implements OnModuleDestroy {
  private readonly logger = new Logger('DriverPool');
  private readonly registry: DriverRegistry;
  private readonly maxConnections: number;
  private readonly idleMs: number;

  constructor(config: ConfigService) {
    const pool = config.get<{ maxConnections: number; idleMs: number; maxDrivers: number }>('pool');
    this.maxConnections = pool?.maxConnections ?? 5;
    this.idleMs = pool?.idleMs ?? 300_000;
    this.registry = new DriverRegistry({ idleMs: this.idleMs, maxDrivers: pool?.maxDrivers ?? 50 });
  }

  run<T>(connectionId: string, config: DriverConfig, fn: (driver: SqlDriver) => Promise<T>): Promise<T> {
    return this.registry.run(
      connectionId,
      { ...config, pool: { max: this.maxConnections, idleMs: Math.min(this.idleMs, 30_000) } },
      fn,
    );
  }

  /** The connection was edited or deleted: its pool (with the old credentials) must go. */
  invalidate(connectionId: string): void {
    this.registry.invalidate(connectionId);
  }

  get poolCount(): number {
    return this.registry.size;
  }

  async onModuleDestroy(): Promise<void> {
    await this.registry.closeAll();
    this.logger.log('Database pools closed');
  }
}
