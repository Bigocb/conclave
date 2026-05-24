/**
 * Conclave — Cron Review Endpoints
 *
 * Split into two fast (<2s) endpoints for Vercel Hobby plan:
 * POST /v1/cron/next   — Find next unreviewed task, return LLM prompt info
 * POST /v1/cron/submit — Submit a completed review
 *
 * The LLM call happens in GitHub Actions (6h timeout), not in Vercel (10s limit).
 */

import type { FastifyInstance } from 'fastify';
import { eq, and } from 'drizzle-orm';
import { tasks, reviews, principals, agents, channels, channelSubscriptions } from '../db/schema.js';

export async function cronRoutes(fastify: FastifyInstance) {

  const REVIEWERS = [
    {
      name: 'Code Reviewer',
      channels: ['general-qa', 'code-review'],
      model: 'deepseek-v4-flash',
      provider: 'ollama_cloud',
      llm_url: 'https://www.ollama.com/v1',
      instructions: 'You are a senior code reviewer. Focus on correctness, security, performance, and readability. Cite specific lines. Be constructive and specific. Max 200 words.',
    },
    {
      name: 'General Reviewer',
      channels: ['general-qa', 'code-review'],
      model: 'glm-5.1',
      provider: 'ollama_cloud',
      llm_url: 'https://www.ollama.com/v1',
      instructions: 'Review for factual accuracy, clarity, and quality. Be concise, specific, and helpful. Focus on what matters most.',
    },
  ];

  // Verify cron secret helper
  function verifySecret(request: any): boolean {
    const cronSecret = process.env.CRON_SECRET;
    if (!cronSecret) return true; // No secret configured = open
    const authHeader = request.headers.authorization;
    const provided = authHeader?.replace('Bearer ', '') ||
      request.query?.secret ||
      request.headers['x-cron-secret'];
    return provided === cronSecret;
  }

  // ── POST /v1/cron/next — Find next unreviewed task, return prompt data ──
  fastify.all('/cron/next', async (request, reply) => {
    if (!verifySecret(request)) {
      return reply.code(401).send({ error: { code: 'UNAUTHORIZED', message: 'Invalid cron secret' } });
    }

    const db = (fastify as any).db;

    try {
      for (const reviewer of REVIEWERS) {
        // Get or create principal
        let principalId: string;
        const existingPrincipals = await db.select().from(principals).where(eq(principals.name, reviewer.name));
        if (existingPrincipals.length > 0) {
          principalId = existingPrincipals[0].id;
        } else {
          const [newPrin] = await db.insert(principals).values({
            name: reviewer.name,
            capabilities: JSON.stringify(['review']),
            metadata: JSON.stringify({ fleet: true, model: reviewer.model }),
          }).returning({ id: principals.id });
          principalId = newPrin.id;
        }

        // Get or create agent
        const existingAgents = await db.select().from(agents).where(
          and(eq(agents.principalId, principalId), eq(agents.name, `${reviewer.name} #1`))
        );
        let agentId: string;
        if (existingAgents.length > 0) {
          agentId = existingAgents[0].id;
        } else {
          const [newAgent] = await db.insert(agents).values({
            principalId,
            name: `${reviewer.name} #1`,
            type: 'llm',
            model: reviewer.model,
            provider: reviewer.provider,
            llmUrl: reviewer.llm_url,
            instructions: reviewer.instructions,
          }).returning({ id: agents.id });
          agentId = newAgent.id;
        }

        // Ensure subscribed to channels
        for (const channelName of reviewer.channels) {
          const chList = await db.select().from(channels).where(eq(channels.name, channelName));
          if (chList.length > 0) {
            const channelId = chList[0].id;
            const existing = await db.select().from(channelSubscriptions).where(
              and(eq(channelSubscriptions.principalId, principalId), eq(channelSubscriptions.channelId, channelId))
            );
            if (existing.length === 0) {
              await db.insert(channelSubscriptions).values({ principalId, channelId });
            }
          }
        }

        // Find first open task in reviewer channels that this principal hasn't reviewed
        for (const channelName of reviewer.channels) {
          const openTasks = await db.select().from(tasks).where(
            and(eq(tasks.channel, channelName), eq(tasks.status, 'open'))
          );

          for (const task of openTasks) {
            const existingReviews = await db.select().from(reviews).where(
              and(eq(reviews.taskId, task.id), eq(reviews.principalId, principalId))
            );
            if (existingReviews.length > 0) continue; // Already reviewed

            // Found a task! Return the prompt data for the Action to call the LLM
            const dimensions = task.dimensions ? JSON.parse(task.dimensions) : ['correctness', 'readability', 'security', 'performance'];
            const userPrompt = `Review the following ${task.outputFormat || 'code'} for ${dimensions.join(', ')}.\n\nTask: ${task.description}\n\nOutput to review:\n${task.output || 'No output provided'}\n\nRespond with ONLY a JSON block:\n\`\`\`json\n{\n  "scores": {${dimensions.map((d: string) => `"${d}": <1-10>`).join(', ')}},\n  "weighted_overall": <1-10>,\n  "reviewer_confidence": <0.0-1.0>,\n  "comment": "<detailed review, max 500 words>",\n  "suggestions": ["<suggestion 1>", "<suggestion 2>"]\n}\n\`\`\``;

            return reply.send({
              status: 'reviewing',
              task_id: task.id,
              reviewer_id: agentId,
              principal_id: principalId,
              channel: channelName,
              llm_url: reviewer.llm_url,
              model: reviewer.model,
              system_prompt: reviewer.instructions,
              user_prompt: userPrompt,
            });
          }
        }
      }

      return reply.send({ status: 'idle', message: 'No open tasks to review' });

    } catch (err: any) {
      return reply.code(500).send({ status: 'error', message: err.message });
    }
  });

  // ── POST /v1/cron/submit — Submit a completed review ──
  fastify.all('/cron/submit', async (request, reply) => {
    if (!verifySecret(request)) {
      return reply.code(401).send({ error: { code: 'UNAUTHORIZED', message: 'Invalid cron secret' } });
    }

    const db = (fastify as any).db;
    const body = request.body as any;

    if (!body.task_id || !body.reviewer_id || !body.principal_id) {
      return reply.code(400).send({ error: { code: 'BAD_REQUEST', message: 'Missing required fields: task_id, reviewer_id, principal_id' } });
    }

    try {
      // Insert review
      await db.insert(reviews).values({
        taskId: body.task_id,
        reviewerId: body.reviewer_id,
        principalId: body.principal_id,
        scores: typeof body.scores === 'string' ? body.scores : JSON.stringify(body.scores || {}),
        weightedOverall: Math.min(10, Math.max(0, body.weighted_overall ?? 7)),
        reviewerConfidence: Math.min(1, Math.max(0, body.reviewer_confidence ?? 0.7)),
        comment: (body.comment || 'No comment provided.').slice(0, 1500),
        suggestions: typeof body.suggestions === 'string' ? body.suggestions : JSON.stringify(body.suggestions || []),
        approved: body.approved ?? false,
        status: 'submitted',
      });

      // Check if task has enough reviews → complete it
      const taskReviews = await db.select().from(reviews).where(eq(reviews.taskId, body.task_id));
      // Get the task to check requestedReviews
      const taskList = await db.select().from(tasks).where(eq(tasks.id, body.task_id));
      const requestedReviews = taskList[0]?.requestedReviews || 3;

      if (taskReviews.length >= requestedReviews) {
        await db.update(tasks).set({
          status: 'completed',
          reviewsReceived: taskReviews.length,
          updatedAt: new Date().toISOString(),
        }).where(eq(tasks.id, body.task_id));
      }

      return reply.send({
        status: 'submitted',
        task_id: body.task_id,
        reviews_count: taskReviews.length,
        task_status: taskReviews.length >= requestedReviews ? 'completed' : 'open',
      });

    } catch (err: any) {
      return reply.code(500).send({ status: 'error', message: err.message });
    }
  });
}