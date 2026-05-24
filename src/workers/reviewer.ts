/**
 * Conclave — Reviewer Worker (PG LISTEN/NOTIFY + SKIP LOCKED)
 *
 * Channel-aware dispatcher: picks up open tasks, finds which principals
 * are subscribed to the task's channel, selects one of their agents,
 * and uses that agent's model + instructions for the LLM call.
 *
 * Task lifecycle: open → in_review → completed (after requested_reviews met)
 *
 * Usage:
 *   DATABASE_URL=postgres://... npx tsx src/workers/reviewer.ts
 *   DATABASE_URL=postgres://... npx tsx src/workers/reviewer.ts --config fleet.yaml
 */

import postgres from 'postgres';
import { randomUUID } from 'crypto';
import { existsSync, readFileSync } from 'fs';
import { resolve } from 'path';

// ─── Config ───────────────────────────────────────────────────

export interface WorkerConfig {
  databaseUrl: string;
  llmUrl: string;
  llmKey: string;
  model: string;
  mode: 'auto' | 'human' | 'hybrid';
  maxConcurrent: number;
  pollInterval: number;      // seconds
  confidenceThreshold: number;
  systemPrompt?: string;
}

const DEFAULT_CONFIG: WorkerConfig = {
  databaseUrl: '',
  llmUrl: 'https://www.ollama.com/v1',
  llmKey: '',
  model: 'deepseek-v4-flash',
  mode: 'auto',
  maxConcurrent: 3,
  pollInterval: 15,
  confidenceThreshold: 0.7,
};

const DEFAULT_REVIEW_PROMPT = `You are a senior code reviewer. Analyze the output for quality, correctness, and completeness.

Score each requested dimension from 1-10 (integers only). Provide a weighted overall score (1-10).
Rate your confidence in this review (0-1, where 1 = very confident).
Give a concise comment (20-1500 chars) and specific suggestions.

Respond in EXACTLY this JSON format (no markdown, no backticks):
{
  "scores": { "dimension_name": 7 },
  "weighted_overall": 7,
  "reviewer_confidence": 0.8,
  "comment": "Your review comment here",
  "suggestions": ["Suggestion 1", "Suggestion 2"],
  "approved": true
}`;

// ─── Types ────────────────────────────────────────────────────

interface AgentRow {
  id: string;
  principal_id: string;
  org_id: string;
  name: string;
  model: string | null;
  provider: string | null;
  llm_url: string | null;
  instructions: string | null;
  skills: string | null;
  type: string | null;
  status: string;
}

interface ChannelSubRow {
  principal_id: string;
  channel_id: string;
  channel_name: string;
}

interface TaskRow {
  id: string;
  agent_id: string;
  principal_id: string;
  description: string;
  output: string;
  dimensions: any;
  channel: string;
  metadata: any;
  requested_reviews: number;
}

interface ReviewResult {
  scores: Record<string, number>;
  weighted_overall: number;
  reviewer_confidence: number;
  comment: string;
  suggestions: string[];
  approved: boolean;
}

// ─── LLM Call ────────────────────────────────────────────────

async function callLLM(opts: {
  url: string;
  key: string;
  model: string;
  systemPrompt: string;
  userMessage: string;
}): Promise<string> {
  const res = await fetch(`${opts.url.replace(/\/+$/, '')}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${opts.key}`,
    },
    body: JSON.stringify({
      model: opts.model,
      messages: [
        { role: 'system', content: opts.systemPrompt },
        { role: 'user', content: opts.userMessage },
      ],
      temperature: 0.3,
      max_tokens: 2000,
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`LLM ${res.status}: ${body.slice(0, 200)}`);
  }

  const data = await res.json() as any;
  const content = data?.choices?.[0]?.message?.content;
  if (!content) throw new Error('Empty LLM response');
  return content;
}

// ─── Parse review ─────────────────────────────────────────────

