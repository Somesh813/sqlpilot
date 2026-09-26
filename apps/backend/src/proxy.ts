import { INestApplication } from '@nestjs/common';

/**
 * Tells Express how many reverse-proxy hops to trust when working out the client IP
 * (`req.ip`, which the rate limiter keys on).
 *
 *   0  no proxy in front: X-Forwarded-For is ignored, so a client cannot fake its address.
 *   1  exactly one proxy (the bundled nginx): the LAST X-Forwarded-For entry, which nginx
 *      wrote, is the client. Anything the client prepended is ignored.
 *
 * `trust proxy = true` would trust the FIRST entry, which is attacker-controlled, so it is
 * never used. Behind nginx, without this every user shares nginx's IP and one person's
 * failed logins lock everybody out.
 */
export function applyProxySettings(app: INestApplication, hops: number): void {
  const n = Number.isFinite(hops) && hops > 0 ? Math.floor(hops) : 0;
  (app.getHttpAdapter().getInstance() as { set(key: string, value: unknown): void }).set('trust proxy', n);
}
