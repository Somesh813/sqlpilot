import { Logger } from '@nestjs/common';
import {
  AiCompletion,
  AiCompletionRequest,
  AiMessage,
  AiProvider,
  AiStructuredResult,
} from '@sqlpilot/ai';
import { redactCredentials } from '@sqlpilot/shared';
import { z } from 'zod';

/**
 * Last line of defence for everything sent to a model provider. Whatever a caller builds (a
 * prompt, a question the user typed, SQL, an error message), credential-shaped text is removed
 * here before the request leaves the server: API keys, tokens, JWTs, private keys, passwords in
 * `key=value` text, and connection strings with embedded passwords.
 *
 * This is deliberately separate from the result minimisation (which decides what data is worth
 * sending): that reduces what is offered, this guarantees a secret cannot slip through by
 * accident, including in code paths added later.
 */
export class PrivacyGuardProvider implements AiProvider {
  private readonly logger = new Logger('AiPrivacy');
  /** Total values removed so far (exposed for tests and metrics). */
  redactions = 0;

  constructor(private readonly inner: AiProvider) {}

  get name(): string {
    return this.inner.name;
  }

  complete(request: AiCompletionRequest): Promise<AiCompletion> {
    return this.inner.complete(this.clean(request));
  }

  completeStructured<T>(request: AiCompletionRequest, schema: z.ZodType<T>, schemaName: string): Promise<AiStructuredResult<T>> {
    return this.inner.completeStructured(this.clean(request), schema, schemaName);
  }

  streamComplete(request: AiCompletionRequest): AsyncIterable<string> {
    return this.inner.streamComplete(this.clean(request));
  }

  private clean(request: AiCompletionRequest): AiCompletionRequest {
    let removed = 0;
    const messages: AiMessage[] = request.messages.map((m) => {
      const { text, count } = redactCredentials(m.content);
      removed += count;
      return count > 0 ? { ...m, content: text } : m;
    });
    if (removed > 0) {
      this.redactions += removed;
      // Counts only: the removed values are never logged.
      this.logger.warn(`Removed ${removed} credential-like value(s) from an outbound AI request`);
    }
    return removed > 0 ? { ...request, messages } : request;
  }
}
