import { DatabaseType } from '@sqlpilot/shared';

export type ParserDialect = 'postgresql' | 'mysql' | 'sqlite';

export function toParserDialect(type: DatabaseType): ParserDialect {
  switch (type) {
    case DatabaseType.POSTGRES:
      return 'postgresql';
    case DatabaseType.MYSQL:
      return 'mysql';
    case DatabaseType.SQLITE:
      return 'sqlite';
    default:
      return 'postgresql';
  }
}
