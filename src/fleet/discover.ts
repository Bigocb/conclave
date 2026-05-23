/**
 * Conclave Fleet — Runtime Auto-Discovery
 *
 * Probes common local LLM endpoints for available models,
 * inspired by Multica's runtime auto-detection pattern.
 *
 * Usage:
 *   import { discoverLocalModels } from './discover';
 *   const models = await discoverLocalModels();
 *   // [{ provider: 'ollama', model: 'llama-3.1-8b-instant', url: 'http://localhost:11434/v1' }, ...]
 */

const PROBE_TIMEOUT_MS = 2000;

interface ProbeTarget {
  provider: string;
  url: string;
  modelsPath: string;
}

const LOCAL_PROBES: ProbeTarget[] = [
  { provider: 'ollama',  url: 'http://localhost:11434/v1',     modelsPath: '/api/tags' },
  { provider: 'vllm',    url: 'http://localhost:8000/v1',       modelsPath: '/v1/models' },
  { provider: 'litellm', url: 'http://localhost:4000/v1',       modelsPath: '/v1/models' },
  { provider: 'llamacpp',url: 'http://localhost:8080/v1',       modelsPath: '/v1/models' },
  { provider: 'localai', url: 'http://localhost:8080/v1',        modelsPath: '/v1/models' },
];

export interface DiscoveredModel {
  provider: string;
  model: string;
  url: string;
}

/**
 * Probe a single endpoint for available models.
 */
async function probeEndpoint(target: ProbeTarget): Promise<DiscoveredModel[]> {
  const baseUrl = target.url.replace(/\/v1$/, '');
  const modelsUrl = `${baseUrl}${target.modelsPath}`;

  try {
    const resp = await fetch(modelsUrl, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    if (!resp.ok) return [];

    const body = await resp.json() as any;

    // Ollama returns { models: [{ name: "llama3.1:8b", ... }] }
    // OpenAI-compatible returns { data: [{ id: "model-name", ... }] }
    let models: string[] = [];

    if (Array.isArray(body?.data)) {
      models = body.data.map((m: any) => m.id);
    } else if (Array.isArray(body?.models)) {
      models = body.models.map((m: any) => m.name || m.model);
    }

    return models.map(model => ({
      provider: target.provider,
      model,
      url: target.url,
    }));
  } catch {
    // Endpoint not reachable — skip silently
    return [];
  }
}

/**
 * Discover all available local models by probing known endpoints.
 * Returns a flat list of { provider, model, url } objects.
 *
 * Useful for:
 * - Fleet YAML generation: "I have Ollama running with llama3.1 — auto-configure it"
 * - Dashboard "Available Models" panel
 * - Quick health check: which local runtimes are alive?
 */
export async function discoverLocalModels(): Promise<DiscoveredModel[]> {
  const results = await Promise.all(LOCAL_PROBES.map(probeEndpoint));
  return results.flat();
}

/**
 * Check if a specific local provider is reachable.
 */
export async function isProviderAlive(provider: string): Promise<boolean> {
  const target = LOCAL_PROBES.find(p => p.provider === provider);
  if (!target) return false;

  try {
    const resp = await fetch(`${target.url}/models`, {
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    return resp.ok;
  } catch {
    return false;
  }
}