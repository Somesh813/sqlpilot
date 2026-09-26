import { BadRequestException } from '@nestjs/common';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assertHostAllowed,
  assertSqlitePathAllowed,
  ConnectionPolicy,
  HOST_DENIED_MESSAGE,
  isPrivateAddress,
  safeConnectionError,
  SQLITE_DENIED_MESSAGE,
} from './connection-policy';

let root: string;
let allowed: string;
let outside: string;
const policy = (over: Partial<ConnectionPolicy> = {}): ConnectionPolicy => ({
  sqliteAllowedDirs: [allowed],
  allowedHosts: [],
  blockPrivateHosts: true,
  ...over,
});

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'sqlpilot-policy-'));
  allowed = join(root, 'approved');
  outside = join(root, 'secret');
  mkdirSync(allowed);
  mkdirSync(outside);
  writeFileSync(join(allowed, 'shop.sqlite'), 'x');
  writeFileSync(join(allowed, 'notes.txt'), 'x');
  writeFileSync(join(outside, 'app.sqlite'), 'x');
  mkdirSync(join(allowed, 'sub'));
  writeFileSync(join(allowed, 'sub', 'deep.db'), 'x');
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

const msg = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    return (e as BadRequestException).message;
  }
  return null;
};

describe('SQLite path policy (F4)', () => {
  it('accepts a file inside an approved directory, including subdirectories', () => {
    expect(assertSqlitePathAllowed(join(allowed, 'shop.sqlite'), policy())).toMatch(/shop\.sqlite$/);
    expect(assertSqlitePathAllowed(join(allowed, 'sub', 'deep.db'), policy())).toMatch(/deep\.db$/);
  });

  it('rejects files outside, `..` traversal, and prefix-sibling directories', () => {
    expect(msg(() => assertSqlitePathAllowed(join(outside, 'app.sqlite'), policy()))).toBe(SQLITE_DENIED_MESSAGE);
    expect(msg(() => assertSqlitePathAllowed(join(allowed, '..', 'secret', 'app.sqlite'), policy()))).toBe(SQLITE_DENIED_MESSAGE);
    // /approved-evil must not match /approved
    const sibling = allowed + '-evil';
    mkdirSync(sibling);
    writeFileSync(join(sibling, 'x.sqlite'), 'x');
    expect(msg(() => assertSqlitePathAllowed(join(sibling, 'x.sqlite'), policy()))).toBe(SQLITE_DENIED_MESSAGE);
  });

  it('gives the SAME message for missing, outside, wrong-type and directory (no existence oracle)', () => {
    const missingInside = msg(() => assertSqlitePathAllowed(join(allowed, 'nope.sqlite'), policy()));
    const existsOutside = msg(() => assertSqlitePathAllowed(join(outside, 'app.sqlite'), policy()));
    const missingOutside = msg(() => assertSqlitePathAllowed(join(outside, 'nope.sqlite'), policy()));
    const wrongType = msg(() => assertSqlitePathAllowed(join(allowed, 'notes.txt'), policy()));
    const dir = msg(() => assertSqlitePathAllowed(join(allowed, 'sub'), policy()));
    expect(new Set([missingInside, existsOutside, missingOutside, wrongType, dir])).toEqual(new Set([SQLITE_DENIED_MESSAGE]));
  });

  it('rejects system paths, NUL bytes and empty input', () => {
    for (const p of ['/etc/passwd', 'C:\Windows\win.ini', '', 'a\0b.sqlite']) {
      expect(msg(() => assertSqlitePathAllowed(p, policy()))).toBe(SQLITE_DENIED_MESSAGE);
    }
  });

  it('refuses everything when no directory is approved', () => {
    expect(msg(() => assertSqlitePathAllowed(join(allowed, 'shop.sqlite'), policy({ sqliteAllowedDirs: [] })))).toBe(SQLITE_DENIED_MESSAGE);
  });

  it('does not follow a symlink out of the approved directory', () => {
    const link = join(allowed, 'escape.sqlite');
    try {
      symlinkSync(join(outside, 'app.sqlite'), link);
    } catch {
      return; // symlinks need privileges on some Windows setups
    }
    expect(msg(() => assertSqlitePathAllowed(link, policy()))).toBe(SQLITE_DENIED_MESSAGE);
  });
});

describe('host policy (F4)', () => {
  const denied = async (host: string, p = policy()) => {
    try {
      await assertHostAllowed(host, p);
    } catch (e) {
      return (e as BadRequestException).message;
    }
    return null;
  };

  it.each(['127.0.0.1', '10.1.2.3', '172.16.5.5', '192.168.1.10', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1', 'localhost'])(
    'blocks private/loopback/metadata destination %s',
    async (host) => {
      expect(await denied(host)).toBe(HOST_DENIED_MESSAGE);
    },
  );

  it('allows a public address', async () => {
    expect(await denied('8.8.8.8')).toBeNull();
  });

  it('is off when private hosts are permitted (local development)', async () => {
    expect(await denied('127.0.0.1', policy({ blockPrivateHosts: false }))).toBeNull();
  });

  it('an allowlist wins: exact name, wildcard, IP and CIDR', async () => {
    const p = (...allowedHosts: string[]) => policy({ allowedHosts });
    expect(await denied('10.0.0.5', p('10.0.0.0/24'))).toBeNull();
    expect(await denied('10.0.1.5', p('10.0.0.0/24'))).toBe(HOST_DENIED_MESSAGE);
    expect(await denied('10.0.0.5', p('10.0.0.5'))).toBeNull();
    expect(await denied('8.8.8.8', p('10.0.0.0/8'))).toBe(HOST_DENIED_MESSAGE);
    expect(await denied('localhost', p('localhost'))).toBeNull();
  });

  it('rejects hosts with credentials, paths or spaces', async () => {
    for (const h of ['user@evil.com', 'a b', 'evil.com/path', '']) expect(await denied(h)).toBe(HOST_DENIED_MESSAGE);
  });

  it('isPrivateAddress treats garbage as unsafe', () => {
    expect(isPrivateAddress('not-an-ip')).toBe(true);
    expect(isPrivateAddress('93.184.216.34')).toBe(false);
  });
});

describe('safeConnectionError (no internals leak to the user)', () => {
  it.each([
    ['password authentication failed for user "postgres"', /Authentication failed/],
    ["Access denied for user 'root'@'localhost'", /Authentication failed/],
    ['connect ECONNREFUSED 10.0.0.7:5432', /Could not connect/],
    ['getaddrinfo ENOTFOUND db.internal.corp', /Could not connect/],
    ['self-signed certificate in certificate chain', /secure connection/],
  ])('%s', (raw, expected) => {
    const out = safeConnectionError(raw)!;
    expect(out).toMatch(expected);
    expect(out).not.toMatch(/10\.0\.0\.7|db\.internal|postgres|root|ECONN|ENOTFOUND/);
  });
  it('passes null through', () => expect(safeConnectionError(null)).toBeNull());
});
