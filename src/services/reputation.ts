/**
 * Conclave — Reputation service
 * Reputation computation — owned by principals
 */

import { eq, desc, inArray } from 'drizzle-orm';
import * as schema from '../db/schema.js';
import type { ConclaveDb } from '../db/index.js';

export class ReputationService {
  constructor(private db: ConclaveDb) {}

  async getByPrincipal(principalId: string) {
    const snapshots = await this.db.select().from(schema.reputationSnapshots)
      .where(eq(schema.reputationSnapshots.principalId, principalId))
      .orderBy(desc(schema.reputationSnapshots.snapshotAt))
      .limit(1);

    if (snapshots.length === 0) {
      return {
        principal_id: principalId,
        performer: { overall: 0, by_dimension: {}, confidence: 0, total_tasks_completed: 0 },
        reviewer: { overall: 0, alignment_score: 0, helpfulness_score: 0, total_reviews_given: 0 },
      };
    }

    const s = snapshots[0];
    return {
      principal_id: principalId,
      performer: {
        overall: s.performerOverall ?? 0,
        by_dimension: s.performerDimensions ? JSON.parse(s.performerDimensions) : {},
        by_role: s.performerByRole ? JSON.parse(s.performerByRole) : {},
        confidence: s.confidence,
        total_tasks_completed: s.taskCount,
      },
      reviewer: {
        overall: s.reviewerOverall ?? 0,
        alignment_score: s.reviewerAlignment ?? 0,
        helpfulness_score: s.reviewerHelpfulness ?? 0,
        total_reviews_given: s.reviewCount,
      },
      trend: s.trend,
      snapshot_at: s.snapshotAt,
    };
  }

  async getByAgent(agentId: string) {
    const agentRows = await this.db.select().from(schema.agents)
      .where(eq(schema.agents.id, agentId)).limit(1);
    if (agentRows.length === 0) return null;
    return this.getByPrincipal(agentRows[0].principalId);
  }

  async getAgentReputation(agentId: string) {
    return this.getByAgent(agentId);
  }

  async __bulkGetByPrincipals(principalIds: string[]) {
    if (principalIds.length === 0) return [];
    
    const snapshots = await this.db.select().from(schema.reputationSnapshots)
      .where(inArray(schema.reputationSnapshots.principalId, principalIds));

    const latest: Record<string, any> = {};
    for (const s of snapshots) {
      const current = latest[s.principalId];
      if (!current || new Date(s.snapshotAt) > new Date(current.snapshotAt)) {
        latest[s.principalId] = s;
      }
    }

    return principalIds.map(id => {
      const s = latest[id];
      if (!s) return { 
        principal_id: id, 
        performer: { overall: 0, by_dimension: {}, confidence: 0, total_tasks_completed: 0 }, 
        reviewer: { overall: 0, alignment_score: 0, helpfulness_score: 0, total_reviews_given: 0 } 
      };
      return {
        principal_id: id,
        performer: { 
          overall: s.performerOverall ?? 0, 
          by_dimension: s.performerDimensions ? JSON.parse(s.performerDimensions) : {}, 
          by_role: s.performerByRole ? JSON.parse(s.performerByRole) : {}, 
          confidence: s.confidence, 
          total_tasks_completed: s.taskCount 
        },
        reviewer: { 
          overall: s.reviewerOverall ?? 0, 
          alignment_score: s.reviewerAlignment ?? 0, 
          helpfulness_score: s.reviewerHelpfulness ?? 0, 
          total_reviews_given: s.reviewCount 
        },
        trend: s.trend,
        snapshot_at: s.snapshotAt,
      };
    });
  }

  async computeAndSnapshot(principalId: string) {
    // Get all reviews received by this principal's tasks
    const principalTasks = await this.db.select().from(schema.tasks)
      .where(eq(schema.tasks.principalId, principalId));
    const taskIds = principalTasks.map(t => t.id);

    let performerOverall = 0;
    let performerDimensions: Record<string, number> = {};
    let totalReviews = 0;
    let totalWeight = 0;

    if (taskIds.length > 0) {
      const now = Date.now();
      for (const taskId of taskIds) {
        const taskReviews = await this.db.select().from(schema.reviews)
          .where(eq(schema.reviews.taskId, taskId));
        for (const review of taskReviews) {
          const scores: Record<string, number> = JSON.parse(review.scores);
          // Time-decay: 90-day half-life per protocol spec §9.4
          const ageDays = (now - new Date(review.createdAt).getTime()) / 86400000;
          const timeDecay = Math.pow(0.5, ageDays / 90);
          const effectiveWeight = review.reviewerConfidence * timeDecay;
          for (const [dim, score] of Object.entries(scores)) {
            performerDimensions[dim] = (performerDimensions[dim] ?? 0) + score * effectiveWeight;
          }
          performerOverall += review.weightedOverall * effectiveWeight;
          totalWeight += effectiveWeight;
          totalReviews++;
        }
      }

      if (totalWeight > 0) {
        performerOverall /= totalWeight;
        for (const dim of Object.keys(performerDimensions)) {
          performerDimensions[dim] /= totalWeight;
        }
      }
    }

    // Get reviews given by this principal
    const givenReviews = await this.db.select().from(schema.reviews)
      .where(eq(schema.reviews.principalId, principalId));

    let reviewerOverall = 0;
    if (givenReviews.length > 0) {
      reviewerOverall = givenReviews.reduce((sum, r) => sum + r.weightedOverall, 0) / givenReviews.length;
    }

    const confidence = Math.min(1, totalReviews / 10);

    // Write snapshot
    const id = `rps_${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`;
    await this.db.insert(schema.reputationSnapshots).values({
      id,
      principalId,
      performerOverall: Math.round(performerOverall * 100) / 100,
      performerDimensions: JSON.stringify(performerDimensions),
      performerByRole: JSON.stringify({}),
      reviewerOverall: Math.round(reviewerOverall * 100) / 100,
      reviewerAlignment: 0,
      reviewerHelpfulness: 0,
      reviewCount: givenReviews.length,
      taskCount: principalTasks.length,
      confidence: Math.round(confidence * 100) / 100,
      trend: 'stable',
      snapshotAt: new Date().toISOString(),
    });

    return this.getByPrincipal(principalId);
  }

  async getLeaderboard(dimension?: string, limit: number = 20) {
    // For now, return all principals with their latest reputation
    const allPrincipals = await this.db.select().from(schema.principals)
      .where(eq(schema.principals.status, 'active'));

    const entries = [];
    for (const p of allPrincipals) {
      const rep = await this.getByPrincipal(p.id);
      const score = dimension
        ? rep.performer.by_dimension[dimension] ?? rep.performer.overall
        : rep.performer.overall;
      entries.push({
        principal_id: p.id,
        name: p.name,
        score,
        confidence: rep.performer.confidence,
      });
    }

    entries.sort((a, b) => b.score - a.score);
    return entries.slice(0, limit);
  }
}