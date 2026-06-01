/**
 * Conclave — Provider Routes
 * List available LLM providers and fetch their models.
 */

import type { FastifyInstance } from 'fastify';
import { BUILTIN_PROVIDERS } from '../fleet/config.js';

export async function providerRoutes(fastify: FastifyInstance) {
  // GET /v1/providers — list all configured providers with their base URLs
  fastify.get('/providers', async (_request, reply) => {
    const providers = Object.entries(BUILTIN_PROVIDERS).map(([name, url]) => ({
      name,
      url,
      builtin: true,
    }));

    // Include any custom providers configured in the database (future: org-level overrides)
    // For now, also expose env-configured keys
    const envProviders: Record<string, string> = {};
    if (process.env.OPENAI_API_KEY) envProviders.openai = 'https://api.openai.com/v1';
    if (process.env.OLLAMA_KEY) envProviders.ollama_cloud = 'https://ollama.com/api/chat';
    if (process.env.ANTHROPIC_API_KEY) envProviders.anthropic = 'https://api.anthropic.com/v1';
    if (process.env.OPENROUTER_API_KEY) envProviders.openrouter = 'https://openrouter.ai/api/v1';

    return reply.send({
      status: 'success',
      data: {
        providers,
        configured: Object.keys(envProviders),
      },
    });
  });

  // GET /v1/providers/:provider/models — fetch available models from a provider
  fastify.get<{ Params: { provider: string } }>('/providers/:provider/models', async (request, reply) => {
    const { provider } = request.params;

    // Resolve the base URL for this provider
    const baseUrl = BUILTIN_PROVIDERS[provider] as string | undefined;
    if (!baseUrl) {
      return reply.code(404).send({
        status: 'error',
        error: { code: 'PROVIDER_NOT_FOUND', message: `Provider '${provider}' not found. Available: ${Object.keys(BUILTIN_PROVIDERS).join(', ')}` },
      });
    }

    // Resolve auth key
    const keyMap: Record<string, string | undefined> = {
      openai: process.env.OPENAI_API_KEY,
      openrouter: process.env.OPENROUTER_API_KEY,
      ollama_cloud: process.env.OLLAMA_KEY,
      anthropic: process.env.ANTHROPIC_API_KEY,
      together: process.env.TOGETHER_API_KEY,
      fireworks: process.env.FIREWORKS_API_KEY,
      groq: process.env.GROQ_API_KEY,
      ollama: undefined, // local, no key needed
      vllm: undefined,
      custom: undefined,
    };

    const apiKey = keyMap[provider];

    try {
      const fetchUrl = `${baseUrl.replace(/\/$/, '')}/models`;
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
      };
      if (apiKey) {
        headers['Authorization'] = `Bearer ${apiKey}`;
      }

      const response = await fetch(fetchUrl, { headers, signal: AbortSignal.timeout(10_000) });

      if (!response.ok) {
        const body = await response.text().catch(() => '');
        return reply.code(response.status).send({
          status: 'error',
          error: {
            code: 'PROVIDER_ERROR',
            message: `Provider '${provider}' returned ${response.status}: ${body.slice(0, 200)}`,
          },
        });
      }

      const body = await response.json() as any;
      const models = (body.data || body.models || []).map((m: any) => ({
        id: m.id || m.name || m.model,
        provider,
        owned_by: m.owned_by || m.owner || null,
        created: m.created || null,
      }));

      return reply.send({
        status: 'success',
        data: models,
      });
    } catch (err: any) {
      return reply.code(502).send({
        status: 'error',
        error: {
          code: 'PROVIDER_UNREACHABLE',
          message: `Could not reach provider '${provider}': ${err.message}`,
        },
      });
    }
  });
}