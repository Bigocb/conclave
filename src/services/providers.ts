
/**
 * Conclave — Provider Service
 * Manages LLM provider configurations and URL resolutions.
 */

export const BUILTIN_PROVIDERS = {
  openai: "https://api.openai.com/v1",
  anthropic: "https://api.anthropic.com",
  openrouter: "https://openrouter.ai/api/v1",
  together: "https://api.together.xyz/v1",
  groq: "https://api.groq.com/openai/v1",
  fireworks: "https://api.fireworks.ai/v1",
  ollama: "http://localhost:11434",
};

export class ProviderService {
  /**
   * Resolve a provider shorthand to its base URL.
   * @param provider The provider name (e.g., 'openai')
   * @returns The base URL or null if not found.
   */
  resolveUrl(provider: string): string | null {
    return BUILTIN_PROVIDERS[provider as keyof typeof BUILTIN_PROVIDERS] || null;
  }

  /**
   * Get a list of all supported built-in providers.
   */
  listBuiltInProviders() {
    return Object.keys(BUILTIN_PROVIDERS);
  }
}

export const providerService = new ProviderService();
