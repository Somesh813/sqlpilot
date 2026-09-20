import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  AiCompletion,
  AiProvider,
  AiProviderError,
  AiStructuredResult,
  OpenAiProvider,
} from '@sqlpilot/ai';
import { AppConfig } from '../config/configuration';

export const AI_PROVIDER = Symbol('AI_PROVIDER');

/** Used when the selected provider has no API key configured — every call fails with a clear message. */
class DisabledAiProvider implements AiProvider {
  readonly name = 'disabled';
  constructor(private readonly reason: string) {}
  private fail(): never {
    throw new AiProviderError(this.reason);
  }
  // `async` so the sync throw in fail() becomes a rejected promise, as the AiProvider contract implies.
  async complete(): Promise<AiCompletion> {
    return this.fail();
  }
  async completeStructured<T>(): Promise<AiStructuredResult<T>> {
    return this.fail();
  }
  async *streamComplete(): AsyncIterable<string> {
    this.fail();
  }
}

/**
 * Builds the AI provider from config. Supports OpenAI and Groq — Groq exposes
 * an OpenAI-compatible chat completions API, so both reuse `OpenAiProvider`
 * pointed at a different base URL and key. Switch with `AI_PROVIDER=openai|groq`.
 */
export function aiProviderFactory(config: ConfigService): AiProvider {
  const logger = new Logger('AiProvider');
  const ai = config.get<AppConfig['ai']>('ai')!;

  if (ai.provider === 'groq') {
    if (!ai.groq.apiKey) {
      logger.warn('AI_PROVIDER=groq but GROQ_API_KEY is not set — AI features are disabled.');
      return new DisabledAiProvider('AI features are disabled. Set GROQ_API_KEY on the API to enable them.');
    }
    logger.log(`Using Groq (${ai.groq.model}) for AI features.`);
    return new OpenAiProvider({
      apiKey: ai.groq.apiKey,
      model: ai.groq.model,
      fastModel: ai.groq.fastModel,
      timeoutMs: ai.timeoutMs,
      baseURL: ai.groq.baseUrl,
      providerName: 'groq',
      structuredOutputMode: ai.structuredOutputMode,
    });
  }

  if (!ai.openai.apiKey) {
    logger.warn('OPENAI_API_KEY is not set — AI features are disabled.');
    return new DisabledAiProvider('AI features are disabled. Set OPENAI_API_KEY on the API to enable them.');
  }
  logger.log(`Using OpenAI (${ai.openai.model}) for AI features.`);
  return new OpenAiProvider({
    apiKey: ai.openai.apiKey,
    model: ai.openai.model,
    fastModel: ai.openai.fastModel,
    timeoutMs: ai.timeoutMs,
    baseURL: ai.openai.baseUrl,
    providerName: 'openai',
    structuredOutputMode: ai.structuredOutputMode,
  });
}
