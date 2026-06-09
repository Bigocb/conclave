/**
 * Conclave — Zod validation schemas for all API inputs
 */

import { z } from 'zod';

// ─── Common ──────────────────────────────────────────────────────

const uuidPrefix = z.string().regex(/^(agt|org|prn|tsk|rev|opn|rsp|ch|bhd)_/);

export const PaginationSchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

// ─── Organizations ───────────────────────────────────────────────

export const CreateOrgSchema = z.object({
  name: z.string().min(1).max(200),
  slug: z.string().min(1).max(50).regex(/^[a-z0-9-]+$/).optional(),
  description: z.string().max(2000).optional(),
  policies: z.object({
    min_reviews_required: z.number().int().min(1).max(10).default(2),
    channels: z.array(z.string()).optional(),
    allowed_models: z.array(z.string()).nullable().optional(),
  }).optional(),
});

export const UpdateOrgSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  description: z.string().max(2000).optional(),
  policies: z.object({
    min_reviews_required: z.number().int().min(1).max(10).optional(),
    channels: z.array(z.string()).optional(),
    allowed_models: z.array(z.string()).nullable().optional(),
  }).optional(),
});

// ─── Principals ──────────────────────────────────────────────────

export const CreatePrincipalSchema = z.object({
  name: z.string().min(1).max(200),
  org_id: z.string(),
  roles: z.array(z.string()).min(1).default(['general-reviewer']),
  capabilities: z.array(z.string()).optional(),
  metadata: z.record(z.unknown()).optional(),
});

export const UpdatePrincipalSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  roles: z.array(z.string()).optional(),
  capabilities: z.array(z.string()).optional(),
  metadata: z.record(z.unknown()).optional(),
});

// ─── Agents ──────────────────────────────────────────────────────

export const RegisterAgentSchema = z.object({
  principal_id: z.string(),
  name: z.string().min(1).max(200),
  type: z.enum(['llm', 'slim', 'code', 'pipeline']).default('llm'),
  model: z.string().nullable().optional().transform(v => v || undefined),
  provider: z.preprocess(v => (!v || v === '' || v === null) ? undefined : v === 'ollama-cloud' ? 'ollama_cloud' : v, z.enum(['openai', 'openrouter', 'ollama', 'ollama_cloud', 'anthropic', 'together', 'fireworks', 'groq', 'vllm', 'litellm', 'custom', 'opencode']).optional()),
  llm_url: z.string().nullable().optional().transform(v => v || undefined),
  api_key: z.string().optional(),
  command: z.string().max(2000).nullable().optional().transform(v => v || undefined),
  instructions: z.string().max(4000).nullable().optional().transform(v => v || undefined),
  skills: z.array(z.string()).nullable().optional().transform(v => v ?? undefined),
});

export const UpdateAgentSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  type: z.enum(['llm', 'slim', 'code', 'pipeline']).optional(),
  model: z.string().nullable().optional().transform(v => v ?? undefined),
  provider: z.preprocess(v => (!v || v === '' || v === null) ? undefined : v === 'ollama-cloud' ? 'ollama_cloud' : v, z.enum(['openai', 'openrouter', 'ollama', 'ollama_cloud', 'anthropic', 'together', 'fireworks', 'groq', 'vllm', 'litellm', 'custom', 'opencode']).optional()),
  llm_url: z.string().nullable().optional().transform(v => v ?? undefined),
  command: z.string().max(2000).nullable().optional().transform(v => v ?? undefined),
  instructions: z.string().max(4000).nullable().optional().transform(v => v ?? undefined),
  skills: z.array(z.string()).nullable().optional().transform(v => v ?? undefined),
});

export const PatchAgentSchema = z.object({
  type: z.enum(['llm', 'slim', 'code', 'pipeline']).optional(),
  model: z.string().nullable().optional().transform(v => v ?? undefined),
  provider: z.preprocess(v => (!v || v === '' || v === null) ? undefined : v === 'ollama-cloud' ? 'ollama_cloud' : v, z.enum(['openai', 'openrouter', 'ollama', 'ollama_cloud', 'anthropic', 'together', 'fireworks', 'groq', 'vllm', 'litellm', 'custom']).optional()),
  llm_url: z.string().nullable().optional().transform(v => v ?? undefined),
  instructions: z.string().max(4000).nullable().optional().transform(v => v ?? undefined),
  skills: z.array(z.string()).nullable().optional().transform(v => v ?? undefined),
  command: z.string().max(2000).nullable().optional().transform(v => v ?? undefined),
}).refine(data => Object.keys(data).length > 0, {
  message: 'At least one field must be provided for partial update',
});

export const AgentQuerySchema = z.object({
  role: z.string().optional(),
  capability: z.string().optional(),
  min_reputation: z.coerce.number().min(0).max(10).optional(),
  dimension: z.string().optional(),
  org: z.string().optional(),
  principal: z.string().optional(),
  status: z.enum(['active', 'decommissioned', 'all']).optional(),
  page: z.coerce.number().int().min(1).default(1),
  per_page: z.coerce.number().int().min(1).max(100).default(20),
});

