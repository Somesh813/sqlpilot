import { DatabaseType } from '@sqlpilot/shared';
import { MysqlDriver } from './mysql-driver';
import { PostgresDriver } from './postgres-driver';
import { SqliteDriver } from './sqlite-driver';
import { DatabaseDriverError, DriverConfig, SqlDriver } from './types';

export function createDriver(config: DriverConfig): SqlDriver {
  switch (config.type) {
    case DatabaseType.POSTGRES:
      return new PostgresDriver(config);
    case DatabaseType.MYSQL:
      return new MysqlDriver(config);
    case DatabaseType.SQLITE:
      return new SqliteDriver(config);
    default:
      throw new DatabaseDriverError(`Unsupported database type: ${config.type as string}`, null, 'CONNECTION');
  }
}

/** Opens a driver, runs `fn`, and always closes the driver afterwards. */
export async function withDriver<T>(config: DriverConfig, fn: (driver: SqlDriver) => Promise<T>): Promise<T> {
  const driver = createDriver(config);
  try {
    return await fn(driver);
  } finally {
    await driver.close().catch(() => undefined);
  }
}
