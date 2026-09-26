import { toDriverError } from './errors';
import { DatabaseDriverError } from './types';

const err = (message: string, extra: Record<string, unknown> = {}) => Object.assign(new Error(message), extra);

describe('toDriverError classifies what went wrong', () => {
  it.each([
    ['connection refused', err('connect ECONNREFUSED 10.0.0.5:5432', { code: 'ECONNREFUSED' })],
    ['unknown host', err('getaddrinfo ENOTFOUND db.internal', { code: 'ENOTFOUND' })],
    ['pg connect timeout', err('timeout exceeded when trying to connect')],
    ['pg bad password', err('password authentication failed for user "app"', { code: '28P01' })],
    ['pg unknown database', err('database "nope" does not exist', { code: '3D000' })],
    ['pg too many clients', err('sorry, too many clients already', { code: '53300' })],
    ['pg server shutting down', err('terminating connection due to administrator command', { code: '57P01' })],
    ['pg connection terminated', err('Connection terminated unexpectedly')],
    ['mysql access denied', err("Access denied for user 'root'@'localhost'", { code: 'ER_ACCESS_DENIED_ERROR', errno: 1045 })],
    ['mysql unknown database', err("Unknown database 'x'", { code: 'ER_BAD_DB_ERROR', errno: 1049 })],
    ['mysql lost connection', err('Connection lost: The server closed the connection.', { code: 'PROTOCOL_CONNECTION_LOST' })],
    ['mysql cannot connect', err('connect ETIMEDOUT', { errno: 2003 })],
  ])('%s -> CONNECTION', (_label, error) => {
    const out = toDriverError(error, 5);
    expect(out).toBeInstanceOf(DatabaseDriverError);
    expect(out.code).toBe('CONNECTION');
    expect(out.message).not.toMatch(/ECONN|10\.0\.0\.5|password/); // the outward message is generic
  });

  it.each([
    ['pg statement timeout', err('canceling statement due to statement timeout', { code: '57014' })],
    ['mysql max_execution_time', err('Query execution was interrupted, maximum statement execution time exceeded')],
  ])('%s -> TIMEOUT', (_label, error) => {
    expect(toDriverError(error, 1000).code).toBe('TIMEOUT');
  });

  it.each([
    ['pg missing column', err('column "nme" does not exist', { code: '42703' })],
    ['pg syntax error', err('syntax error at or near "FORM"', { code: '42601' })],
    ['pg read-only violation', err('cannot execute DELETE in a read-only transaction', { code: '25006' })],
    ['mysql syntax', err("You have an error in your SQL syntax", { code: 'ER_PARSE_ERROR', errno: 1064 })],
    ['sqlite no such column', err('no such column: nme')],
  ])('%s -> QUERY', (_label, error) => {
    expect(toDriverError(error, 5).code).toBe('QUERY');
  });

  it('keeps the raw text for the log but never as the message', () => {
    const out = toDriverError(err('connect ECONNREFUSED 10.0.0.5:5432', { code: 'ECONNREFUSED' }), 5);
    expect(out.driverError).toContain('10.0.0.5');
    expect(out.message).toBe('The database connection failed.');
  });

  it('passes an existing DatabaseDriverError through untouched', () => {
    const original = new DatabaseDriverError('x', 'y', 'CANCELLED');
    expect(toDriverError(original, 1)).toBe(original);
  });
});
