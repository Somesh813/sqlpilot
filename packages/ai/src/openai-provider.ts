import OpenAI from 'openai';
import { z } from 'zod';
import {
  AiCompletion,
  AiCompletionRequest,
  AiProvider,
  AiProviderError,
  AiStructuredResult,
  AiUsage,
} from './provider';

export interface OpenAiProviderOptions {
  apiKey: string;
  model: string;
  fastModel: string;
  timeoutMs: number;
  baseURL?: string;
}

function toUsage(usage: OpenAI.CompletionUsage | undefined): AiUsage | null {
  if (!usage) return null;
  return {
    promptTokens: usage.prompt_tokens,
    completionTokens: usage.completion_tokens,
    totalTokens: usage.total_tokens,
  };
}

export class OpenAiProvider implements AiProvider {
  readonly name = 'openai';
  private readonly client: OpenAI;

  constructor(private readonly options: OpenAiProviderOptions) {
    this.client = new OpenAI({
      apiKey: options.apiKey,
      timeout: options.timeoutMs,
      baseURL: options.baseURL,
    });
  }

  async complete(request: AiCompletionRequest): Promise<AiCompletion> {
    try {
      const response = await this.client.chat.completions.create(
        {
          model: request.model ?? this.options.model,
          temperature: request.temperature ?? 0.1,
          max_tokens: request.maxTokens,
          messages: request.messages,
        },
        { signal: request.signal },
      );
      const choice = response.choices[0];
      return {
        text: choice?.message?.content ?? '',
        model: response.model,
        usage: toUsage(response.usage),
      };
    } catch (error) {
      throw this.wrap(error);
    }
  }

  async completeStructured<T>(
    request: AiCompletionRequest,
    schema: z.ZodType<T>,
    schemaName: string,
  ): Promise<AiStructuredResult<T>> {
    const jsonSchema = zodToJsonSchema(schema);
    try {
      const response = await this.client.chat.completions.create(
        {
          model: request.model ?? this.options.model,
          temperature: request.temperature ?? 0,
          max_tokens: request.maxTokens,
          messages: request.messages,
          response_format: {
            type: 'json_schema',
            json_schema: { name: schemaName, strict: true, schema: jsonSchema },
          },
        },
        { signal: request.signal },
      );
      const raw = response.choices[0]?.message?.content ?? '';
      if (!raw) throw new AiProviderError('Model returned an empty response.');

      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        throw new AiProviderError('Model response was not valid JSON.');
      }

      const validated = schema.safeParse(parsed);
      if (!validated.success) {
        throw new AiProviderError(
          `Model response did not match the ${schemaName} schema: ${validated.error.message}`,
        );
      }
      return {
        data: validated.data,
        model: response.model,
        usage: toUsage(response.usage),
        raw,
      };
    } catch (error) {
      throw this.wrap(error);
    }
  }

  async *streamComplete(request: AiCompletionRequest): AsyncIterable<string> {
    try {
      const stream = await this.client.chat.completions.create(
        {
          model: request.model ?? this.options.model,
          temperature: request.temperature ?? 0.2,
          messages: request.messages,
          stream: true,
        },
        { signal: request.signal },
      );
      for await (const chunk of stream) {
        const delta = chunk.choices[0]?.delta?.content;
        if (delta) yield delta;
      }
    } catch (error) {
      throw this.wrap(error);
    }
  }

  private wrap(error: unknown): AiProviderError {
    if (error instanceof AiProviderError) return error;
    if (error instanceof OpenAI.APIError) {
      const retryable = error.status === 429 || (error.status ?? 0) >= 500;
      return new AiProviderError(`OpenAI request failed (${error.status}): ${error.message}`, error, retryable);
    }
    if (error instanceof Error && error.name === 'AbortError') {
      return new AiProviderError('The AI request timed out.', error, true);
    }
    return new AiProviderError('Unexpected AI provider error.', error);
  }
}

/**
 * Minimal Zod → JSON Schema conversion covering the subset used by SQLPilot
 * structured outputs (objects, strings, numbers, booleans, arrays, enums,
 * nullables). Kept dependency-free and deterministic for `strict` mode.
 */
export function zodToJsonSchema(schema: z.ZodTypeAny): Record<string, unknown> {
  const def = schema._def;

  switch (def.typeName) {
    case z.ZodFirstPartyTypeKind.ZodObject: {
      const shape = (def as z.ZodObjectDef).shape();
      const properties: Record<string, unknown> = {};
      const required: string[] = [];
      for (const [key, value] of Object.entries(shape)) {
        properties[key] = zodToJsonSchema(value as z.ZodTypeAny);
        required.push(key);
      }
      return { type: 'object', properties, required, additionalProperties: false };
    }
    case z.ZodFirstPartyTypeKind.ZodString:
      return { type: 'string' };
    case z.ZodFirstPartyTypeKind.ZodNumber:
      return { type: 'number' };
    case z.ZodFirstPartyTypeKind.ZodBoolean:
      return { type: 'boolean' };
    case z.ZodFirstPartyTypeKind.ZodArray:
      return { type: 'array', items: zodToJsonSchema((def as z.ZodArrayDef).type) };
    case z.ZodFirstPartyTypeKind.ZodEnum:
      return { type: 'string', enum: (def as z.ZodEnumDef).values };
    case z.ZodFirstPartyTypeKind.ZodNativeEnum:
      return { type: 'string', enum: Object.values((def as z.ZodNativeEnumDef).values) };
    case z.ZodFirstPartyTypeKind.ZodNullable:
      return { anyOf: [zodToJsonSchema((def as z.ZodNullableDef).innerType), { type: 'null' }] };
    case z.ZodFirstPartyTypeKind.ZodOptional:
      return zodToJsonSchema((def as z.ZodOptionalDef).innerType);
    case z.ZodFirstPartyTypeKind.ZodDefault:
      return zodToJsonSchema((def as z.ZodDefaultDef).innerType);
    case z.ZodFirstPartyTypeKind.ZodLiteral:
      return { const: (def as z.ZodLiteralDef).value };
    default:
      return {};
  }
}
