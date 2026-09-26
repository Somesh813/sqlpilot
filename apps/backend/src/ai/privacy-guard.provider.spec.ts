import { AiProvider } from '@sqlpilot/ai';
import { PrivacyGuardProvider } from './privacy-guard.provider';

function fakeProvider() {
  const seen: Array<{ messages: Array<{ role: string; content: string }> }> = [];
  const inner = {
    name: 'fake',
    complete: jest.fn(async (r) => (seen.push(r), { text: 'ok', model: 'm', usage: null })),
    completeStructured: jest.fn(async (r) => (seen.push(r), { data: { ok: true }, model: 'm', usage: null, raw: '' })),
    streamComplete: jest.fn(async function* (r) {
      seen.push(r);
      yield 'x';
    }),
  } as unknown as AiProvider;
  return { inner, seen };
}
const msg = (content: string) => ({ messages: [{ role: 'user' as const, content }] });

describe('PrivacyGuardProvider (F15)', () => {
  it('removes credentials from every outbound message, on every call type', async () => {
    const { inner, seen } = fakeProvider();
    const guard = new PrivacyGuardProvider(inner);
    const secret = 'gsk_abcdefghijklmnopqrstuvwx';
    await guard.complete(msg(`use key ${secret}`));
    await guard.completeStructured(msg(`postgres://admin:hunter2@db.internal:5432/app`), {} as never, 'x');
    for await (const _ of guard.streamComplete(msg('password=hunter2secret'))) void _;
    const sent = JSON.stringify(seen);
    expect(sent).not.toMatch(/gsk_abc|hunter2/);
    expect(guard.redactions).toBe(3);
  });

  it('does not touch ordinary prompts (the same object is passed through)', async () => {
    const { inner } = fakeProvider();
    const guard = new PrivacyGuardProvider(inner);
    const request = msg("SELECT name FROM customers WHERE city = 'Mumbai'");
    await guard.complete(request);
    expect((inner.complete as jest.Mock).mock.calls[0][0]).toBe(request);
    expect(guard.redactions).toBe(0);
  });

  it('cleans every message in a conversation, not just the last', async () => {
    const { inner, seen } = fakeProvider();
    const guard = new PrivacyGuardProvider(inner);
    await guard.complete({
      messages: [
        { role: 'system', content: 'token: eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmnop' },
        { role: 'user', content: 'fine' },
        { role: 'user', content: 'Bearer abcdefghijklmnop.qrstuvwx.yz123456' },
      ],
    });
    expect(JSON.stringify(seen)).not.toMatch(/eyJhbGci|abcdefghijklmnop/);
    expect(seen[0].messages[1].content).toBe('fine');
  });

  it('never logs the removed value', async () => {
    const { inner } = fakeProvider();
    const guard = new PrivacyGuardProvider(inner);
    const warn = jest.spyOn((guard as unknown as { logger: { warn: () => void } }).logger, 'warn').mockImplementation(() => undefined);
    await guard.complete(msg('key sk-abcdefghijklmnopqrstuvwxyz'));
    expect(JSON.stringify(warn.mock.calls)).not.toContain('sk-abcdef');
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/Removed 1 credential-like value/));
  });

  it('reports the wrapped provider name', () => {
    expect(new PrivacyGuardProvider(fakeProvider().inner).name).toBe('fake');
  });
});