// ─── Tasks ───────────────────────────────────────────────────────

export const CreateTaskSchema = z.object({
  task_description: z.string().min(10).max(10000),
  dimensions: z.array(z.string()).min(1).default(['quality', 'completeness', 'correctness']),
  output: z.string().min(1).max(100000),
  output_format: z.enum(['markdown', 'json', 'text', 'code']).default('markdown'),
  channel: z.string().default('general-qa'),
  requested_reviews: z.number().int().min(1).max(10).default(3),
  deadline: z.string().datetime().optional(),
  priority: z.enum(['normal', 'priority']).default('normal'),
  metadata: z.record(z.unknown()).optional(),
});

export const SubmitReviewSchema = z.object({
  scores: z.record(z.number().int().min(1).max(10)),
  weighted_overall: z.number().min(1).max(10),
  reviewer_confidence: z.number().min(0).max(1),
  comment: z.string().min(20).max(1500, 'Comment must be under ~200 words (1500 chars)'),
  suggestions: z.array(z.string()).optional(),
  approved: z.boolean().default(false),
});

export const MarkHelpfulSchema = z.object({
  review_id: z.string(),
  helpful: z.boolean(),
});

// ─── Opinions ────────────────────────────────────────────────────

export const AskOpinionSchema = z.object({
  question: z.string().min(10).max(5000),
  context: z.string().max(10000).optional(),
  channel: z.string().default('general-qa'),
  requested_critics: z.number().int().min(1).max(10).default(3),
  deadline: z.string().datetime().optional(),
  principal_id: z.string().optional(),
  metadata: z.record(z.unknown()).optional(),
});

export const SubmitOpinionResponseSchema = z.object({
  response: z.string().min(20).max(1500, 'Response must be under ~200 words (1500 chars)'),
  confidence: z.number().min(0).max(1),
  reasoning: z.string().max(1500).optional(),
  references: z.array(z.string()).optional(),
  metadata: z.record(z.unknown()).optional(),
});

// ─── Channels ────────────────────────────────────────────────────

export const CreateChannelSchema = z.object({
  name: z.string().min(1).max(100).regex(/^[a-z0-9-]+$/),
  description: z.string().max(500).optional(),
  default_dimensions: z.array(z.string()).optional(),
});

// ─── Spot Checks ─────────────────────────────────────────────────

export const SpotCheckSchema = z.object({
  review_id: z.string(),
  accuracy: z.number().int().min(1).max(10),
  fairness: z.number().int().min(1).max(10),
  comment: z.string().max(2000).optional(),
  dimensions_override: z.record(z.number()).optional(),
});

// ─── Response Envelope ────────────────────────────────────────────

export const ResponseMetaSchema = z.object({
  request_id: z.string(),
  timestamp: z.string().datetime(),
  rate_limit_remaining: z.number().int().optional(),
});

// ─── Type Exports ────────────────────────────────────────────────

export type CreateOrgInput = z.infer<typeof CreateOrgSchema>;
export type UpdateOrgInput = z.infer<typeof UpdateOrgSchema>;
export type CreatePrincipalInput = z.infer<typeof CreatePrincipalSchema>;
export type UpdatePrincipalInput = z.infer<typeof UpdatePrincipalSchema>;
export type RegisterAgentInput = z.infer<typeof RegisterAgentSchema>;
export type UpdateAgentInput = z.infer<typeof UpdateAgentSchema>;
export type PatchAgentInput = z.infer<typeof PatchAgentSchema>;
export type AgentQueryInput = z.infer<typeof AgentQuerySchema>;
export type CreateTaskInput = z.infer<typeof CreateTaskSchema>;
export type SubmitReviewInput = z.infer<typeof SubmitReviewSchema>;
export type MarkHelpfulInput = z.infer<typeof MarkHelpfulSchema>;
export type AskOpinionInput = z.infer<typeof AskOpinionSchema>;
export type SubmitOpinionResponseInput = z.infer<typeof SubmitOpinionResponseSchema>;
// ─── API Keys ────────────────────────────────────────────────────

export const CreateApiKeySchema = z.object({
  name: z.string().min(1).max(200),
  permission: z.enum(['read', 'write', 'admin']).default('write'),
});

export type CreateApiKeyInput = z.infer<typeof CreateApiKeySchema>;

export type CreateChannelInput = z.infer<typeof CreateChannelSchema>;
export type SpotCheckInput = z.infer<typeof SpotCheckSchema>;

// ─── ACP (Agent-Clue Protocol) ────────────────────────────────────
export { CreateNodeSchema, GraphQuerySchema, NodeKind, EdgeKind, NodeStatus, OpinionStatus, TopologyKind } from './acp.js';
export type { CreateNodeInput, GraphQueryInput, NodeContent, ProposalContent, CritiqueContent, SynthesisContent, ConsensusContent } from './acp.js';