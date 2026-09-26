import { AskService } from './ask.service';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function build(delays: { context: number; classify: number }) {
  const calls: string[] = [];
  const ai = {
    prepareContext: jest.fn(async () => {
      calls.push('context:start');
      await sleep(delays.context);
      calls.push('context:end');
      return { connection: {}, schemaContext: {} };
    }),
    isFollowUp: jest.fn(async () => {
      calls.push('classify:start');
      await sleep(delays.classify);
      calls.push('classify:end');
      return true;
    }),
    generate: jest.fn(async () => {
      calls.push('generate');
      return { unanswerable: true, unanswerableReason: 'stop here', sql: '', assumptions: [], warnings: [], tablesUsed: [], confidence: 0, explanation: '', visualization: {} };
    }),
  };
  const conversations = {
    create: jest.fn().mockResolvedValue({ id: 'conv' }),
    recentTurns: jest.fn().mockResolvedValue([
      { role: 'user', content: 'How many customers?' },
      { role: 'assistant', content: 'There are 10 customers.' },
    ]),
    append: jest.fn().mockResolvedValue(undefined),
  };
  const connections = { get: jest.fn().mockResolvedValue({ id: 'c1' }) };
  const service = new AskService(ai as never, {} as never, conversations as never, connections as never);
  return { service, ai, calls };
}

describe('AskService: independent steps run together (F14)', () => {
  it('runs the follow-up check and the schema context at the same time, then generates', async () => {
    const { service, calls } = build({ context: 150, classify: 150 });
    const t = Date.now();
    await service.ask('u1', { connectionId: 'c1', question: 'Only Mumbai', conversationId: 'conv' }, {});
    const elapsed = Date.now() - t;
    expect(calls.indexOf('context:start')).toBeLessThan(calls.indexOf('classify:end'));
    expect(calls.indexOf('classify:start')).toBeLessThan(calls.indexOf('context:end'));
    expect(calls[calls.length - 1]).toBe('generate'); // generation needs both results
    expect(elapsed).toBeLessThan(270); // sequential would be >= 300
  });

  it('skips the classifier call entirely for the first question of a chat', async () => {
    const { service, ai } = build({ context: 5, classify: 5 });
    (service as unknown as { conversations: { recentTurns: jest.Mock } }).conversations.recentTurns.mockResolvedValue([]);
    await service.ask('u1', { connectionId: 'c1', question: 'How many customers?', conversationId: 'conv' }, {});
    expect(ai.isFollowUp).not.toHaveBeenCalled();
    expect(ai.prepareContext).toHaveBeenCalledTimes(1);
  });

  it('passes the previous question to context selection so follow-ups keep their tables', async () => {
    const { service, ai } = build({ context: 1, classify: 1 });
    await service.ask('u1', { connectionId: 'c1', question: 'Only Mumbai', conversationId: 'conv' }, {});
    expect(ai.prepareContext).toHaveBeenCalledWith('u1', 'c1', 'Only Mumbai', 'How many customers?');
  });

  it('hands only the last exchange to generation for a genuine follow-up, and none otherwise', async () => {
    const yes = build({ context: 1, classify: 1 });
    await yes.service.ask('u1', { connectionId: 'c1', question: 'Only Mumbai', conversationId: 'conv' }, {});
    expect((yes.ai.generate.mock.calls[0] as unknown[])[3]).toHaveLength(2);

    const no = build({ context: 1, classify: 1 });
    no.ai.isFollowUp.mockResolvedValue(false as never);
    await no.service.ask('u1', { connectionId: 'c1', question: 'Show sales by month', conversationId: 'conv' }, {});
    expect((no.ai.generate.mock.calls[0] as unknown[])[3]).toEqual([]);
  });

  it('a context failure is reported as a generation failure, not thrown', async () => {
    const { service, ai } = build({ context: 1, classify: 1 });
    ai.prepareContext.mockRejectedValue(new Error('mongo down') as never);
    const res = await service.ask('u1', { connectionId: 'c1', question: 'Only Mumbai', conversationId: 'conv' }, {});
    expect(res.success).toBe(false);
    expect(res.error?.stage).toBe('generation');
  });
});
