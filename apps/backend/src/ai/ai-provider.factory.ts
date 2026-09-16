import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  AiCompletion,
  AiProvider,
  AiProviderError,
  AiStructuredResult,
  OpenAiProvider,
} from '@sqlpilot/ai';

export const AI_PROVIDER = Symbol('AI_PROVIDER');

/** Used when OPENAI_API_KEY is not set — every call fails with a clear message. */
class DisabledAiProvider implements AiProvider {
  readonly name = 'disabled';
  private fail(): never {
    throw new AiProviderError('AI features are disabled. Set OPENAI_API_KEY on the API to enable them.');
  }
  complete(): Promise<AiCompletion> {
    return this.fail();
  }
  completeStructured<T>(): Promise<AiStructuredResult<T>> {
    return this.fail();
  }
  async *streamComplete(): AsyncIterable<string> {
    this.fail();
  }
}

export function aiProviderFactory(config: ConfigService): AiProvider {
  const apiKey = config.get<string>('openai.apiKey') ?? '';
  if (!apiKey) {
    new Logger('AiProvider').warn('OPENAI_API_KEY is not set — AI features are disabled.');
    return new DisabledAiProvider();
  }
  return new OpenAiProvider({
    apiKey,
    model: config.get<string>('openai.model') ?? 'gpt-4o',
    fastModel: config.get<string>('openai.fastModel') ?? 'gpt-4o-mini',
    timeoutMs: config.get<number>('openai.timeoutMs') ?? 45_000,
  });
}
