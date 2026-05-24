/**
 * Conclave — Reviewer Worker (PG LISTEN/NOTIFY + SKIP LOCKED)
 *
 * Standalone process that connects directly to PostgreSQL, LISTENs for
 * `new_task` notifications, picks up pending tasks with SELECT FOR UPDATE
 * SKIP LOCKED (preventing duplicate reviews across workers), calls the
 * configured LLM backend, and writes the review back to the database.
 *
 * Why this exists:
 *   - The HTTP-based FleetManager polls every N seconds — high latency.
 *   - The GitHub Actions cron splits into /v1/cron/next + /v1/cron/submit
 *     with LLM calls in Actions YAML — fragile escaping, 6h cold starts.
 *   - This worker runs as a persistent process next to (or on) the server,
 *     gets instant notification via pg_notify, and uses the same PG connection
 *     the app already uses. No new infra.
 *
 * Usage:
 *   npx tsx src/workers/reviewer.ts
 *   DATABASE_URL=postgres://... npx tsx src/workers/reviewer.ts
 *   npx tsx src/workers/reviewer.ts --config fleet.yaml
 */

import postgres from 'postgres';
import { randomUUID } from 'crypto';
import { existsSync, readFileSync } from 'fs';
import { resolve } from 'path';

// ─── Config ───────────────────────────────────────────────────

export interface WorkerConfig {
  databaseUrl: string;
  /** OpenAI-compatible chat completions endpoint */
  llmUrl: string;
  /** API key for the LLM endpoint */
  llmKey: string;
  /** Model name (e.g. 'deepseek-v4-flash') */
  model: string;
  /** Review mode: auto | human | hybrid */
  mode: 'auto' | 'human' | 'hybrid';
  /** Confidence threshold for hybrid mode (0-1). Auto-submit if >= threshold. */
  confidenceThreshold: number;
  /** Max concurrent LLM calls */
  maxConcurrent: number;
  /** Poll interval (seconds) as fallback when LISTEN disconnects */
  pollInterval: number;
  /** Custom system prompt */
  systemPrompt?: string;
}

const DEFAULT_CONFIG: Partial<WorkerConfig> = {
  llmUrl: process.env.OLLAMA_URL || 'https://www.ollama.com/v1',
  llmKey: process.env.OLLAMA_KEY || '',
  model: process.env.REVIEWER_MODEL || 'deepseek-v4-flash',
  mode: 'auto',
  confidenceThreshold: 0.7,
  maxConcurrent: 3,
  pollInterval: 30,
};

function parseArgs(argv: string[]): Record<string, string> {
  const args: Record<string, string> = {};
  for (let i = 2; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      const key = argv[i].slice(2).replace(/-./g, s => s[1].toUpperCase());
      args[key] = argv[i + 1] ?? '';
      i++;
    }
  }
  return args;
}

