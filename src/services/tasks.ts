/**
 * Conclave — Task service
 * CRUD and lifecycle operations for tasks and reviews
 */

import { eq, and, desc, inArray } from 'drizzle-orm';
import * as schema from '../db/schema.js';
import type { ConclaveDb } from '../db/index.js';
import { BUDGET } from '../services/budget.js';

export class TaskService {
  constructor(private db: ConclaveDb, private budgetService?: any) {}

  async create(data: {
    id: string;
    agentId: string;
    principalId: string;
    description: string;
    dimensions: string[];
    output: string;
    outputFormat?: string;
    channel: string;
    requestedReviews?: number;
    deadline?: string;
    priority?: string;
    metadata?: Record<string, unknown>;
    budgetSpent?: number;
  }) {
    const now = new Date().toISOString();
    await this.db.insert(schema.tasks).values({
      id: data.id,
      agentId: data.agentId,
      principalId: data.principalId,
      description: data.description,
      dimensions: JSON.stringify(data.dimensions),
      output: data.output,
      outputFormat: data.outputFormat ?? 'markdown',
      channel: data.channel,
      requestedReviews: data.requestedReviews ?? 3,
      deadline: data.deadline ?? null,
      priority: data.priority ?? 'normal',
      status: 'open',
      metadata: data.metadata ? JSON.stringify(data.metadata) : null,
      budgetSpent: data.budgetSpent ?? 5,
      createdAt: now,
      updatedAt: now,
    });
    return this.getById(data.id);
  }

  async getById(id: string) {
    const rows = await this.db.select().from(schema.tasks).where(eq(schema.tasks.id, id)).limit(1);
    if (rows.length === 0) return null;
    return this.formatTask(rows[0]);
  }

  async list(filters: { status?: string; channel?: string; agentId?: string; principalId?: string; orgId?: string } = {}) {
    const conditions = [];
    if (filters.status) conditions.push(eq(schema.tasks.status, filters.status));
    if (filters.channel) conditions.push(eq(schema.tasks.channel, filters.channel));
    if (filters.agentId) conditions.push(eq(schema.tasks.agentId, filters.agentId));
    if (filters.principalId) conditions.push(eq(schema.tasks.principalId, filters.principalId));

    if (filters.orgId) {
      // Get all agent IDs for this org, then filter tasks
      const orgAgents = await this.db.select({ id: schema.agents.id })
        .from(schema.agents)
        .where(eq(schema.agents.orgId, filters.orgId as any));
      const agentIds = orgAgents.map(a => a.id);
      if (agentIds.length === 0) return []; // No agents in this org → no tasks
      conditions.push(inArray(schema.tasks.agentId, agentIds));
    }

    const rows = conditions.length > 0
      ? await this.db.select().from(schema.tasks).where(and(...conditions)).orderBy(desc(schema.tasks.createdAt)).limit(50)
      : await this.db.select().from(schema.tasks).orderBy(desc(schema.tasks.createdAt)).limit(50);
    
    // Enrich each task with reviews_received count
    const enriched = await Promise.all(rows.map(async r => {
      const reviewCount = await this.getReviewCountForTask(r.id);
      const task = this.formatTask(r);
      return { ...task, reviews_received: reviewCount };
    }));
    return enriched;
  }

  async updateStatus(id: string, status: string) {
    await this.db.update(schema.tasks)
      .set({ status, updatedAt: new Date().toISOString() })
      .where(eq(schema.tasks.id, id));
    return this.getById(id);
  }

  // ─── Reviews ───────────────────────────────────────────────────

  async submitReview(data: {
    id: string;
    taskId: string;
    reviewerId: string;
    principalId: string;
    scores: Record<string, number>;
    weightedOverall: number;
    reviewerConfidence: number;
    comment: string;
    suggestions?: string[];
    approved?: boolean;
  }) {
    // DUPLICATE_REVIEW enforcement: one review per (task, principal)
    const existing = await this.db.select().from(schema.reviews)
      .where(and(
        eq(schema.reviews.taskId, data.taskId),
        eq(schema.reviews.principalId, data.principalId),
      ))
      .limit(1);
    if (existing.length > 0) {
      throw new Error('DUPLICATE_REVIEW: this principal has already reviewed this task');
    }

    const now = new Date().toISOString();
    await this.db.insert(schema.reviews).values({
      id: data.id,
      taskId: data.taskId,
      reviewerId: data.reviewerId,
      principalId: data.principalId,
      scores: JSON.stringify(data.scores),
      weightedOverall: data.weightedOverall,
      reviewerConfidence: data.reviewerConfidence,
      comment: data.comment,
      suggestions: data.suggestions ? JSON.stringify(data.suggestions) : null,
      approved: data.approved ? 1 : 0,
      helpful: null,
      createdAt: now,
    });

    // Update task status: open → in_review (first review), in_review → completed (enough reviews)
    const task = await this.getById(data.taskId);
    if (task) {
      if (task.status === 'open') {
        await this.updateStatus(data.taskId, 'in_review');
      }
      // Check if we've hit the requested review count → complete the task + award bonuses
      const reviewCount = await this.getReviewCountForTask(data.taskId);
      if (reviewCount >= (task.requested_reviews ?? 3) && task.status !== 'completed') {
        await this.updateStatus(data.taskId, 'completed');

        // ─── Budget awards on task completion ─────────────────────
        if (this.budgetService) {
          const allReviews = await this.getReviewsForTask(data.taskId);
          const avgOverall = allReviews.reduce((sum, r) => sum + r.weighted_overall, 0) / allReviews.length;

          // #7 Consensus alignment: reviewer within ±1 of consensus average → +2
          for (const review of allReviews) {
            if (Math.abs(review.weighted_overall - avgOverall) <= 1) {
              await this.budgetService.earn(review.principal_id, BUDGET.CONSENSUS_ALIGNMENT, 'consensus_alignment', review.id);
            }
          }

          // #8 High-score performance: task avg ≥ 8 → submitter gets +10
          if (avgOverall >= 8) {
            await this.budgetService.earn(task.principal_id, BUDGET.HIGH_SCORE_BONUS, 'high_score_bonus', task.id);
          }
        }
      }
    }

    return this.getReviewById(data.id);
  }

