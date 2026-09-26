import { BadRequestException } from '@nestjs/common';
import { lookup } from 'node:dns/promises';
import { realpathSync, statSync } from 'node:fs';
import { BlockList, isIP } from 'node:net';
import { extname, resolve, sep } from 'node:path';

/**
 * Where a connection may point. Without this, any user could aim SQLPilot at
 *   - any SQLite file on the server (the app's own data, /etc/...), or
 *   - internal services / cloud metadata endpoints (SSRF), or use error text as a port scanner.
 *
 * Every rejection uses ONE message per kind, so the response never reveals whether a path
 * exists, is a file, or is readable, nor whether a host resolves.
 */

export interface ConnectionPolicy {
  /** Directories SQLite files must live in (after symlink resolution). */
  sqliteAllowedDirs: string[];
  /** Exact names, `*.example.com`, single IPs or CIDRs. Empty = no allowlist. */
  allowedHosts: string[];
  /** With no allowlist, refuse loopback/private/link-local/metadata destinations. */
  blockPrivateHosts: boolean;
}

export const SQLITE_EXTENSIONS = ['.db', '.sqlite', '.sqlite3', '.db3'];

export const SQLITE_DENIED_MESSAGE =
  'That database file is not available. It must be a SQLite file inside a directory your administrator has approved.';
export const HOST_DENIED_MESSAGE = 'That host is not allowed by this server’s connection policy.';

const norm = (p: string) => (process.platform === 'win32' ? p.toLowerCase() : p);

/** Resolves symlinks and `..` before comparing, so neither can escape an approved directory. */
export function assertSqlitePathAllowed(filePath: string, policy: ConnectionPolicy): string {
  const deny = () => new BadRequestException(SQLITE_DENIED_MESSAGE);
  if (!filePath || filePath.includes('\0')) throw deny();
  if (policy.sqliteAllowedDirs.length === 0) throw deny();
  if (!SQLITE_EXTENSIONS.includes(extname(filePath).toLowerCase())) throw deny();

  let real: string;
  try {
    real = realpathSync(resolve(filePath));
    if (!statSync(real).isFile()) throw deny();
  } catch {
    throw deny(); // missing, unreadable, and outside-directory all look the same
  }

  const inside = policy.sqliteAllowedDirs.some((dir) => {
    let base: string;
    try {
      base = realpathSync(resolve(dir));
    } catch {
      return false;
    }
    const b = norm(base.endsWith(sep) ? base : base + sep);
    return norm(real).startsWith(b);
  });
  if (!inside) throw deny();
  return real;
}

/* ------------------------------------------------------------------ hosts */

const PRIVATE_RANGES: Array<[string, number, 'ipv4' | 'ipv6']> = [
  ['0.0.0.0', 8, 'ipv4'],
  ['10.0.0.0', 8, 'ipv4'],
  ['100.64.0.0', 10, 'ipv4'],
  ['127.0.0.0', 8, 'ipv4'],
  ['169.254.0.0', 16, 'ipv4'], // link-local incl. cloud metadata 169.254.169.254
  ['172.16.0.0', 12, 'ipv4'],
  ['192.0.0.0', 24, 'ipv4'],
  ['192.168.0.0', 16, 'ipv4'],
  ['198.18.0.0', 15, 'ipv4'],
  ['::', 128, 'ipv6'],
  ['::1', 128, 'ipv6'],
  ['fc00::', 7, 'ipv6'],
  ['fe80::', 10, 'ipv6'],
];

const privateList = new BlockList();
for (const [addr, prefix, family] of PRIVATE_RANGES) privateList.addSubnet(addr, prefix, family);

function unmap(ip: string): string {
  const m = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  return m ? m[1] : ip;
}

export function isPrivateAddress(ip: string): boolean {
  const addr = unmap(ip);
  const family = isIP(addr);
  if (!family) return true; // unparseable: treat as unsafe
  return privateList.check(addr, family === 4 ? 'ipv4' : 'ipv6');
}

function matchesEntry(entry: string, host: string, ips: string[]): boolean {
  const e = entry.trim().toLowerCase();
  if (!e) return false;
  if (e.includes('/')) {
    const [base, bits] = e.split('/');
    const family = isIP(base);
    if (!family) return false;
    const list = new BlockList();
    list.addSubnet(base, Number(bits), family === 4 ? 'ipv4' : 'ipv6');
    return ips.some((ip) => {
      const a = unmap(ip);
      const f = isIP(a);
      return f === family && list.check(a, family === 4 ? 'ipv4' : 'ipv6');
    });
  }
  if (isIP(e)) return ips.some((ip) => unmap(ip) === e) || host === e;
  if (e.startsWith('*.')) return host.endsWith(e.slice(1)) && host.length > e.length - 1;
  return host === e;
}

/**
 * Validates a network host. Resolves it and checks EVERY address, so a name that points at an
 * internal IP is refused (and a name with mixed public/private answers is too).
 */
export async function assertHostAllowed(host: string, policy: ConnectionPolicy): Promise<void> {
  const deny = () => new BadRequestException(HOST_DENIED_MESSAGE);
  const h = (host ?? '').trim().toLowerCase();
  if (!h || h.length > 253 || /[\s/\\@]/.test(h)) throw deny();

  let ips: string[];
  if (isIP(h)) {
    ips = [h];
  } else {
    try {
      ips = (await lookup(h, { all: true })).map((r) => r.address);
    } catch {
      // unresolvable names fail later as "unavailable"; with a policy in force they are refused now
      if (policy.allowedHosts.length || policy.blockPrivateHosts) throw deny();
      return;
    }
  }

  if (policy.allowedHosts.length > 0) {
    if (!policy.allowedHosts.some((entry) => matchesEntry(entry, h, ips))) throw deny();
    return;
  }
  if (policy.blockPrivateHosts && ips.some(isPrivateAddress)) throw deny();
}

/**
 * User-safe wording for a failed connection. The raw driver error (which can carry addresses,
 * ports, usernames, or "getaddrinfo ENOTFOUND host") stays in the server log only.
 */
export function safeConnectionError(raw: string | null | undefined): string | null {
  if (!raw) return null;
  if (/password authentication failed|access denied|authentication|auth failed|login failed|no pg_hba/i.test(raw)) {
    return 'Authentication failed. Check the username and password.';
  }
  if (/does not exist|unknown database|not found.*database|invalid catalog/i.test(raw) && /database/i.test(raw)) {
    return 'The database name was not accepted by the server.';
  }
  if (/ssl|tls|certificate/i.test(raw)) return 'A secure connection could not be established. Check the SSL setting.';
  return 'Could not connect to the database. Check the host, port, and network access.';
}
