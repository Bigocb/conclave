/**
 * Provider Registry
 * Maps LLM provider names to their full contract:
 *   - defaultUrl: Base URL for API calls
 *   - parseResponse: Extracts text content from provider-specific JSON
 *   - adaptPayload: Transforms a standard payload into provider-specific format
 *   - authHeader: How the API key is passed (Authorization header style)
 */

export interface ProviderContract {
  defaultUrl: string;
  parseResponse: (data: any) => string | null;
  adaptPayload?: (payload: any) => any;
  authHeader: (key: string) => Record<string, string>;
}

export const PROVIDER_CONFIGS: Record<string, ProviderContract> = {
  // ─── OpenAI-compatible (default fallback) ────────────────────
  openai: {
    defaultUrl: 'https://api.openai.com/v1/chat/completions',
    parseResponse: (data) => data.choices?.[0]?.message?.content ?? null,
    adaptPayload: (payload) => ({ ...payload, stream: false }),
    authHeader: (key) => ({ Authorization: `Bearer ${key}` }),
  },

  // ─── Anthropic ─────────────────────────────────────────────
  anthropic: {
    defaultUrl: 'https://api.anthropic.com/v1/messages',
    parseResponse: (data) => data.content?.[0]?.text ?? null,
    adaptPayload: (payload) => {
      const { messages, ...rest } = payload;
      // Anthropic requires separate system prompt and uses a different message format
      const systemMessage = messages?.find((m: any) => m.role === 'system');
      const userMessages = messages?.filter((m: any) => m.role !== 'system') ?? [];
      return {
        ...rest,
        model: rest.model || 'claude-sonnet-4-20250514',
        system: systemMessage?.content ?? '',
        messages: userMessages,
        max_tokens: rest.max_tokens ?? 1500,
      };
    },
    authHeader: (key) => ({ 'x-api-key': key, 'anthropic-version': '2023-06-01' }),
  },

  // ─── Groq (OpenAI-compatible, fast inference) ──────────────
  groq: {
    defaultUrl: 'https://api.groq.com/openai/v1/chat/completions',
    parseResponse: (data) => data.choices?.[0]?.message?.content ?? null,
    adaptPayload: (payload) => ({ ...payload, stream: false }),
    authHeader: (key) => ({ Authorization: `Bearer ${key}` }),
  },

  // ─── OpenRouter (aggregator, OpenAI-compatible) ────────────
  openrouter: {
    defaultUrl: 'https://openrouter.ai/api/v1/chat/completions',
    parseResponse: (data) => data.choices?.[0]?.message?.content ?? null,
    adaptPayload: (payload) => ({
      ...payload,
      stream: false,
      transforms: ['strip-echo'],
    }),
    authHeader: (key) => ({ Authorization: `Bearer ${key}` }),
  },

  // ─── Google Gemini ─────────────────────────────────────────
  google: {
    defaultUrl: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
    parseResponse: (data) => data.choices?.[0]?.message?.content ?? null,
    adaptPayload: (payload) => ({ ...payload, stream: false }),
    authHeader: (key) => ({ Authorization: `Bearer ${key}` }),
  },

  // ─── Mistral ───────────────────────────────────────────────
  mistral: {
    defaultUrl: 'https://api.mistral.ai/v1/chat/completions',
    parseResponse: (data) => data.choices?.[0]?.message?.content ?? null,
    adaptPayload: (payload) => ({ ...payload, stream: false }),
    authHeader: (key) => ({ Authorization: `Bearer ${key}` }),
  },

  // ─── DeepSeek ──────────────────────────────────────────────
  deepseek: {
    defaultUrl: 'https://api.deepseek.com/v1/chat/completions',
    parseResponse: (data) => data.choices?.[0]?.message?.content ?? null,
    adaptPayload: (payload) => ({ ...payload, stream: false }),
    authHeader: (key) => ({ Authorization: `Bearer ${key}` }),
  },

  // ─── Ollama (local/self-hosted) ────────────────────────────
  ollama: {
    defaultUrl: 'http://localhost:11434/api/chat',
    parseResponse: (data) => data.message?.content ?? null,
    adaptPayload: (payload) => ({ ...payload, stream: false }),
    authHeader: () => ({}), // No auth for local Ollama
  },

  // ─── Ollama Cloud ──────────────────────────────────────────
  ollama_cloud: {
    defaultUrl: 'https://ollama.com/api/chat',
    parseResponse: (data) => data.message?.content ?? null,
    adaptPayload: (payload) => ({ ...payload, stream: false }),
    authHeader: (key) => {
      const headers: Record<string, string> = {};
      if (key) headers.Authorization = `Bearer ${key}`;
      return headers;
    },
  },

  // ─── xAI (Grok) ───────────────────────────────────────────
  xai: {
    defaultUrl: 'https://api.x.ai/v1/chat/completions',
    parseResponse: (data) => data.choices?.[0]?.message?.content ?? null,
    adaptPayload: (payload) => ({ ...payload, stream: false }),
    authHeader: (key) => ({ Authorization: `Bearer ${key}` }),
  },

  // ─── Cohere ────────────────────────────────────────────────
  cohere: {
    defaultUrl: 'https://api.cohere.ai/v1/chat/completions',
    parseResponse: (data) => data.choices?.[0]?.message?.content ?? null,
    adaptPayload: (payload) => ({ ...payload, stream: false }),
    authHeader: (key) => ({ Authorization: `Bearer ${key}` }),
  },
};

/**
 * Resolve a provider name to its contract.
 * Falls back to OpenAI-compatible for unknown providers.
 */
export function getProviderConfig(provider: string): ProviderContract {
  return PROVIDER_CONFIGS[provider] || PROVIDER_CONFIGS['openai'];
}

/**
 * Resolve the final LLM URL for a reviewer.
 * Priority: explicit url > provider default > openai default
 */
export function resolveLlmUrl(provider: string | null | undefined, explicitUrl?: string | null): string {
  if (explicitUrl) return explicitUrl;
  const config = getProviderConfig(provider || 'openai');
  return config.defaultUrl;
}

/**
 * Build auth headers for a provider + key combo.
 * Falls back to Bearer token for unknown providers.
 */
export function buildAuthHeaders(provider: string | null | undefined, apiKey: string): Record<string, string> {
  const config = getProviderConfig(provider || 'openai');
  return config.authHeader(apiKey);
}