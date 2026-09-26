import { z } from 'zod';

export interface AiMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface AiCompletionRequest {
  messages: AiMessage[];
  /** Overrides the provider default model. */
  model?: string;
  temperature?: number;
  maxTokens?: number;
  /** Abort signal wired to a request timeout. */
  signal?: AbortSignal;
}

export interface AiUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface AiCompletion {
  text: string;
  model: string;
  usage: AiUsage | null;
}

export interface AiStructuredResult<T> {
  data: T;
  model: string;
  usage: AiUsage | null;
  raw: string;
}

/**
 * Provider-neutral contract. The backend depends only on this interface so the
 * model vendor can be swapped without touching feature services.
 */
export interface AiProvider {
  readonly name: string;
  complete(request: AiCompletionRequest): Promise<AiCompletion>;
  /**
   * Requests a JSON object matching `schema`. Implementations MUST enforce
   * structured output at the API level (JSON mode / response schema), never by
   * parsing free-form prose, and MUST validate the result against `schema`.
   */
  completeStructured<T>(
    request: AiCompletionRequest,
    schema: z.ZodType<T>,
    schemaName: string,
  ): Promise<AiStructuredResult<T>>;
  /** Token stream for chat-style responses (SSE to the browser). */
  streamComplete(request: AiCompletionRequest): AsyncIterable<string>;
}

/** What went wrong, without provider wording. The backend maps this to a user-safe message. */
export type AiErrorCode = 'RATE_LIMITED' | 'TIMEOUT' | 'UNAVAILABLE' | 'NOT_CONFIGURED' | 'BAD_RESPONSE' | 'UNKNOWN';

export class AiProviderError extends Error {
  constructor(
    /** Internal detail for logs. Never show this to a user: it can carry ids and provider text. */
    message: string,
    readonly cause?: unknown,
    readonly retryable = false,
    readonly code: AiErrorCode = 'UNKNOWN',
    /** HTTP status returned by the provider, when there was one. */
    readonly status?: number,
  ) {
    super(message);
    this.name = 'AiProviderError';
  }
}
