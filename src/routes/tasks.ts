/**
 * Conclave — Task routes
 */

import type { FastifyInstance, FastifyPluginCallback } from 'fastify';
import { CreateTaskSchema, SubmitReviewSchema, MarkHelpfulSchema } from '../schemas/index.js';
import { TaskService } from '../services/tasks.js';
import { BudgetService, BUDGET } from '../services/budget.js';
import { AgentService } from '../services/agents.js';
import { ChannelService } from '../services/channels.js';
import { success, error, ERROR_CODES } from '../utils/response.js';
import { randomUUID } from 'crypto';
import { authenticate } from '../middleware/auth.js';
import * as schema from '../db/schema.js';
import { eq } from 'drizzle-orm';

export const taskRoutes: FastifyPluginCallback = (fastify: FastifyInstance, _opts, done) => {
  const db = fastify.db;
  const budgetSvc = new BudgetService(db);
  const taskSvc = new TaskService(db, budgetSvc);
  const agentSvc = new AgentService(db);
  const channelSvc = new ChannelService(db);

  // Middleware: Protect task management routes
  fastify.addHook('preHandler', authenticate);

  // POST /v1/tasks
  fastify.post('/tasks', async (request, reply) => {
    const parsed = CreateTaskSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(422).send(error('VALIDATION_ERROR', 'Invalid input', parsed.error.flatten()));
    }
    const data = parsed.data;
    const agentId = (request as any).agentId;
    
    // If no agentId (JWT auth doesn't set one), look up the first agent for this user's org
    if (!agentId) {
      const currentOrgId = (request as any).orgId;
      const agentsList = await db.select({ id: schema.agents.id, principalId: schema.agents.principalId })
        .from(schema.agents)
        .where(eq(schema.agents.orgId, currentOrgId as any))
        .limit(1);
      if (agentsList.length === 0) {
        return reply.code(404).send(error(ERROR_CODES.AGENT_NOT_FOUND.code, 'No agents registered in this organization. Create one in the Agent Factory first.'));
      }
      (request as any).agentId = agentsList[0].id;
      (request as any).principalId = agentsList[0].principalId;
    }

    // Resolve principal from agent
    const agent = await agentSvc.getById(agentId);
    if (!agent) {
      return reply.code(404).send(error(ERROR_CODES.AGENT_NOT_FOUND.code, 'Agent not found'));
    }
    
    // Org Isolation: Task agent must belong to the user's current organization
    const currentOrgId = (request as any).orgId;
    if (!currentOrgId || agent.org_id !== currentOrgId) {
      return reply.code(403).send(error('FORBIDDEN', 'This agent belongs to a different organization'));
    }

    const principalId = agent.principal_id;

    // Verify principal is subscribed to the target channel
    const channel = await channelSvc.getByName(data.channel);
    if (channel) {
      const subcribed = await channelSvc.isSubscribed(principalId, channel.id);
      if (!subcribed) {
        return reply.code(403).send(error(ERROR_CODES.NOT_SUBSCRIBED.code, 'Principal is not subscribed to this channel', {
          channel: data.channel,
          principal_id: principalId,
        }));
      }
    }

    const id = `tsk_${randomUUID().replace(/-/g, '').slice(0, 24)}`;
    const cost = data.priority === 'priority' ? BUDGET.SUBMIT_PRIORITY_TASK : BUDGET.SUBMIT_TASK;

    // Check budget on principal, not agent
    const spent = await budgetSvc.spend(principalId, Math.abs(cost), 'submit_task', id);
    if (!spent) {
      const balance = await budgetSvc.getByPrincipal(principalId);
      return reply.code(402).send(error(ERROR_CODES.INSUFFICIENT_BUDGET.code, 'Insufficient budget', {
        current_budget: balance?.available ?? 0,
        required: Math.abs(cost),
        suggestion: 'Submit reviews or answer opinions to earn budget.',
      }));
    }

    const task = await taskSvc.create({
      id,
      agentId,
      principalId,
      description: data.task_description,
      dimensions: data.dimensions,
      output: data.output,
      outputFormat: data.output_format,
      channel: data.channel,
      requestedReviews: data.requested_reviews,
      deadline: data.deadline,
      priority: data.priority,
      metadata: data.metadata as Record<string, unknown> | undefined,
      budgetSpent: Math.abs(cost),
    });

    // Notify reviewer workers that a new task is available
    try {
      const pgClient = (fastify as any).pgClient;
      if (pgClient && typeof pgClient.notify === 'function') {
        await pgClient.notify('new_task', id);
      } else if (pgClient) {
        await pgClient.query(`SELECT pg_notify('new_task', $1)`, [id]);
      }
    } catch (notifyErr: any) {
      console.warn('[tasks] pg_notify failed (non-fatal):', notifyErr.message);
    }

    reply.code(201).send(success(task));
  });

  // GET /v1/tasks/:id
  fastify.get('/tasks/:id', async (request: any, reply) => {
    const { id } = request.params as { id: string };
    const task = await taskSvc.checkAndExpire(id);
    if (!task) return reply.code(404).send(error(ERROR_CODES.TASK_NOT_FOUND.code, 'Task not found'));

    // Org Isolation: Task must belong to the user's organization
    const currentOrgId = (request as any).orgId;
    const agent = await agentSvc.getById(task.agent_id);
    if (!currentOrgId || !agent || agent.org_id !== currentOrgId) {
      return reply.code(403).send(error('FORBIDDEN', 'Access to this task is restricted to its owner organization'));
    }

    const reviews = await taskSvc.getReviewsForTask(id);

    const review_summary = reviews.length > 0 ? (() => {
      const dimensionScores: Record<string, number[]> = {};
      let overallSum = 0;
      let approvalCount = 0;
      let confidenceSum = 0;
      const allSuggestions: string[] = [];

      for (const r of reviews) {
        if (r.scores && typeof r.scores === 'object') {
          for (const [dim, val] of Object.entries(r.scores)) {
            if (!dimensionScores[dim]) dimensionScores[dim] = [];
            dimensionScores[dim].push(Number(val) || 0);
          }
        }
        overallSum += r.weighted_overall ?? 0;
        confidenceSum += r.reviewer_confidence ?? 0;
        if (r.approved) approvalCount++;
        if (Array.isArray(r.suggestions)) allSuggestions.push(...r.suggestions);
      }

      const avgScores: Record<string, number> = {};
      for (const [dim, vals] of Object.entries(dimensionScores)) {
        avgScores[dim] = Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 10) / 10;
      }

      const seen = new Set<string>();
      const topSuggestions = allSuggestions.filter(s => {
        const key = s.toLowerCase().trim();
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      }).slice(0, 5);

      return {
        review_count: reviews.length,
        avg_overall: Math.round((overallSum / reviews.length) * 10) / 10,
        avg_scores: avgScores,
        approval_rate: Math.round((approvalCount / reviews.length) * 100),
        avg_confidence: Math.round((confidenceSum / reviews.length) * 100) / 100,
        top_suggestions: topSuggestions,
        approved: approvalCount >= Math.ceil(reviews.length / 2),
      };
    })() : null;

    reply.send(success({ ...task, reviews_received: reviews.length, reviews, review_summary }));
  });

  // GET /v1/tasks
  fastify.get('/tasks', async (request: any, reply) => {
    const query = request.query as any;
    const currentOrgId = (request as any).orgId;
    const tasks = await taskSvc.list({
      status: query.status,
      channel: query.channel,
      agentId: query.agent_id,
      principalId: query.principal_id,
      orgId: currentOrgId,
    });
    reply.send(success({ tasks, total: tasks.length }));
  });

  // POST /v1/tasks/:id/reviews
  fastify.post('/tasks/:id/reviews', async (request, reply) => {
    const { id: taskId } = request.params as { id: string };
    const parsed = SubmitReviewSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(422).send(error('VALIDATION_ERROR', 'Invalid input', parsed.error.flatten()));
    }
    const data = parsed.data;
    const reviewerId = (request as any).agentId ?? 'agt_reviewer_dev';

    // Validate: can't review own task
    const task = await taskSvc.getById(taskId);
    if (!task) return reply.code(404).send(error(ERROR_CODES.TASK_NOT_FOUND.code, 'Task not found'));
    if (task.agent_id === reviewerId) {
      return reply.code(403).send(error(ERROR_CODES.SELF_REVIEW_FORBIDDEN.code, 'Cannot review own task'));
    }

    // Also check principal-level self-review
    const reviewer = await agentSvc.getById(reviewerId);
    if (reviewer && task.principal_id === reviewer.principal_id) {
      return reply.code(403).send(error(ERROR_CODES.SELF_REVIEW_FORBIDDEN.code, 'Cannot review own principal\'s task'));
    }

    // Reject reviews on tasks that are already completed, expired, or archived
    if (['completed', 'expired', 'archived'].includes(task.status)) {
      return reply.code(409).send(error(ERROR_CODES.TASK_ALREADY_COMPLETED.code, 'Cannot review a task that is no longer in review', {
        task_status: task.status,
      }));
    }

    // Deadline enforcement: reject if task deadline has passed
    if (task.deadline) {
      const deadlineDate = new Date(task.deadline);
      if (!isNaN(deadlineDate.getTime()) && deadlineDate < new Date()) {
        return reply.code(422).send(error(ERROR_CODES.DEADLINE_PASSED.code, 'Task deadline has passed', {
          deadline: task.deadline,
        }));
      }
    }

    // Dimension validation: scores keys must exactly match task dimensions
    const taskDimensions: string[] = task.dimensions;
    const scoreKeys = Object.keys(data.scores);
    const missingDimensions = taskDimensions.filter(d => !scoreKeys.includes(d));
    const extraDimensions = scoreKeys.filter(k => !taskDimensions.includes(k));
    if (missingDimensions.length > 0 || extraDimensions.length > 0) {
      return reply.code(422).send(error(ERROR_CODES.INVALID_DIMENSIONS.code, 'Review scores do not match task dimensions', {
        required: taskDimensions,
        provided: scoreKeys,
        missing: missingDimensions,
        extra: extraDimensions,
      }));
    }

    const reviewId = `rev_${randomUUID().replace(/-/g, '').slice(0, 24)}`;
    let review;
    try {
      review = await taskSvc.submitReview({
        id: reviewId,
        taskId,
        reviewerId,
        principalId: reviewer?.principal_id ?? 'prn_anon',
        scores: data.scores,
        weightedOverall: data.weighted_overall,
        reviewerConfidence: data.reviewer_confidence,
        comment: data.comment,
        suggestions: data.suggestions,
        approved: data.approved,
      });
    } catch (err: any) {
      if (err.message?.startsWith('DUPLICATE_REVIEW')) {
        return reply.code(409).send(error(ERROR_CODES.DUPLICATE_REVIEW.code, 'This principal has already reviewed this task'));
      }
      throw err;
    }

    // Earn budget for reviewing (on principal)
    await budgetSvc.earn(reviewer?.principal_id ?? 'prn_anon', BUDGET.SUBMIT_REVIEW, 'submit_review', reviewId);

    reply.code(201).send(success(review));
  });

  // POST /v1/tasks/:id/helpful
  fastify.post('/tasks/:id/helpful', async (request, reply) => {
    const { id: taskId } = request.params as { id: string };
    const parsed = MarkHelpfulSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(422).send(error('VALIDATION_ERROR', 'Invalid input', parsed.error.flatten()));
    }

    await taskSvc.markHelpful(parsed.data.review_id, parsed.data.helpful);

    if (parsed.data.helpful) {
      // Look up the review to find reviewer principal and award bonus
      const review = await taskSvc.getReviewById(parsed.data.review_id);
      if (review) {
        await budgetSvc.earn(review.principal_id, BUDGET.MARK_HELPFUL, 'review_marked_helpful', parsed.data.review_id);
      }
    }

    reply.send(success({ review_id: parsed.data.review_id, helpful: parsed.data.helpful }));
  });

  // POST /v1/tasks/:id/archive
  fastify.post('/tasks/:id/archive', async (request: any, reply) => {
    const { id } = request.params as { id: string };
    try {
      const task = await taskSvc.archiveTask(id);
      if (!task) return reply.code(404).send(error(ERROR_CODES.TASK_NOT_FOUND.code, 'Task not found'));
      reply.send(success(task));
    } catch (err: any) {
      if (err.message?.startsWith('INVALID_TRANSITION')) {
        const task = await taskSvc.getById(id);
        return reply.code(422).send(error(ERROR_CODES.INVALID_TRANSITION.code, err.message, {
          current_status: task?.status,
          required_status: 'completed',
        }));
      }
      if (err.message === 'TASK_NOT_FOUND') {
        return reply.code(404).send(error(ERROR_CODES.TASK_NOT_FOUND.code, 'Task not found'));
      }
      throw err;
    }
  });

  done();
};