function parseReviewResponse(raw: string): ReviewResult | null {
  // Strip markdown fences
  let cleaned = raw.trim();
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
  }

  try {
    const parsed = JSON.parse(cleaned);
    return {
      scores: parsed.scores ?? {},
      weighted_overall: parsed.weighted_overall ?? parsed.overall ?? 5,
      reviewer_confidence: parsed.reviewer_confidence ?? parsed.confidence ?? 0.5,
      comment: parsed.comment ?? parsed.summary ?? '',
      suggestions: Array.isArray(parsed.suggestions) ? parsed.suggestions : [],
      approved: parsed.approved ?? false,
    };
  } catch {
    // Try to find JSON object in the response
    const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      try {
        const parsed = JSON.parse(jsonMatch[0]);
        return {
          scores: parsed.scores ?? {},
          weighted_overall: parsed.weighted_overall ?? parsed.overall ?? 5,
          reviewer_confidence: parsed.reviewer_confidence ?? parsed.confidence ?? 0.5,
          comment: parsed.comment ?? parsed.summary ?? '',
          suggestions: Array.isArray(parsed.suggestions) ? parsed.suggestions : [],
          approved: parsed.approved ?? false,
        };
      } catch { return null; }
    }
    return null;
  }
}

// ─── Config Parsing ───────────────────────────────────────────

function parseArgs(argv: string[]): Record<string, string> {
  const args: Record<string, string> = {};
  for (let i = 2; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      const key = argv[i].slice(2);
      args[key] = argv[++i] ?? 'true';
    }
  }
  return args;
}

