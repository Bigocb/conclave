/**
 * Conclave Fleet — Configuration parser
 *
 * Parses fleet.yaml and resolves environment variable interpolation.
 *
 * Example fleet.yaml:
 *   org_id: org_acme
 *   server: http://localhost:3000
 *   scope: public        # public | private | hybrid
 *
 *   reviewers:
 *     - name: "Code Reviewer"
 *       channels: [code-review]
 *       model: gpt-4o
 *       llm_url: https://api.openai.com/v1
 *       llm_key: ${OPENAI_KEY}
 *       replicas: 2
 *       mode: auto        # auto | human | hybrid
 *       confidence_threshold: 8   # for hybrid mode
 *
 *     - name: "Security Scanner"
 *       channels: [security-review]
 *       model: claude-sonnet-4
 *       llm_url: https://openrouter.ai/api/v1
 *       llm_key: ${OPENROUTER_KEY}
 *       mode: human
 */

import { readFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { parse as parseYaml } from 'yaml';

// ─── Types ──────────────────────────────────────────────────

export type FleetScope = 'public' | 'private' | 'hybrid';
export type ReviewerMode = 'auto' | 'human' | 'hybrid';

/**
 * Built-in provider shortcuts — resolve `provider:` to `llm_url` automatically.
 * To add a custom provider, define it in fleet.yaml under `providers:`.
 */
export const BUILTIN_PROVIDERS: Record<string, string> = {
  openai:    'https://api.openai.com/v1',
  openrouter:'https://openrouter.ai/api/v1',
  ollama:    'http://localhost:11434/v1',
  anthropic: 'https://api.anthropic.com/v1',    // needs proxy for /chat/completions
  together:  'https://api.together.xyz/v1',
  fireworks: 'https://api.fireworks.ai/inference/v1',
  groq:      'https://api.groq.com/openai/v1',
  vllm:      'http://localhost:8000/v1',
  litellm:   'http://localhost:4000/v1',
};

export interface ReviewerConfig {
  name: string;
  channels: string[];
  model: string;
  provider?: string;           // e.g. 'openai', 'ollama', 'custom' — resolves llm_url
  llm_url: string;
  llm_key: string;
  replicas: number;
  mode: ReviewerMode;
  /** For hybrid mode: auto-submit if LLM confidence >= this value */
  confidence_threshold: number;
  /** Custom prompt override (path relative to fleet.yaml) */
  prompt?: string;
  /** Custom instructions for the reviewer agent (injected into system prompt) */
  instructions?: string;
  /** Skill names to inject into the reviewer's context */
  skills?: string[];
  /** Interval in seconds between feed polls */
  interval?: number;
  /** Max concurrent reviews per replica */
  max_concurrent?: number;
}

export interface FleetConfig {
  org_id: string;
  server: string;
  scope: FleetScope;
  providers?: Record<string, string>;  // custom provider name → URL overrides
  reviewers: ReviewerConfig[];
  /** Path to the fleet.yaml for reference */
  config_path: string;
}

// ─── Parser ─────────────────────────────────────────────────

const DEFAULTS: Partial<ReviewerConfig> = {
  replicas: 1,
  mode: 'auto',
  confidence_threshold: 8,
  max_concurrent: 1,
};

/**
 * Interpolate ${ENV_VAR} references in string values.
 */
function interpolateEnv(value: string): string {
  return value.replace(/\$\{([^}]+)\}/g, (_, varName) => {
    const envVal = process.env[varName];
    if (!envVal) {
      console.warn(`⚠️  Environment variable ${varName} is not set — using empty string`);
      return '';
    }
    return envVal;
  });
}

/**
 * Recursively interpolate env vars in all string values of an object.
 */
function interpolateObj(obj: any): any {
  if (typeof obj === 'string') return interpolateEnv(obj);
  if (Array.isArray(obj)) return obj.map(interpolateObj);
  if (obj && typeof obj === 'object') {
    const result: any = {};
    for (const [k, v] of Object.entries(obj)) {
      result[k] = interpolateObj(v);
    }
    return result;
  }
  return obj;
}

/**
 * Validate required fields on a reviewer config.
 */
