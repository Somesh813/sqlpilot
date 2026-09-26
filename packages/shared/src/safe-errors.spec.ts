import { looksSensitive, SAFE_MESSAGES, sanitizeTechnical } from './safe-errors';

describe('user-facing messages', () => {
  it('uses the exact wording for the two most common failures', () => {
    expect(SAFE_MESSAGES.AI_BUSY).toBe('AI service is temporarily busy. Please try again in a moment.');
    expect(SAFE_MESSAGES.DB_UNAVAILABLE).toBe('The database connection is unavailable. Please check the connection and try again.');
  });

  it('no message names a provider, model, id, path or address', () => {
    for (const message of Object.values(SAFE_MESSAGES)) {
      expect(message).not.toMatch(/groq|openai|gpt|org_|stack|\/|\\|localhost|\d+\.\d+\.\d+\.\d+/i);
      expect(looksSensitive(message)).toBe(false);
    }
  });
});

describe('sanitizeTechnical', () => {
  const leak = 'groq request failed (429): 429 Rate limit reached for model `openai/gpt-oss-120b` in organization `org_01abcXYZ789` on tokens per minute (TPM): Limit 8000';

  it('removes organisation ids', () => {
    const out = sanitizeTechnical(leak);
    expect(out).not.toContain('org_01abcXYZ789');
    expect(out).toContain('[id]');
  });

  it.each([
    ['API keys', 'Incorrect API key provided: sk-proj-abcdefghijklmnop1234567890', /sk-proj/],
    ['groq keys', 'invalid key gsk_abcdefghijklmnopqrstuvwx', /gsk_abcdef/],
    ['bearer tokens', 'Authorization: Bearer abcdefghijklmnop.qrstuvwx.yz123456', /abcdefghijklmnop/],
    ['JWTs', 'token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmnop', /eyJhbGci/],
    ['passwords in text', 'password=hunter2secret user=root', /hunter2secret/],
    ['mongo urls', 'connect failed mongodb://sqlpilot:s3cret@mongo:27017/sqlpilot?authSource=sqlpilot', /s3cret|sqlpilot:/],
    ['postgres urls', 'postgres://admin:pw@db.internal:5432/app refused', /admin:pw/],
    ['windows paths', String.raw`ENOENT: no such file C:\Users\ASUS\projects\sqlpilot\data\shop.sqlite`, /Users|ASUS|shop\.sqlite/],
    ['unix paths', 'open /var/lib/sqlpilot/secret/app.sqlite failed', /\/var\/lib|app\.sqlite/],
    ['ip addresses and ports', 'connect ECONNREFUSED 10.20.30.40:5432', /10\.20\.30\.40/],
    ['internal hostnames', 'getaddrinfo ENOTFOUND db.prod.internal', /db\.prod\.internal/],
  ])('removes %s', (_label, input, forbidden) => {
    expect(sanitizeTechnical(input)).not.toMatch(forbidden);
  });

  it('drops stack frames entirely', () => {
    const err = new Error('boom');
    err.stack = `Error: boom\n    at Object.<anonymous> (/app/dist/ai/ask.service.js:88:13)\n    at process.processTicksAndRejections (node:internal/process/task_queues:95:5)`;
    const out = sanitizeTechnical(err.stack);
    expect(out).toBe('Error: boom');
    expect(out).not.toMatch(/at |\.js|node:internal/);
  });

  it('keeps the useful part of a database error about the user\u2019s own SQL', () => {
    expect(sanitizeTechnical('no such column: nme')).toBe('no such column: nme');
    expect(sanitizeTechnical('column "nme" does not exist')).toBe('column "nme" does not exist');
    expect(sanitizeTechnical('syntax error at or near "FORM"')).toBe('syntax error at or near "FORM"');
  });

  it('limits length and collapses whitespace', () => {
    const out = sanitizeTechnical(`a${' '.repeat(50)}b\n\n${'x'.repeat(1000)}`, 100);
    expect(out.length).toBeLessThanOrEqual(100);
    expect(out.startsWith('a b')).toBe(true);
  });

  it('accepts Error objects, null and undefined', () => {
    expect(sanitizeTechnical(new Error('plain'))).toBe('plain');
    expect(sanitizeTechnical(null)).toBe('');
    expect(sanitizeTechnical(undefined)).toBe('');
  });

  it('is idempotent: scrubbing twice changes nothing more', () => {
    const once = sanitizeTechnical(leak + ' 10.0.0.5:5432 C:\\data\\x.db sk-abcdefghijklmnopqrstu');
    expect(sanitizeTechnical(once)).toBe(once);
    expect(looksSensitive(once)).toBe(false);
  });
});
