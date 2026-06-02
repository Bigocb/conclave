/**
 * Conclave — Blackboard service
 * CRUD for opinion discussion graph (nodes + edges)
 */

import { eq, and, desc } from 'drizzle-orm';
import * as schema from '../db/schema.js';
import type { ConclaveDb } from '../db/index.js';

export interface CreateNodeInput {
  id: string;
  opinionId: string;
  agentId: string;
  principalId: string;
  kind: 'proposal' | 'critique' | 'synthesis' | 'consensus';
  payload: Record<string, unknown>;
}

export interface CreateEdgeInput {
  id: string;
  opinionId: string;
  sourceNodeId: string;
  targetNodeId: string;
  kind: 'critiques' | 'addresses' | 'votes_on' | 'follow_up';
}

export class BlackboardService {
  constructor(private db: ConclaveDb) {}

  // ─── Node CRUD ────────────────────────────────────────────

  async createNode(data: CreateNodeInput) {
    const now = new Date().toISOString();
    await this.db.insert(schema.blackboardNodes).values({
      id: data.id,
      opinionId: data.opinionId,
      agentId: data.agentId,
      principalId: data.principalId,
      kind: data.kind,
      status: 'active',
      payload: JSON.stringify(data.payload),
      createdAt: now,
    });
    return this.getNodeById(data.id);
  }

  async getNodeById(id: string) {
    const rows = await this.db.select().from(schema.blackboardNodes).where(eq(schema.blackboardNodes.id, id)).limit(1);
    if (rows.length === 0) return null;
    return this.formatNode(rows[0]);
  }

  async getNodesForOpinion(opinionId: string) {
    const rows = await this.db.select()
      .from(schema.blackboardNodes)
      .where(eq(schema.blackboardNodes.opinionId, opinionId))
      .orderBy(desc(schema.blackboardNodes.createdAt));
    return rows.map(n => this.formatNode(n));
  }

  async updateNodeStatus(id: string, status: 'active' | 'superseded' | 'withdrawn') {
    await this.db.update(schema.blackboardNodes)
      .set({ status })
      .where(eq(schema.blackboardNodes.id, id));
    return this.getNodeById(id);
  }

  // ─── Edge CRUD ────────────────────────────────────────────

  async createEdge(data: CreateEdgeInput) {
    const now = new Date().toISOString();
    await this.db.insert(schema.blackboardEdges).values({
      id: data.id,
      opinionId: data.opinionId,
      sourceNodeId: data.sourceNodeId,
      targetNodeId: data.targetNodeId,
      kind: data.kind,
      createdAt: now,
    });
    return this.getEdgeById(data.id);
  }

  async getEdgeById(id: string) {
    const rows = await this.db.select().from(schema.blackboardEdges).where(eq(schema.blackboardEdges.id, id)).limit(1);
    if (rows.length === 0) return null;
    return this.formatEdge(rows[0]);
  }

  async getEdgesForOpinion(opinionId: string) {
    const rows = await this.db.select()
      .from(schema.blackboardEdges)
      .where(eq(schema.blackboardEdges.opinionId, opinionId));
    return rows.map(e => this.formatEdge(e));
  }

  async getOutgoingEdges(sourceNodeId: string) {
    const rows = await this.db.select()
      .from(schema.blackboardEdges)
      .where(eq(schema.blackboardEdges.sourceNodeId, sourceNodeId));
    return rows.map(e => this.formatEdge(e));
  }

  // ─── Graph Queries ────────────────────────────────────────

  /**
   * Build a graph representation for an opinion: nodes + edges
   */
  async getGraph(opinionId: string) {
    const nodes = await this.getNodesForOpinion(opinionId);
    const edges = await this.getEdgesForOpinion(opinionId);
    return { nodes, edges };
  }

  /**
   * Check if consensus has been reached for an opinion.
   * Democratic consensus: all ConsensusNodes for this opinion have approved=true.
   */
  async checkConsensus(opinionId: string): Promise<{ reached: boolean; details: any }> {
    const nodes = await this.db.select()
      .from(schema.blackboardNodes)
      .where(and(
        eq(schema.blackboardNodes.opinionId, opinionId),
        eq(schema.blackboardNodes.kind, 'consensus'),
      ));

    if (nodes.length === 0) {
      return { reached: false, details: { reason: 'no_consensus_nodes' } };
    }

    const results = nodes.map(n => {
      const payload = JSON.parse(n.payload);
      return {
        nodeId: n.id,
        approved: payload.approved === true,
        confidence: payload.confidence ?? 0,
      };
    });

    const allApproved = results.every(r => r.approved);
    const avgConfidence = results.reduce((s, r) => s + r.confidence, 0) / results.length;

    return {
      reached: allApproved,
      details: {
        total_votes: results.length,
        approved: results.filter(r => r.approved).length,
        rejected: results.filter(r => !r.approved).length,
        avg_confidence: Math.round(avgConfidence * 100) / 100,
        votes: results,
      },
    };
  }

  // ─── Formatters ───────────────────────────────────────────

  private formatNode(row: typeof schema.blackboardNodes.$inferSelect) {
    return {
      id: row.id,
      opinion_id: row.opinionId,
      agent_id: row.agentId,
      principal_id: row.principalId,
      kind: row.kind,
      status: row.status,
      payload: JSON.parse(row.payload),
      created_at: row.createdAt,
    };
  }

  private formatEdge(row: typeof schema.blackboardEdges.$inferSelect) {
    return {
      id: row.id,
      opinion_id: row.opinionId,
      source_node_id: row.sourceNodeId,
      target_node_id: row.targetNodeId,
      kind: row.kind,
      created_at: row.createdAt,
    };
  }
}