  async getReviewById(id: string) {
    const rows = await this.db.select().from(schema.reviews).where(eq(schema.reviews.id, id)).limit(1);
    if (rows.length === 0) return null;
    return this.formatReview(rows[0]);
  }

  async getReviewsForTask(taskId: string) {
    const rows = await this.db.select().from(schema.reviews).where(eq(schema.reviews.taskId, taskId));
    return rows.map(r => this.formatReview(r));
  }

  async getReviewCountForTask(taskId: string): Promise<number> {
    const rows = await this.db.select().from(schema.reviews).where(eq(schema.reviews.taskId, taskId));
    return rows.length;
  }

  // ─── Lifecycle transitions ───────────────────────────────────

  async completeTask(id: string) {
    const task = await this.getById(id);
    if (!task) throw new Error('TASK_NOT_FOUND');
    if (task.status !== 'in_review') throw new Error(`INVALID_TRANSITION: cannot complete task in '${task.status}' state`);
    return this.updateStatus(id, 'completed');
  }

  async expireTask(id: string) {
    const task = await this.getById(id);
    if (!task) throw new Error('TASK_NOT_FOUND');
    if (task.status !== 'open') throw new Error(`INVALID_TRANSITION: cannot expire task in '${task.status}' state`);
    return this.updateStatus(id, 'expired');
  }

  async archiveTask(id: string) {
    const task = await this.getById(id);
    if (!task) throw new Error('TASK_NOT_FOUND');
    if (task.status !== 'completed') throw new Error(`INVALID_TRANSITION: cannot archive task in '${task.status}' state`);
    return this.updateStatus(id, 'archived');
  }

  /**
   * Check deadline on access: if a task is open and its deadline has passed, expire it.
   * Call this on task reads to lazily enforce deadlines (no cron needed for v1).
   */
  async checkAndExpire(id: string) {
    const task = await this.getById(id);
    if (!task) return null;
    if (task.status === 'open' && task.deadline) {
      const deadlineDate = new Date(task.deadline);
      if (!isNaN(deadlineDate.getTime()) && deadlineDate < new Date()) {
        return this.expireTask(id);
      }
    }
    return task;
  }

  async markHelpful(reviewId: string, helpful: boolean) {
    await this.db.update(schema.reviews)
      .set({ helpful: helpful ? 1 : 0 })
      .where(eq(schema.reviews.id, reviewId));
  }

  private formatTask(row: typeof schema.tasks.$inferSelect) {
    return {
      id: row.id,
      agent_id: row.agentId,
      principal_id: row.principalId,
      description: row.description,
      dimensions: JSON.parse(row.dimensions),
      output: row.output,
      output_format: row.outputFormat,
      channel: row.channel,
      requested_reviews: row.requestedReviews,
      deadline: row.deadline,
      priority: row.priority,
      status: row.status,
      metadata: row.metadata ? JSON.parse(row.metadata) : {},
      budget_spent: row.budgetSpent,
      created_at: row.createdAt,
      updated_at: row.updatedAt,
    };
  }

  private formatReview(row: typeof schema.reviews.$inferSelect) {
    return {
      id: row.id,
      task_id: row.taskId,
      reviewer_id: row.reviewerId,
      principal_id: row.principalId,
      scores: JSON.parse(row.scores),
      weighted_overall: row.weightedOverall,
      reviewer_confidence: row.reviewerConfidence,
      comment: row.comment,
      suggestions: row.suggestions ? JSON.parse(row.suggestions) : [],
      approved: row.approved === 1,
      helpful: row.helpful === null ? null : row.helpful === 1,
      created_at: row.createdAt,
    };
  }
}