function loadConfigFromYaml(path: string): Partial<WorkerConfig> {
  // Minimal YAML parsing for fleet.yaml — just enough to extract reviewer settings
  // For full config, use the FleetManager's parseFleetConfig
  if (!existsSync(path)) return {};
  const raw = readFileSync(path, 'utf-8');
  const config: Partial<WorkerConfig> = {};
  // Extract server/reviewer fields from fleet.yaml
  const serverMatch = raw.match(/server:\s*["']?([^"'\n]+)/);
  if (serverMatch) config.llmUrl = serverMatch[1];
  // Use the first reviewer found
  const modelMatch = raw.match(/model:\s*["']?([^"'\n]+)/);
  if (modelMatch) config.model = modelMatch[1];
  const modeMatch = raw.match(/mode:\s*["']?([^"'\n]+)/);
  if (modeMatch) config.mode = modeMatch[1] as WorkerConfig['mode'];
  return config;
}

// ─── LLM Client ───────────────────────────────────────────────

interface LLMResponse {
  scores: Record<string, number>;
  weighted_overall: number;
  reviewer_confidence: number;
  comment: string;
  suggestions: string[];
  approved: boolean;
}

const DEFAULT_REVIEW_PROMPT = `You are a quality reviewer for AI agent outputs. Evaluate the task output on these dimensions:
- relevance (1-10): Does the output address the task description?
- accuracy (1-10): Is the output factually correct?
- completeness (1-10): Does the output cover all aspects requested?
- clarity (1-10): Is the output well-structured and easy to understand?

Respond ONLY with a JSON block:
\`\`\`json
{
  "scores": { "relevance": N, "accuracy": N, "completeness": N, "clarity": N },
  "weighted_overall": N,
  "reviewer_confidence": N,
  "comment": "Brief review comment (20-1500 chars)",
  "suggestions": ["suggestion1", "suggestion2"],
  "approved": true_or_false
}
\`\`\`

Approve if weighted_overall >= 7. Confidence is 0-10 scale (will be normalized to 0-1).`;

async function callLLM(opts: {
  url: string;
  key: string;
  model: string;
  systemPrompt: string;
  userMessage: string;
  signal?: AbortSignal;
}): Promise<string> {
  let endpoint = opts.url.replace(/\/$/, '');
  if (endpoint.endsWith('/v1')) {
    endpoint += '/chat/completions';
  } else if (!endpoint.includes('/chat/completions')) {
    endpoint += '/v1/chat/completions';
  }

  const resp = await fetch(endpoint, {
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
    signal: opts.signal,
  });

  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    throw new Error(`LLM API error ${resp.status}: ${body.slice(0, 200)}`);
  }

  const data = await resp.json() as any;
  return data.choices?.[0]?.message?.content ?? '';
}

function parseReviewResponse(raw: string): LLMResponse | null {
  try {
    const jsonMatch = raw.match(/```json\s*([\s\S]*?)\s*```/) || raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;
    const obj = JSON.parse(jsonMatch[1] ?? jsonMatch[0]);

    return {
      scores: obj.scores ?? {},
      weighted_overall: obj.weighted_overall ?? obj.overall ?? 0,
      reviewer_confidence: obj.reviewer_confidence ?? obj.confidence ?? 5,
      comment: obj.comment ?? obj.review ?? '',
      suggestions: obj.suggestions ?? [],
      approved: obj.approved ?? (obj.weighted_overall ?? obj.overall ?? 0) >= 7,
    };
  } catch {
    return null;
  }
}

// ─── Reviewer Worker ─────────────────────────────────────────

export class ReviewerWorker {
  private config: WorkerConfig;
  private sql!: ReturnType<typeof postgres>;
  private listening = false;
  private running = false;
  private activeReviews = 0;
  private totalReviewed = 0;
  private startTime = 0;

  constructor(config: Partial<WorkerConfig> & { databaseUrl: string }) {
    this.config = { ...DEFAULT_CONFIG, ...config } as WorkerConfig;
  }

  async start(): Promise<void> {
    console.log('╔══════════════════════════════════════════╗');
    console.log('║     CONCLAVE REVIEWER WORKER            ║');
    console.log('╚══════════════════════════════════════════╝\n');
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
    if (this.listening) {
      // postgres-js listen returns a handle with unlisten()
      // Since we used sql.listen(), we don't need to UNLISTEN manually
      // The connection will be cleaned up on sql.end()
    }
    await this.sql.end();
    console.log('🛑 Worker stopped');
  }

  // ─── PG LISTEN ────────────────────────────────────────────

  private async startListening(): Promise<void> {
    // postgres-js listen API: sql.listen(channel, onnotify, onlisten?)
    // Creates a dedicated connection that auto-reconnects
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

    // SELECT FOR UPDATE SKIP LOCKED — atomic task pickup
    // This prevents duplicate reviews across multiple worker instances
    const result = await this.sql`
      UPDATE clv_tasks
      SET status = 'in_review'
      WHERE id = (
        SELECT id FROM clv_tasks
        WHERE status = 'open'
        ORDER BY priority DESC, created_at ASC
        LIMIT 1
        FOR UPDATE SKIP LOCKED
      )
      RETURNING id, agent_id, principal_id, description, output, dimensions, channel, metadata
    `;

    if (result.length === 0) return; // No pending tasks

    const task = result[0];
    this.activeReviews++;

    try {
      console.log(`  🎯 Reviewing task ${task.id}: ${(task.description || '').slice(0, 60)}...`);
      await this.reviewTask(task as any);
      this.totalReviewed++;
    } catch (err: any) {
      console.error(`  ❌ Review failed for task ${task.id}:`, err.message);
      // Mark task as failed so it can be retried
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

  private async reviewTask(task: {
    id: string;
    agent_id: string;
    principal_id: string;
    description: string;
    output: string;
    dimensions: any;
    channel: string;
    metadata: any;
  }): Promise<void> {
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

    const systemPrompt = this.config.systemPrompt || DEFAULT_REVIEW_PROMPT;

    // Call LLM
    const rawResponse = await callLLM({
      url: this.config.llmUrl,
      key: this.config.llmKey,
      model: this.config.model,
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
        approved = false; // Always queue for human review
        break;
      case 'hybrid':
        approved = confidence >= this.config.confidenceThreshold ? review.approved : false;
        break;
      default:
        approved = review.approved;
    }

    // Write review to DB (raw SQL — reviewer_id is a FK to agents, but the worker
    // may not be a registered agent. We use a synthetic reviewer_id pattern.)
    // If the worker's reviewer_id doesn't exist in clv_agents, we insert a stub.
    const reviewId = `rev_${randomUUID()}`;
    const reviewerId = `worker_${this.config.model.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
    const now = new Date().toISOString();

    // Ensure the worker agent exists (idempotent)
    await this.sql`
      INSERT INTO clv_agents (id, principal_id, name, model, provider, llm_url, instructions, skills, type, status, created_at, updated_at)
      VALUES (${reviewerId}, 'prn_system', ${'[Worker] ' + this.config.model}, ${this.config.model}, 'conclave-worker', ${this.config.llmUrl}, 'Automated reviewer worker', '[]', 'worker', 'active', ${now}, ${now})
      ON CONFLICT (id) DO NOTHING
    `;

    // Ensure system principal exists (idempotent)
    await this.sql`
      INSERT INTO clv_principals (id, name, roles, capabilities, status, created_at, updated_at)
      VALUES ('prn_system', 'Conclave Worker System', '["system"]', '["review"]', 'active', ${now}, ${now})
      ON CONFLICT (id) DO NOTHING
    `;

    await this.sql`
      INSERT INTO clv_reviews (id, task_id, reviewer_id, principal_id, scores, weighted_overall, reviewer_confidence, comment, suggestions, approved, status, created_at, updated_at)
      VALUES (
        ${reviewId},
        ${task.id},
        ${reviewerId},
        'prn_system',
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

    // Mark task as completed
    await this.sql`
      UPDATE clv_tasks
      SET status = 'completed'
      WHERE id = ${task.id}
    `;

    const icon = approved ? '✅' : '❌';
    console.log(`  ${icon} Task ${task.id}: review=${reviewId} overall=${review.weighted_overall} conf=${confidence.toFixed(2)} approved=${approved}`);
  }
}

// ─── Main ─────────────────────────────────────────────────────

async function main() {
  const args = parseArgs(process.argv);
  const configPath = args.config ?? 'fleet.yaml';

  // Build config: env > yaml > defaults
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