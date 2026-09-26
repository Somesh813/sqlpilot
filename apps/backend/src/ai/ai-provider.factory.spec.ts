import { ConfigService } from '@nestjs/config';
import { AppConfig } from '../config/configuration';
import { aiProviderFactory } from './ai-provider.factory';
import { PrivacyGuardProvider } from './privacy-guard.provider';

function configWith(ai: Partial<AppConfig['ai']>): ConfigService {
  const full: AppConfig['ai'] = {
    provider: 'openai',
    timeoutMs: 45_000,
    maxSchemaTables: 25,
    sendRowValues: true,
    structuredOutputMode: 'json_schema',
    openai: { apiKey: '', model: 'gpt-4o', fastModel: 'gpt-4o-mini', baseUrl: undefined },
    groq: {
      apiKey: '',
      model: 'openai/gpt-oss-120b',
      fastModel: 'openai/gpt-oss-20b',
      baseUrl: 'https://api.groq.com/openai/v1',
    },
    ...ai,
  };
  return { get: () => full } as unknown as ConfigService;
}

describe('aiProviderFactory', () => {
  it('returns a disabled provider when no OpenAI key is set', async () => {
    const provider = aiProviderFactory(configWith({ provider: 'openai' }));
    expect(provider.name).toBe('disabled');
    await expect(provider.complete({ messages: [] })).rejects.toThrow(/OPENAI_API_KEY/);
  });

  it('returns a disabled provider when AI_PROVIDER=groq but no Groq key is set', async () => {
    const provider = aiProviderFactory(configWith({ provider: 'groq' }));
    expect(provider.name).toBe('disabled');
    await expect(provider.complete({ messages: [] })).rejects.toThrow(/GROQ_API_KEY/);
  });

  it('builds an OpenAI-backed provider when OPENAI_API_KEY is set', () => {
    const provider = aiProviderFactory(
      configWith({ provider: 'openai', openai: { apiKey: 'sk-test', model: 'gpt-4o', fastModel: 'gpt-4o-mini', baseUrl: undefined } }),
    );
    expect(provider.name).toBe('openai');
  });

  it('builds a Groq-backed provider (OpenAI-compatible client) when AI_PROVIDER=groq and GROQ_API_KEY is set', () => {
    const provider = aiProviderFactory(
      configWith({
        provider: 'groq',
        groq: {
          apiKey: 'gsk-test',
          model: 'openai/gpt-oss-120b',
          fastModel: 'openai/gpt-oss-20b',
          baseUrl: 'https://api.groq.com/openai/v1',
        },
      }),
    );
    expect(provider.name).toBe('groq');
  });

  it('every real provider is wrapped in the privacy guard', () => {
    const provider = aiProviderFactory(
      configWith({ provider: 'openai', openai: { apiKey: 'sk-test', model: 'gpt-4o', fastModel: 'gpt-4o-mini', baseUrl: undefined } }),
    );
    expect(provider).toBeInstanceOf(PrivacyGuardProvider);
  });
});
