/**
 * Conclave — ACP (Agent-Clue Protocol) Zod schemas
 * Payload types for opinion discussion nodes and edges
 */

import { z } from 'zod';

// ─── Enums ─────────────────────────────────────────────────────────

export const NodeKind = z.enum(['proposal', 'critique', 'synthesis', 'consensus']);
export type NodeKind = z.infer<typeof NodeKind>;

export const EdgeKind = z.enum(['critiques', 'addresses', 'votes_on', 'follow_up']);
export type EdgeKind = z.infer<typeof EdgeKind>;

export const NodeStatus = z.enum(['active', 'superseded', 'withdrawn']);
export type NodeStatus = z.infer<typeof NodeStatus>;

export const OpinionStatus = z.enum(['open', 'synthesizing', 'voting', 'closed']);
export type OpinionStatus = z.infer<typeof OpinionStatus>;

export const TopologyKind = z.enum(['democratic']);
export type TopologyKind = z.infer<typeof TopologyKind>;

// ─── Node Content Schemas ──────────────────────────────────────────

export const ProposalContent = z.object({
  question: z.string().min(1),
  context: z.string().optional(),
});
export type ProposalContent = z.infer<typeof ProposalContent>;

export const CritiqueContent = z.object({
  concerns: z.array(z.string()).min(1),
  suggestions: z.array(z.string()).optional(),
  confidence: z.number().min(0).max(1),
});
export type CritiqueContent = z.infer<typeof CritiqueContent>;

export const SynthesisContent = z.object({
  response: z.string().min(1),
  addressed_concerns: z.array(z.string()),
  reasoning: z.string().optional(),
});
export type SynthesisContent = z.infer<typeof SynthesisContent>;

export const ConsensusContent = z.object({
  approved: z.boolean(),
  confidence: z.number().min(0).max(1),
  notes: z.string().optional(),
});
export type ConsensusContent = z.infer<typeof ConsensusContent>;

// ─── Union of all node contents ────────────────────────────────────

export const NodeContent = z.union([
  ProposalContent,
  CritiqueContent,
  SynthesisContent,
  ConsensusContent,
]);
export type NodeContent = z.infer<typeof NodeContent>;

// ─── Create / Response Schemas ─────────────────────────────────────

export const CreateNodeSchema = z.object({
  kind: NodeKind,
  content: z.record(z.unknown()),
  parent_edge_kind: EdgeKind.optional(),
  parent_node_id: z.string().optional(),
});

export type CreateNodeInput = z.infer<typeof CreateNodeSchema>;

export const GraphQuerySchema = z.object({
  include_status: z.array(NodeStatus).optional(),
  depth: z.number().int().min(1).max(5).optional().default(5),
});

export type GraphQueryInput = z.infer<typeof GraphQuerySchema>;