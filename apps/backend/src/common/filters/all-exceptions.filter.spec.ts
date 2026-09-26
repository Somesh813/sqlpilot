import { BadRequestException, HttpStatus, ServiceUnavailableException } from '@nestjs/common';
import { ThrottlerException } from '@nestjs/throttler';
import { AllExceptionsFilter } from './all-exceptions.filter';
import { SafeException } from '../errors/safe-exception';

function run(exception: unknown) {
  let status = 0;
  let body: Record<string, unknown> = {};
  const host = {
    switchToHttp: () => ({
      getResponse: () => ({ status: (s: number) => ((status = s), { json: (b: Record<string, unknown>) => (body = b) }) }),
      getRequest: () => ({ id: 'req-1', method: 'POST', url: '/api/x' }),
    }),
  };
  new AllExceptionsFilter().catch(exception, host as never);
  return { status, body };
}

describe('AllExceptionsFilter never lets internals reach the browser', () => {
  it('turns an unexpected exception into a generic 500 with no stack, path or original text', () => {
    const e = new Error("ENOENT: open 'C:\Users\ASUS\secret\app.sqlite' at /app/dist/x.js:1:1");
    e.stack = `${e.message}\n    at Object.<anonymous> (/app/dist/x.js:1:1)`;
    const { status, body } = run(e);
    expect(status).toBe(500);
    expect(body.message).toBe('Something went wrong on our side. Please try again in a moment.');
    expect(JSON.stringify(body)).not.toMatch(/ENOENT|ASUS|app\.sqlite|\.js:|at Object/);
    expect(body.requestId).toBe('req-1');
  });

  it('replaces the framework wording for rate limiting with the friendly message', () => {
    const { status, body } = run(new ThrottlerException());
    expect(status).toBe(429);
    expect(body.message).toBe('You are sending requests too quickly. Please wait a moment and try again.');
  });

  it('keeps a coded AI rate-limit message intact (it is already safe)', () => {
    const { status, body } = run(new SafeException('AI_BUSY', HttpStatus.TOO_MANY_REQUESTS, 'provider org_abc12345 leaked'));
    expect(status).toBe(429);
    expect(body.message).toBe('AI service is temporarily busy. Please try again in a moment.');
    expect(body.code).toBe('AI_BUSY');
    expect(JSON.stringify(body)).not.toMatch(/org_abc12345|leaked/); // detail is for logs, not the body
  });

  it('replaces an uncoded 5xx message that might carry provider text', () => {
    const { body } = run(new ServiceUnavailableException('groq request failed (503): org_01abcXYZ789 down'));
    expect(body.message).toBe('Something went wrong on our side. Please try again in a moment.');
    expect(JSON.stringify(body)).not.toMatch(/groq|org_/);
  });

  it('leaves ordinary validation errors readable', () => {
    const { status, body } = run(new BadRequestException(['email must be an email']));
    expect(status).toBe(400);
    expect(body.message).toEqual(['email must be an email']);
  });
});
