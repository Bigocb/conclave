/**
 * Conclave — Cron Review Endpoint
 *
 * Single-review per invocation — designed for Hobby plan (10s timeout).
 * Called by GitHub Actions every 2 minutes.
 * Picks ONE reviewer with ONE open task, calls LLM, submits review.
 * Protected by CRON_SECRET env var.
 */

import type { FastifyInstance } from 'fastify';
import { eq, and } from 'drizzle-orm';
import { tasks, reviews, principals, agents, channels, channelSubscriptions } from '../db/schema.js';

export async function cronRoutes(fastify: FastifyInstance) {

  // GET/POST /v1/cron/review — Single review (one reviewer, one task)
  fastify.all('/cron/review', async (request, reply) => {
    // Verify cron secret if set
    const cronSecret = process.env.CRON_SECRET;
    if (cronSecret) {
      const authHeader = (request.headers as any).authorization;
      const provided = authHeader?.replace('Bearer ', '') ||
        (request.query as any)?.secret ||
        (request.headers as any)['x-cron-secret'];
      if (provided !== cronSecret) {
        return reply.code(401).send({ error: { code: 'UNAUTHORIZED', message: 'Invalid cron secret' } });
      }
    }

    const startTime = Date.now();
    const db = (fastify as any).db;
    const ollamaKey = process.env.OLLAMA_KEY || '';

    // Reviewer definitions — add more here to scale
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

    try {
      // ── Pick ONE reviewer that has an open, unreviewed task ──
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

            // ── Found a task! Call LLM and submit review ──
            const dimensions = task.dimensions ? JSON.parse(task.dimensions) : ['correctness', 'readability', 'security', 'performance'];
            const prompt = `Review the following ${task.outputFormat || 'code'} for ${dimensions.join(', ')}.\n\nTask: ${task.description}\n\nOutput to review:\n${task.output || 'No output provided'}\n\nRespond with ONLY a JSON block:\n\`\`\`json\n{\n  "scores": {${dimensions.map((d: string) => `"${d}": <1-10>`).join(', ')}},\n  "weighted_overall": <1-10>,\n  "reviewer_confidence": <0.0-1.0>,\n  "comment": "<detailed review, max 500 words>",\n  "suggestions": ["<suggestion 1>", "<suggestion 2>"]\n}\n\`\`\``;

            try {
              const llmRes = await fetch(`${reviewer.llm_url}/chat/completions`, {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  ...(ollamaKey ? { 'Authorization': `Bearer ${ollamaKey}` } : {}),
                },
                body: JSON.stringify({
                  model: reviewer.model,
                  messages: [
                    { role: 'system', content: reviewer.instructions },
                    { role: 'user', content: prompt },
                  ],
                  temperature: 0.3,
                  max_tokens: 1500,
                }),
                signal: AbortSignal.timeout(8000), // 8s LLM timeout — fits in 10s Vercel limit
              });

              if (!llmRes.ok) {
                const errBody = await llmRes.text().catch(() => '');
                return reply.send({
                  status: 'llm_error',
                  reviewer: reviewer.name,
                  task: task.id,
                  http_status: llmRes.status,
                  error: errBody.slice(0, 200),
                  duration_ms: Date.now() - startTime,
                });
              }

              const llmJson = await llmRes.json() as any;
              const content = llmJson.choices?.[0]?.message?.content || '';
              if (!content) {
                return reply.send({ status: 'empty_response', reviewer: reviewer.name, task: task.id, duration_ms: Date.now() - startTime });
              }

              // Parse LLM response
              let parsed: any = null;
              const jsonMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/);
              const jsonStr = jsonMatch ? jsonMatch[1] : content;
              const braceStart = jsonStr.indexOf('{');
              if (braceStart !== -1) {
                try {
                  parsed = JSON.parse(jsonStr.slice(braceStart));
                } catch {
                  let depth = 0, end = -1;
                  for (let i = braceStart; i < jsonStr.length; i++) {
                    if (jsonStr[i] === '{') depth++;
                    if (jsonStr[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
                  }
                  if (end !== -1) parsed = JSON.parse(jsonStr.slice(braceStart, end + 1));
                }
              }

              if (!parsed) {
                return reply.send({ status: 'parse_error', reviewer: reviewer.name, task: task.id, raw: content.slice(0, 300), duration_ms: Date.now() - startTime });
              }

              // Normalize confidence (0-10 → 0-1)
              let confidence = parsed.reviewer_confidence ?? 0.7;
              if (confidence > 1) confidence = confidence / 10;
              confidence = Math.min(1, Math.max(0, confidence));

              const scores = parsed.scores || {};
              const avgScore = Object.values(scores).length > 0
                ? (Object.values(scores) as number[]).reduce((a: number, b: number) => a + b, 0) / Object.values(scores).length
                : 5;

              // Insert review
              await db.insert(reviews).values({
                taskId: task.id,
                reviewerId: agentId,
                principalId,
                scores: JSON.stringify(scores),
                weightedOverall: Math.min(10, Math.max(0, parsed.weighted_overall ?? Math.round(avgScore * 10) / 10)),
                reviewerConfidence: confidence,
                comment: (parsed.comment || 'No comment provided.').slice(0, 1500),
                suggestions: JSON.stringify(Array.isArray(parsed.suggestions) ? parsed.suggestions : []),
                approved: parsed.approved ?? avgScore >= 7,
                status: 'submitted',
              });

              // Check if task has enough reviews → complete it
              const taskReviews = await db.select().from(reviews).where(eq(reviews.taskId, task.id));
              const requestedReviews = task.requestedReviews || 3;
              if (taskReviews.length >= requestedReviews) {
                await db.update(tasks).set({ status: 'completed', reviewsReceived: taskReviews.length, updatedAt: new Date().toISOString() }).where(eq(tasks.id, task.id));
              }

              return reply.send({
                status: 'reviewed',
                reviewer: reviewer.name,
                task: task.id,
                channel: channelName,
                scores,
                approved: parsed.approved ?? avgScore >= 7,
                confidence,
                duration_ms: Date.now() - startTime,
              });

            } catch (llmErr: any) {
              return reply.send({
                status: 'llm_error',
                reviewer: reviewer.name,
                task: task.id,
                error: llmErr.message,
                duration_ms: Date.now() - startTime,
              });
            }
          }
        }
      }

      // No open tasks found
      return reply.send({
        status: 'idle',
        message: 'No open tasks to review',
        duration_ms: Date.now() - startTime,
      });

    } catch (err: any) {
      return reply.code(500).send({
        status: 'error',
        message: err.message,
        duration_ms: Date.now() - startTime,
      });
    }
  });
}