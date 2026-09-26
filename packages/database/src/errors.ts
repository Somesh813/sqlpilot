import { DatabaseDriverError } from './types';

const NETWORK_CODES = new Set([
  'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ETIMEDOUT', 'ECONNRESET', 'EHOSTUNREACH', 'ENETUNREACH',
  'EPIPE', 'ECONNABORTED', 'PROTOCOL_CONNECTION_LOST', 'PROTOCOL_ENQUEUE_AFTER_FATAL_ERROR',
  // MySQL: access denied, unknown database, too many connections, host blocked
  'ER_ACCESS_DENIED_ERROR', 'ER_BAD_DB_ERROR', 'ER_CON_COUNT_ERROR', 'ER_HOST_NOT_PRIVILEGED', 'ER_DBACCESS_DENIED_ERROR',
]);
const MYSQL_CONNECTION_ERRNO = new Set([1045, 1049, 1040, 1129, 1130, 2002, 2003, 2006, 2013]);

interface ErrorLike {
  code?: string;
  errno?: number;
  message?: string;
  cause?: unknown;
}

/**
 * Sorts a raw driver error into what happened, so callers can choose a safe message:
 *   CONNECTION  the database could not be reached, or refused us (network, auth, unknown database)
 *   TIMEOUT     the statement ran past its limit
 *   QUERY       the database rejected the SQL itself (syntax, missing column, read-only violation)
 * The raw text is kept in `driverError` for logs and never meant for end users.
 */
export function toDriverError(error: unknown, elapsedMs: number): DatabaseDriverError {
  if (error instanceof DatabaseDriverError) return error;
  const e = (error ?? {}) as ErrorLike;
  const raw = error instanceof Error ? error.message : String(error);
  const code = String(e.code ?? '');

  if (/statement timeout|canceling statement due to statement timeout|max_execution_time|query execution was interrupted/i.test(raw) || code === '57014') {
    return new DatabaseDriverError(`Query exceeded the time limit (${elapsedMs}ms).`, raw, 'TIMEOUT');
  }
  const pgClass = /^[0-9A-Z]{5}$/.test(code) ? code.slice(0, 2) : '';
  const isConnection =
    NETWORK_CODES.has(code) ||
    (typeof e.errno === 'number' && MYSQL_CONNECTION_ERRNO.has(e.errno)) ||
    ['08', '28', '3D', '53', '57'].includes(pgClass) && code !== '57014' ||
    /connection (terminated|refused|closed|timeout)|timeout (exceeded|expired) when trying to connect|Connection lost|getaddrinfo|password authentication failed|no pg_hba|the database system is (starting up|shutting down)|too many clients|self[- ]signed certificate|SSL|ECONN/i.test(raw);

  if (isConnection) return new DatabaseDriverError('The database connection failed.', raw, 'CONNECTION');
  return new DatabaseDriverError('Query execution failed.', raw, 'QUERY');
}
