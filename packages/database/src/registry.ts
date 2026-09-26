import { createHash } from 'node:crypto';
import { DatabaseType } from '@sqlpilot/shared';
import { createDriver } from './driver-factory';
import { DriverConfig, SqlDriver } from './types';

export interface RegistryOptions {
  /** A pool nobody has used for this long is closed. */
  idleMs?: number;
  /** Most pools kept at once. The least recently used idle pool is closed to make room. */
  maxDrivers?: number;
  /** How often idle pools are swept. */
  sweepMs?: number;
  /** Test seams. */
  now?: () => number;
  factory?: (config: DriverConfig) => SqlDriver;
}

interface Entry {
  key: string;
  connectionId: string;
  driver: SqlDriver;
  inFlight: number;
  lastUsed: number;
  /** No new work is handed out; the pool closes as soon as its last query finishes. */
  retired: boolean;
  closed: boolean;
}

/** Same connection + same settings = same pool. Changing host, user, password or database gives a new one. */
export function configFingerprint(config: DriverConfig): string {
  const { type, host, port, database, username, password, filePath, ssl, options } = config;
  return createHash('sha256')
    .update(JSON.stringify([type, host, port, database, username, password, filePath, ssl, options]))
    .digest('hex')
    .slice(0, 24);
}

/**
 * Keeps one driver (and so one connection pool) per configured database, instead of building
 * and tearing down a pool for every request. Lifecycle:
 *
 *   create     lazily, on first use
 *   reuse      every later query on the same connection + settings
 *   retire     when the connection is edited or deleted, or a connection error shows the pool is
 *              stale; it finishes its running queries, then closes
 *   evict      after `idleMs` unused, or when more than `maxDrivers` exist (least recently used)
 *   close all  on shutdown
 *
 * SQLite has no pool (each query is its own process), so it is never cached.
 */
export class DriverRegistry {
  private readonly entries = new Map<string, Entry>();
  private readonly idleMs: number;
  private readonly maxDrivers: number;
  private readonly now: () => number;
  private readonly factory: (config: DriverConfig) => SqlDriver;
  private timer: NodeJS.Timeout | null = null;
  private closed = false;

  constructor(options: RegistryOptions = {}) {
    this.idleMs = options.idleMs ?? 5 * 60_000;
    this.maxDrivers = options.maxDrivers ?? 50;
    this.now = options.now ?? Date.now;
    this.factory = options.factory ?? createDriver;
    const sweepMs = options.sweepMs ?? 30_000;
    if (sweepMs > 0) {
      this.timer = setInterval(() => void this.sweep(), sweepMs);
      this.timer.unref(); // never keeps the process alive
    }
  }

  get size(): number {
    return this.entries.size;
  }

  /** Runs `fn` on the pooled driver for this connection, creating it if needed. */
  async run<T>(connectionId: string, config: DriverConfig, fn: (driver: SqlDriver) => Promise<T>): Promise<T> {
    if (this.closed) throw new Error('The driver registry is closed.');
    if (config.type === DatabaseType.SQLITE) {
      const driver = this.factory(config);
      try {
        return await fn(driver);
      } finally {
        await driver.close().catch(() => undefined);
      }
    }

    const entry = this.acquire(connectionId, config);
    entry.inFlight++;
    try {
      return await fn(entry.driver);
    } catch (error) {
      // An unreachable database usually means the pool holds dead sockets or a stale address.
      if ((error as { code?: string })?.code === 'CONNECTION') this.retire(entry);
      throw error;
    } finally {
      entry.inFlight--;
      entry.lastUsed = this.now();
      if (entry.retired && entry.inFlight === 0) void this.dispose(entry);
    }
  }

  /** The connection was edited or deleted: drop every pool that belongs to it. */
  invalidate(connectionId: string): void {
    for (const entry of [...this.entries.values()]) {
      if (entry.connectionId === connectionId) this.retire(entry);
    }
  }

  /** Closes pools that have been idle too long. Called on a timer; exposed for tests. */
  async sweep(): Promise<number> {
    const cutoff = this.now() - this.idleMs;
    const stale = [...this.entries.values()].filter((e) => e.inFlight === 0 && e.lastUsed <= cutoff);
    stale.forEach((e) => this.retire(e));
    await Promise.all(stale.map((e) => this.dispose(e)));
    return stale.length;
  }

  async closeAll(): Promise<void> {
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    const all = [...this.entries.values()];
    all.forEach((e) => (e.retired = true));
    await Promise.all(all.map((e) => this.dispose(e, true)));
  }

  // ---------------------------------------------------------------------------

  private acquire(connectionId: string, config: DriverConfig): Entry {
    const key = `${connectionId}:${configFingerprint(config)}`;
    const existing = this.entries.get(key);
    if (existing && !existing.retired) return existing;

    // Settings changed: the previous pool for this connection is obsolete.
    this.invalidate(connectionId);
    this.makeRoom();

    const entry: Entry = {
      key,
      connectionId,
      driver: this.factory(config),
      inFlight: 0,
      lastUsed: this.now(),
      retired: false,
      closed: false,
    };
    this.entries.set(key, entry);
    return entry;
  }

  private makeRoom(): void {
    while (this.entries.size >= this.maxDrivers) {
      const idle = [...this.entries.values()].filter((e) => e.inFlight === 0).sort((a, b) => a.lastUsed - b.lastUsed)[0];
      if (!idle) return; // everything is busy; allow a temporary overshoot rather than fail a request
      this.retire(idle);
      void this.dispose(idle);
    }
  }

  private retire(entry: Entry): void {
    entry.retired = true;
    if (entry.inFlight === 0) void this.dispose(entry);
  }

  private async dispose(entry: Entry, force = false): Promise<void> {
    if (this.entries.get(entry.key) === entry) this.entries.delete(entry.key);
    if (entry.closed || (!force && entry.inFlight > 0)) return;
    entry.closed = true;
    await entry.driver.close().catch(() => undefined);
  }
}
