/**
 * Provider Registry
 * Defines the contract for different LLM providers to handle
 * URL resolution and response parsing.
 */

export interface ProviderContract {
  defaultUrl: string;
  parseResponse: (data: any) => string | null;
  adaptPayload?: (payload: any) => any;
}

export const PROVIDER_CONFIGS: Record<string, ProviderContract> = {
  'ollama_cloud': {
    defaultUrl: 'https://ollama.com/api/chat',
    parseResponse: (data) => data.message?.content ?? null,
    adaptPayload: (payload) => ({ ...payload, stream: false }),
  },
  'openai': {
    defaultUrl: 'https://api.openai.com/v1/chat/completions',
    parseResponse: (data) => data.choices?.[0]?.message?.content ?? null,
    adaptPayload: (payload) => payload,
  },
}

export function getProviderConfig(provider: string): ProviderContract {
  return PROVIDER_CONFIGS[provider] || PROVIDER_CONFIGS['openai'];
}