function validateReviewer(r: any, index: number): void {
  const required = ['name', 'channels', 'model'] as const;
  for (const field of required) {
    if (!r[field]) {
      throw new Error(`Reviewer #${index + 1} ("${r.name || 'unnamed'}"): missing required field "${field}"`);
    }
  }
  // Must have either provider OR llm_url
  if (!r.provider && !r.llm_url) {
    throw new Error(`Reviewer #${index + 1} ("${r.name}"): must specify either "provider" (shortcut) or "llm_url" (full URL)`);
  }
  if (!Array.isArray(r.channels) || r.channels.length === 0) {
    throw new Error(`Reviewer #${index + 1} ("${r.name}"): channels must be a non-empty array`);
  }
  if (r.mode && !['auto', 'human', 'hybrid'].includes(r.mode)) {
    throw new Error(`Reviewer #${index + 1} ("${r.name}"): mode must be auto, human, or hybrid`);
  }
  if (r.scope && !['public', 'private', 'hybrid'].includes(r.scope)) {
    throw new Error(`Reviewer #${index + 1} ("${r.name}"): scope must be public, private, or hybrid`);
  }
}

/**
 * Parse a fleet.yaml file into a FleetConfig.
 */
export function parseFleetConfig(filePath: string): FleetConfig {
  const resolvedPath = resolve(filePath);
  if (!existsSync(resolvedPath)) {
    throw new Error(`Fleet config not found: ${resolvedPath}`);
  }

  const raw = readFileSync(resolvedPath, 'utf-8');
  const parsed = parseYaml(raw);

  if (!parsed.org_id) throw new Error('fleet.yaml: missing required field "org_id"');
  if (!parsed.server) throw new Error('fleet.yaml: missing required field "server"');
  if (!parsed.reviewers || !Array.isArray(parsed.reviewers) || parsed.reviewers.length === 0) {
    throw new Error('fleet.yaml: must have at least one reviewer');
  }

  // Interpolate env vars
  const interpolated = interpolateObj(parsed);

  // Validate each reviewer
  interpolated.reviewers.forEach((r: any, i: number) => validateReviewer(r, i));

  // Resolve provider shortcuts and build reviewers
  const customProviders: Record<string, string> = interpolated.providers ?? {};
  const allProviders = { ...BUILTIN_PROVIDERS, ...customProviders };

  const reviewers: ReviewerConfig[] = interpolated.reviewers.map((r: any) => {
    // Resolve llm_url from provider shortcut
    let llmUrl = r.llm_url;
    if (!llmUrl && r.provider) {
      const resolved = allProviders[r.provider];
      if (!resolved) {
        throw new Error(`Reviewer #${r.name}: unknown provider "${r.provider}". Available: ${Object.keys(allProviders).join(', ')}`);
      }
      llmUrl = resolved;
    }

    return {
      name: r.name,
      channels: r.channels,
      model: r.model,
      provider: r.provider,
      llm_url: llmUrl,
      llm_key: r.llm_key ?? '',
      replicas: r.replicas ?? DEFAULTS.replicas!,
      mode: r.mode ?? DEFAULTS.mode!,
      confidence_threshold: r.confidence_threshold ?? DEFAULTS.confidence_threshold!,
      prompt: r.prompt,
      instructions: r.instructions,
      skills: r.skills,
      interval: r.interval,
      max_concurrent: r.max_concurrent ?? DEFAULTS.max_concurrent!,
    };
  });

  return {
    org_id: interpolated.org_id,
    server: interpolated.server.replace(/\/$/, ''), // strip trailing slash
    scope: interpolated.scope ?? 'public',
    providers: Object.keys(customProviders).length > 0 ? customProviders : undefined,
    reviewers,
    config_path: resolvedPath,
  };
}

/**
 * Generate a principal ID slug from reviewer name.
 * "Code Reviewer" → "prn_code_reviewer"
 */
export function principalSlug(name: string): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
  return `prn_${slug}`;
}

/**
 * Summarize the fleet config for display.
 */
export function summarizeFleetConfig(config: FleetConfig): string {
  const lines = [
    `│ Org:          ${config.org_id}`,
    `│ Server:       ${config.server}`,
    `│ Scope:        ${config.scope}`,
    `│ Reviewers:    ${config.reviewers.length}`,
    '',
  ];

  for (const r of config.reviewers) {
    lines.push(`│  ▸ ${r.name}`);
    lines.push(`│    channels:  ${r.channels.join(', ')}`);
    lines.push(`│    model:     ${r.model}`);
    lines.push(`│    mode:      ${r.mode}${r.mode === 'hybrid' ? ` (threshold: ${r.confidence_threshold})` : ''}`);
    lines.push(`│    replicas:  ${r.replicas}`);
    lines.push(`│    principal: ${principalSlug(r.name)}`);
    if (r.mode === 'human') {
      lines.push(`│    ⚠  Reviews require human approval before submission`);
    }
    lines.push('');
  }

  const totalAgents = config.reviewers.reduce((sum, r) => sum + r.replicas, 0);
  lines.push(`│ Total agents: ${totalAgents}`);

  return lines.join('\n');
}