function loadConfigFromYaml(path: string): Partial<WorkerConfig> {
  // Minimal YAML parser for fleet config (no dependency needed)
  try {
    const content = readFileSync(path, 'utf-8');
    const config: any = {};
    for (const line of content.split('\n')) {
      const match = line.match(/^(\w+):\s*(.+)$/);
      if (match) {
        const [, key, value] = match;
        (config as any)[key] = value.trim().replace(/^['"]|['"]$/g, '');
      }
    }
    return config;
  } catch {
    return {};
  }
}

// ─── Worker ───────────────────────────────────────────────────

export class ReviewerWorker {
  private config: WorkerConfig;
  private sql!: ReturnType<typeof postgres>;
  private listening = false;
  private running = false;
  private activeReviews = 0;
  private totalReviewed = 0;
  private startTime = 0;

  // Cached agent/subscription data — refreshed periodically
  private agentCache = new Map<string, AgentRow>();            // id → agent
  private channelSubs = new Map<string, ChannelSubRow[]>();   // channel_name → subs
  private lastCacheRefresh = 0;
  private cacheTTL = 60_000; // 1 minute

  constructor(config: WorkerConfig) {
    this.config = config;
  }

  // ─── Cache ──────────────────────────────────────────────────

  private async refreshCache(): Promise<void> {
    if (Date.now() - this.lastCacheRefresh < this.cacheTTL) return;

    // Load all active agents
    const agents = await this.sql`SELECT id, principal_id, org_id, name, model, provider, llm_url, instructions, skills, type, status FROM clv_agents WHERE status = 'active'`;
    this.agentCache.clear();
    for (const a of agents) {
      this.agentCache.set((a as any).id, a as any);
    }

    // Load channel subscriptions with channel names
    const subs = await this.sql`SELECT cs.principal_id, cs.channel_id, ch.name FROM clv_channel_subscriptions cs JOIN clv_channels ch ON ch.id = cs.channel_id`;

    this.channelSubs.clear();
    for (const s of subs) {
      const list = this.channelSubs.get((s as any).name) ?? [];
      list.push(s as any);
      this.channelSubs.set((s as any).name, list);
    }

    this.lastCacheRefresh = Date.now();
    console.log(`  📋 Cache refreshed: ${this.agentCache.size} agents, ${this.channelSubs.size} channels subscribed`);
  }

  /** Find eligible agents for a task's channel, excluding agents that already reviewed */
  private async findEligibleAgent(task: TaskRow): Promise<(AgentRow & { principal_id: string }) | null> {
    await this.refreshCache();

    // 1. Find principals subscribed to this channel
    const subs = this.channelSubs.get(task.channel) ?? [];

    // 2. Get agents belonging to those principals
    const eligible = subs
      .map(sub => this.agentCache.get(sub.principal_id) ?? Array.from(this.agentCache.values()).find(a => a.principal_id === sub.principal_id))
      .filter((a): a is AgentRow & { principal_id: string } => {
        if (!a) return false;
        // Can't review your own task (different principal)
        if (a.principal_id === task.principal_id) return false;
        // Must have an LLM config
        if (!a.model && !this.config.model) return false;
        return true;
      });

    if (eligible.length === 0) return null;

    // 3. Exclude agents that already reviewed this task
    const existingReviews = await this.sql`
      SELECT reviewer_id FROM clv_reviews WHERE task_id = ${task.id}
    `;
    const reviewedBy = new Set(existingReviews.map((r: any) => r.reviewer_id));

    const notYetReviewed = eligible.filter(a => !reviewedBy.has(a.id));

    // 4. If we still have candidates, pick one (round-robin via random for now)
    if (notYetReviewed.length > 0) {
      return notYetReviewed[Math.floor(Math.random() * notYetReviewed.length)];
    }

    // All subscribed agents already reviewed — fall back to worker's default agent
    return null;
  }

  // ─── Lifecycle ──────────────────────────────────────────────

  async start(): Promise<void> {
    console.log('');
    console.log('╔══════════════════════════════════════════╗');
    console.log('║     CONCLAVE REVIEWER WORKER            ║');
    console.log('╚══════════════════════════════════════════╝');
    console.log('');
    console.log(`  DB:     ${this.config.databaseUrl.replace(/:[^:@]+@/, ':***@')}`);
    console.log(`  LLM:    ${this.config.llmUrl}`);
    console.log(`  Model:  ${this.config.model}`);
    console.log(`  Mode:   ${this.config.mode}`);
    console.log(`  Concurrency: ${this.config.maxConcurrent}`);
    console.log('');

    // Connect to PG
    this.sql = postgres(this.config.databaseUrl, {
      ssl: this.config.databaseUrl.includes('localhost') ? false : 'require',
      max: 5,
      idle_timeout: 30,
    });

    // Test connection
    await this.sql`SELECT 1 as ok`;
    console.log('  ✅ Database connected\n');

    // Load initial cache
    await this.refreshCache();

    // Start LISTEN
    await this.startListening();

    // Mark running
    this.running = true;
    this.startTime = Date.now();

    // Also poll as a safety net for missed notifications
    this.startPolling();

    // Status interval
    const statusInterval = setInterval(() => {
      if (!this.running) return;
      const uptime = Math.floor((Date.now() - this.startTime) / 60000);
      process.stdout.write(
        `\r[${new Date().toLocaleTimeString()}] ` +
        `Active: ${this.activeReviews} ` +
        `Total: ${this.totalReviewed} ` +
        `Uptime: ${uptime}m`
      );
    }, 30_000);

    // Keep alive
    await new Promise<void>((resolve) => {
      const shutdown = async (signal: string) => {
        console.log(`\n${signal} received, shutting down...`);
        this.running = false;
        clearInterval(statusInterval);
        await this.stop();
        resolve();
      };
      process.on('SIGINT', () => shutdown('SIGINT'));
      process.on('SIGTERM', () => shutdown('SIGTERM'));
    });
  }

  async stop(): Promise<void> {
    this.running = false;
    await this.sql.end();
    console.log('🛑 Worker stopped');
  }

  // ─── PG LISTEN ────────────────────────────────────────────

  private async startListening(): Promise<void> {
    await this.sql.listen('new_task', (payload: string) => {
      if (payload) {
        console.log(`\n📡 Received notification for task: ${payload}`);
        this.processNextTask().catch(err => {
          console.error('  ❌ Error processing notified task:', err.message);
        });
      }
    }, () => {
      console.log('  👂 LISTEN active on new_task channel');
    });
    this.listening = true;
    console.log('  👂 Listening for new_task notifications...\n');
  }

  // ─── Polling fallback ────────────────────────────────────

  private startPolling(): void {
    const poll = async () => {
      if (!this.running) return;
      try {
        await this.processNextTask();
      } catch (err: any) {
        console.error('  ⚠ Poll error:', err.message);
      }
    };

    // Initial poll for any tasks that came in before listener was ready
    poll();

    setInterval(poll, this.config.pollInterval * 1000);
  }

  // ─── Process next task (SKIP LOCKED) ─────────────────────

  private async processNextTask(): Promise<void> {
    if (this.activeReviews >= this.config.maxConcurrent) return;

    // Pick up a task that still needs reviews
    // status='open' = no reviews yet, status='in_review' = has some but needs more
    const result = await this.sql`
      UPDATE clv_tasks
      SET status = 'in_review'
      WHERE id = (
        SELECT t.id FROM clv_tasks t
        WHERE t.status IN ('open', 'in_review')
        ORDER BY t.priority DESC, t.created_at ASC
        LIMIT 1
        FOR UPDATE SKIP LOCKED
      )
      RETURNING id, agent_id, principal_id, description, output, dimensions, channel, metadata, requested_reviews
    `;

    if (result.length === 0) return;

    const task = result[0] as any as TaskRow;
    this.activeReviews++;

    try {
      console.log(`  🎯 Reviewing task ${task.id}: ${(task.description || '').slice(0, 60)}...`);
      await this.reviewTask(task);
      this.totalReviewed++;
    } catch (err: any) {
      console.error(`  ❌ Review failed for task ${task.id}:`, err.message);
      // Put task back to open so it can be retried
      try {
        await this.sql`
          UPDATE clv_tasks
          SET status = 'open', metadata = COALESCE(metadata, '{}'::jsonb) || ${JSON.stringify({ review_error: err.message })}::jsonb
          WHERE id = ${task.id}
        `;
      } catch { /* best effort */ }
    } finally {
      this.activeReviews--;
    }
  }

  // ─── Review a task ────────────────────────────────────────

  private async reviewTask(task: TaskRow): Promise<void> {
    // Find an eligible agent for this task's channel
    const agent = await this.findEligibleAgent(task);

    if (!agent) {
      console.log(`  ⏭️  No eligible agent for channel '${task.channel}' — skipping task ${task.id}`);
      // Put it back to open so it can be picked up later or by a default worker
      await this.sql`UPDATE clv_tasks SET status = 'open' WHERE id = ${task.id}`;
      return;
    }

    console.log(`  🤖 Using agent ${agent.name} (${agent.model || this.config.model}) for principal ${agent.principal_id}`);

    // Determine LLM config — agent-specific or fallback to worker defaults
    const llmUrl = agent.llm_url || this.config.llmUrl;
    const llmKey = this.config.llmKey; // API key is worker-level, not per-agent
    const model = agent.model || this.config.model;
    const systemPrompt = agent.instructions || this.config.systemPrompt || DEFAULT_REVIEW_PROMPT;

    // Build LLM prompt
    const dims = Array.isArray(task.dimensions)
      ? task.dimensions
      : (() => { try { return JSON.parse(task.dimensions || '[]'); } catch { return []; } })();

    const userMessage = [
      `## Task Description\n${task.description || 'No description provided'}`,
      `\n## Output to Review\n${task.output || 'No output provided'}`,
      dims.length > 0 ? `\n## Review Dimensions\n${dims.join(', ')}` : '',
      `\n## Channel\n${task.channel || 'default'}`,
    ].filter(Boolean).join('\n');

    // Call LLM
    const rawResponse = await callLLM({
      url: llmUrl,
      key: llmKey,
      model,
      systemPrompt,
      userMessage,
    });

    const review = parseReviewResponse(rawResponse);
    if (!review) {
      throw new Error(`Failed to parse LLM review response: ${rawResponse.slice(0, 100)}`);
    }

    // Normalize confidence 0-10 → 0-1
    const confidence = review.reviewer_confidence > 1
      ? review.reviewer_confidence / 10
      : review.reviewer_confidence;

    // Determine approval based on mode
    let approved: boolean;
    switch (this.config.mode) {
      case 'auto':
        approved = review.approved;
        break;
      case 'human':
        approved = false;
        break;
      case 'hybrid':
        approved = confidence >= this.config.confidenceThreshold ? review.approved : false;
        break;
      default:
        approved = review.approved;
    }

    // Write review under the real agent and principal
    const reviewId = `rev_${randomUUID()}`;
    const now = new Date().toISOString();

    await this.sql`
      INSERT INTO clv_reviews (id, task_id, reviewer_id, principal_id, scores, weighted_overall, reviewer_confidence, comment, suggestions, approved, status, created_at, updated_at)
      VALUES (
        ${reviewId},
        ${task.id},
        ${agent.id},
        ${agent.principal_id},
        ${JSON.stringify(review.scores)},
        ${review.weighted_overall},
        ${confidence},
        ${review.comment},
        ${JSON.stringify(review.suggestions)},
        ${approved ? 1 : 0},
        ${this.config.mode === 'human' ? 'pending_approval' : 'submitted'},
        ${now},
        ${now}
      )
    `;

    // Check if we've hit the requested review count
    const reviewCount = await this.sql`
      SELECT COUNT(*) as count FROM clv_reviews WHERE task_id = ${task.id}
    `;
    const currentCount = Number(reviewCount[0]?.count ?? 0);

    if (currentCount >= task.requested_reviews) {
      // All reviews in — mark task completed
      await this.sql`UPDATE clv_tasks SET status = 'completed' WHERE id = ${task.id}`;
      console.log(`  ✅ Task ${task.id}: ${currentCount}/${task.requested_reviews} reviews — completed! review=${reviewId} agent=${agent.name}`);
    } else {
      // More reviews needed — keep in_review so other agents can pick it up
      console.log(`  📝 Task ${task.id}: ${currentCount}/${task.requested_reviews} reviews — still in_review. review=${reviewId} agent=${agent.name}`);
    }
  }
}

// ─── Main ─────────────────────────────────────────────────────

async function main() {
  const args = parseArgs(process.argv);
  const configPath = args.config ?? 'fleet.yaml';

  const yamlConfig = existsSync(resolve(configPath)) ? loadConfigFromYaml(configPath) : {};
  const databaseUrl = process.env.DATABASE_URL || args.databaseUrl || '';
  if (!databaseUrl) {
    console.error('❌ DATABASE_URL is required. Set it as an env var or pass --database-url');
    process.exit(1);
  }

  const config: WorkerConfig = {
    ...DEFAULT_CONFIG,
    ...yamlConfig,
    databaseUrl,
    llmUrl: process.env.OLLAMA_URL || args.llmUrl || DEFAULT_CONFIG.llmUrl!,
    llmKey: process.env.OLLAMA_KEY || args.llmKey || DEFAULT_CONFIG.llmKey!,
    model: process.env.REVIEWER_MODEL || args.model || DEFAULT_CONFIG.model!,
    mode: (args.mode || process.env.REVIEWER_MODE || DEFAULT_CONFIG.mode) as WorkerConfig['mode'],
    confidenceThreshold: parseFloat(args.confidenceThreshold || process.env.CONFIDENCE_THRESHOLD || '') || DEFAULT_CONFIG.confidenceThreshold!,
    maxConcurrent: parseInt(args.maxConcurrent || process.env.MAX_CONCURRENT || '') || DEFAULT_CONFIG.maxConcurrent!,
    pollInterval: parseInt(args.pollInterval || process.env.POLL_INTERVAL || '') || DEFAULT_CONFIG.pollInterval!,
    systemPrompt: args.systemPrompt ? readFileSync(args.systemPrompt, 'utf-8') : undefined,
  } as WorkerConfig;

  const worker = new ReviewerWorker(config);
  await worker.start();
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});