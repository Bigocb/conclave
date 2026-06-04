/**
 * Conclave — Task service
 * CRUD and lifecycle operations for tasks and reviews
 */

import { eq, and, desc, inArray, ne } from 'drizzle-orm';
import * as schema from '../db/schema.js';
import type { ConclaveDb } from '../db/index.js';
import { BUDGET } from '../services/budget.js';
import { MemoryService } from '../services/memory.js';
import { MemoryExtractor, type LlmCallFn } from '../services/memory-extractor.js';

export class TaskService {
  private memorySvc: MemoryService;
  private memoryExtractor: MemoryExtractor;
  constructor(private db: ConclaveDb, private budgetService?: any) {
    this.memorySvc = new MemoryService(db as any);
    this.memoryExtractor = new MemoryExtractor();
    this.configureExtractor();
  }

  /**
   * Configure the MemoryExtractor with an LLM call function based on environment.
   * Uses the first available LLM credential from env vars.
   */
  private configureExtractor(): void {
    const llmUrl = process.env.OLLAMA_URL || process.env.OPENAI_API_URL || 'https://api.openai.com/v1/chat/completions';
    const llmKey = process.env.OLLAMA_KEY || process.env.OPENAI_API_KEY || '';

    if (!llmKey) {
      console.log('[MemoryExtractor] No LLM key configured — using keyword-grep fallback only');
      return;
    }

    this.memoryExtractor.setLlmCall(this.buildLlmCall(llmUrl, llmKey));
  }

  private buildLlmCall(llmUrl: string, llmKey: string): LlmCallFn {
    return async (prompt: string) => {
      const res = await fetch(llmUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${llmKey}`,
        },
        body: JSON.stringify({
          model: process.env.EXTRACTOR_MODEL || 'gpt-4o-mini',
          messages: [
            { role: 'system', content: 'You extract actionable conventions from code review feedback. Return only valid JSON.' },
            { role: 'user', content: prompt },
          ],
          temperature: 0.2,
          max_tokens: 500,
        }),
      });

      if (!res.ok) {
        throw new Error(`LLM call failed: ${res.status} ${res.statusText}`);
      }

      const data = await res.json() as any;
      return data.choices?.[0]?.message?.content || '';
    };
  }

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

  async list(filters: { status?: string; channel?: string; agentId?: string; principalId?: string; orgId?: string; includeDismissed?: boolean } = {}) {
    const conditions = [];
    if (filters.status) conditions.push(eq(schema.tasks.status, filters.status));
    if (filters.channel) conditions.push(eq(schema.tasks.channel, filters.channel));
    if (filters.agentId) conditions.push(eq(schema.tasks.agentId, filters.agentId));
    if (filters.principalId) conditions.push(eq(schema.tasks.principalId, filters.principalId));
    if (!filters.includeDismissed && !filters.status) {
      conditions.push(ne(schema.tasks.status, 'dismissed'));
    }

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

    // Issue #76/#108: Extract actionable conventions from review feedback
    // Write to BOTH the submitter (who receives feedback) AND the reviewer (who gave it)
    const submitterPrincipalId = task?.principal_id;
    await this.writeMemoryFromReview({
      comment: data.comment,
      suggestions: data.suggestions,
      approved: data.approved,
      scores: data.scores,
      principalId: data.principalId,
      taskId: data.taskId,
      taskDescription: task?.description,
    }, submitterPrincipalId);

    return this.getReviewById(data.id);
  }

  async getReviewById(id: string) {
    const rows = await this.db.select().from(schema.reviews).where(eq(schema.reviews.id, id)).limit(1);
    if (rows.length === 0) return null;
    return this.formatReview(rows[0]);
  }

  async getReviewsForTask(taskId: string) {
    const rows = await this.db.select()
      .from(schema.reviews)
      .leftJoin(schema.agents, eq(schema.reviews.reviewerId, schema.agents.id))
      .where(eq(schema.reviews.taskId, taskId));
    return rows.map(r => this.formatReview(r.clv_reviews, (r.clv_agents as any)?.name ?? undefined));
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

  /**
   * Issue #76/108: Extract and write actionable conventions from a submitted review.
   * Uses MemoryExtractor (LLM + keyword-grep fallback) to distill conventions.
   * Non-blocking — failures are logged but don't fail the review submission.
   */
  private async writeMemoryFromReview(data: {
    comment: string;
    suggestions?: string[];
    approved?: boolean;
    scores: Record<string, number>;
    principalId: string;  // reviewer's principal
    taskId?: string;
    taskDescription?: string;
  }, submitterPrincipalId?: string): Promise<void> {
    try {
      // Use the MemoryExtractor to get actionable conventions
      const conventions = await this.memoryExtractor.extract({
        taskDescription: data.taskDescription || '',
        comment: data.comment,
        scores: data.scores,
        suggestions: data.suggestions,
      });

      if (conventions.length === 0) {
        console.log(`  ℹ️ No conventions extracted from review by ${data.principalId}`);
        return;
      }

      const targets = [data.principalId];
      if (submitterPrincipalId && submitterPrincipalId !== data.principalId) {
        targets.push(submitterPrincipalId);
      }

      for (const targetPrincipalId of targets) {
        for (const conv of conventions) {
          await this.memorySvc.upsert({
            principalId: targetPrincipalId,
            key: `convention:${this.memoryExtractor.getConventionKey(conv.convention)}`,
            value: conv.convention,
            category: conv.category,
            sourceTaskId: data.taskId ?? null,
            sourcePrincipalId: data.principalId,
            confidence: conv.confidence,
            ttlDays: 30,
          });
        }
      }
      console.log(`  📝 Wrote ${conventions.length * targets.length} convention memories (${targets.length} principals) from review`);
    } catch (err) {
      // Non-blocking — log but don't fail the review
      console.warn(`  ⚠️ Failed to write memory facts from review: ${err}`);
    }
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

  private formatReview(row: typeof schema.reviews.$inferSelect, reviewerName?: string) {
    return {
      id: row.id,
      task_id: row.taskId,
      reviewer_id: row.reviewerId,
      reviewer_name: reviewerName || null,
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