/**
 * Conclave — Cron Review Endpoint
 *
 * Single-sweep reviewer: called by Vercel Cron every 2 minutes.
 * Also callable manually: GET/POST /v1/cron/review
 * Protected by CRON_SECRET env var.
 */

import type { FastifyInstance } from 'fastify';
import { eq, and } from 'drizzle-orm';
import { tasks, reviews, principals, agents, channels, channelSubscriptions } from '../db/schema.js';

export async function cronRoutes(fastify: FastifyInstance) {

  // GET/POST /v1/cron/review — Single review sweep
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
    const results: any[] = [];

    try {
      // Load fleet config from env, fall back to defaults
      const fleetJson = process.env.FLEET_CONFIG;
      let reviewers: any[];
      if (fleetJson) {
        reviewers = JSON.parse(fleetJson).reviewers;
      } else {
        const ollamaKey = process.env.OLLAMA_KEY || '';
        reviewers = [
          {
            name: 'Code Reviewer',
            channels: ['general-qa', 'code-review'],
            model: 'deepseek-v4-flash',
            provider: 'ollama_cloud',
            llm_url: 'https://www.ollama.com/v1',
            llm_key: ollamaKey,
            mode: 'auto',
            instructions: 'You are a senior code reviewer. Focus on correctness, security, performance, and readability. Cite specific lines. Be constructive and specific. Max 200 words.',
            skills: ['security-audit', 'system-design'],
          },
          {
            name: 'General Reviewer',
            channels: ['general-qa', 'code-review'],
            model: 'glm-5.1',
            provider: 'ollama_cloud',
            llm_url: 'https://www.ollama.com/v1',
            llm_key: ollamaKey,
            mode: 'auto',
            instructions: 'Review for factual accuracy, clarity, and quality. Be concise, specific, and helpful. Focus on what matters most.',
            skills: ['reasoning'],
          },
        ];
      }

      for (const reviewer of reviewers) {
        const ollamaKey = process.env.OLLAMA_KEY || '';

        // 1. Get or create principal
        let principalId: string;
        const existingPrincipals = await db.select().from(principals).where(eq(principals.name, reviewer.name));
        if (existingPrincipals.length > 0) {
          principalId = existingPrincipals[0].id;
        } else {
          const [newPrin] = await db.insert(principals).values({
            name: reviewer.name,
            capabilities: JSON.stringify(['review']),
            metadata: JSON.stringify({ fleet: true, mode: reviewer.mode, model: reviewer.model }),
          }).returning({ id: principals.id });
          principalId = newPrin.id;
        }

        // 2. Get or create agent
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
            type: reviewer.type || 'llm',
            model: reviewer.model,
            provider: reviewer.provider,
            llmUrl: reviewer.llm_url,
            instructions: reviewer.instructions,
            skills: JSON.stringify(reviewer.skills || []),
          }).returning({ id: agents.id });
          agentId = newAgent.id;
        }

        // 3. Subscribe to channels (idempotent)
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

        // 4. Find open tasks in reviewer channels
        const reviewed: string[] = [];
        for (const channelName of reviewer.channels) {
          // Tasks use 'channel' as a text field (channel name), not a FK
          const openTasks = await db.select().from(tasks).where(
            and(eq(tasks.channel, channelName), eq(tasks.status, 'open'))
          );

          for (const task of openTasks) {
            // Check if this principal already reviewed this task
            const existingReviews = await db.select().from(reviews).where(
              and(eq(reviews.taskId, task.id), eq(reviews.principalId, principalId))
            );
            if (existingReviews.length > 0) continue;

            // Build prompt
            const dimensions = task.dimensions ? JSON.parse(task.dimensions) : ['correctness', 'readability', 'security', 'performance'];
            const prompt = `Review the following ${task.outputFormat || 'code'} for ${dimensions.join(', ')}.\n\nTask: ${task.description}\n\nOutput to review:\n${task.output || 'No output provided'}\n\nRespond with ONLY a JSON block:\n\`\`\`json\n{\n  "scores": {${dimensions.map((d: string) => `"${d}": <1-10>`).join(', ')}},\n  "weighted_overall": <1-10>,\n  "reviewer_confidence": <0.0-1.0>,\n  "comment": "<detailed review, max 500 words>",\n  "suggestions": ["<suggestion 1>", "<suggestion 2>"]\n}\n\`\`\``;

            // Call LLM
            const llmUrl = reviewer.llm_url || 'https://www.ollama.com/v1';
            const llmKey = reviewer.llm_key || ollamaKey;

            try {
              const llmRes = await fetch(`${llmUrl}/chat/completions`, {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  ...(llmKey ? { 'Authorization': `Bearer ${llmKey}` } : {}),
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
              });

              if (!llmRes.ok) {
                const errBody = await llmRes.text().catch(() => '');
                results.push({ reviewer: reviewer.name, task: task.id, error: `LLM ${llmRes.status}: ${errBody.slice(0, 200)}` });
                continue;
              }

              const llmJson = await llmRes.json() as any;
              const content = llmJson.choices?.[0]?.message?.content || '';
              if (!content) {
                results.push({ reviewer: reviewer.name, task: task.id, error: 'Empty LLM response' });
                continue;
              }

              // Parse LLM response (handles markdown code fences, truncated JSON)
              let parsed: any = null;
              const jsonMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/);
              const jsonStr = jsonMatch ? jsonMatch[1] : content;
              const braceStart = jsonStr.indexOf('{');
              if (braceStart !== -1) {
                try {
                  parsed = JSON.parse(jsonStr.slice(braceStart));
                } catch {
                  // Nested brace tracking for truncated JSON
                  let depth = 0, end = -1;
                  for (let i = braceStart; i < jsonStr.length; i++) {
                    if (jsonStr[i] === '{') depth++;
                    if (jsonStr[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
                  }
                  if (end !== -1) parsed = JSON.parse(jsonStr.slice(braceStart, end + 1));
                }
              }

              if (!parsed) {
                results.push({ reviewer: reviewer.name, task: task.id, error: 'Could not parse LLM response' });
                continue;
              }

              // Normalize confidence (0-10 → 0-1)
              let confidence = parsed.reviewer_confidence ?? 0.7;
              if (confidence > 1) confidence = confidence / 10;
              confidence = Math.min(1, Math.max(0, confidence));

              const scores = parsed.scores || {};
              const avgScore = Object.values(scores).length > 0
                ? (Object.values(scores) as number[]).reduce((a: number, b: number) => a + b, 0) / Object.values(scores).length
                : 5;

              // Insert review directly into DB
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

              reviewed.push(task.id);

              // Check if task has enough reviews
              const taskReviews = await db.select().from(reviews).where(eq(reviews.taskId, task.id));
              const requestedReviews = task.requestedReviews || 3;
              if (taskReviews.length >= requestedReviews) {
                await db.update(tasks).set({ status: 'completed', reviewsReceived: taskReviews.length, updatedAt: new Date().toISOString() }).where(eq(tasks.id, task.id));
              }

            } catch (llmErr: any) {
              results.push({ reviewer: reviewer.name, task: task.id, error: `LLM call failed: ${llmErr.message}` });
            }
          }
        }

        if (reviewed.length > 0) {
          results.push({ reviewer: reviewer.name, reviewed });
        }
      }

      return reply.send({
        status: 'ok',
        timestamp: new Date().toISOString(),
        duration_ms: Date.now() - startTime,
        results,
      });

    } catch (err: any) {
      console.error('Cron review error:', err);
      return reply.code(500).send({
        status: 'error',
        message: err.message,
      });
    }
  });
}