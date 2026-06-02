/**
 * Conclave — Opinion Router
 *
 * Poll-based worker that detects new opinions, finds eligible critics
 * via channel subscriptions (round-robin), calls the LLM for each,
 * and creates CritiqueNodes on the Blackboard.
 *
 * Usage:
 *   DATABASE_URL=postgres://... npx tsx src/fleet/opinion-router.ts
 *
 * Env vars:
 *   SERVER_URL      — Conclave API server (default: https://conclave-roan.vercel.app)
 *   DATABASE_URL    — PostgreSQL connection string
 *   FLEET_TOKEN     — Org token for API auth
 *   OLLAMA_URL      — Default LLM URL for fallback
 *   OLLAMA_KEY      — Default LLM key
 *   OPINION_MODEL   — Model for opinion critique
 *   POLL_INTERVAL   — Seconds between opinion polls (default: 15)
 *   MAX_CONCURRENT  — Max opinion critiques at once (default: 3)
 */

import { randomUUID } from 'crypto';
import { existsSync, readFileSync } from 'fs';
import { resolve } from 'path';
import { getProviderConfig, resolveLlmUrl, buildAuthHeaders } from './providers.js';

// ─── Types ──────────────────────────────────────────────────────

interface OpinionRow {
  id: string;
  agent_id: string;
  principal_id: string;
  question: string;
  context: string | null;
  channel: string;
  requested_opinions: number;
  deadline: string | null;
  status: string;
}

interface ChannelSubRow {
  principal_id: string;
}

interface CriticAgent {
  id: string;
  name: string | null;
  principal_id: string;
  org_id: string;
  model: string | null;
  provider: string | null;
  llm_url: string | null;
  token: string | null;
}

interface RouterConfig {
  databaseUrl: string;
  serverUrl: string;
  token: string;
  llmUrl: string;
  llmKey: string;
  model: string;
  pollInterval: number;
  maxConcurrent: number;
}

const DEFAULT_ROUTER_CONFIG: RouterConfig = {
  databaseUrl: '',
  serverUrl: process.env.SERVER_URL || 'https://conclave-roan.vercel.app',
  token: process.env.FLEET_TOKEN || process.env.CONCLAVE_TOKEN || '',
  llmUrl: process.env.OLLAMA_URL || 'https://ollama.com/api/chat',
  llmKey: process.env.OLLAMA_KEY || '',
  model: process.env.OPINION_MODEL || 'deepseek-v4-flash',
  pollInterval: parseInt(process.env.POLL_INTERVAL || '15', 10),
  maxConcurrent: parseInt(process.env.MAX_CONCURRENT || '3', 10),
};

// ─── Prompt Builder ────────────────────────────────────────────

function buildOpinionCritiquePrompt(question: string, context: string | null, channel: string): string {
  let prompt = `You are a thoughtful consultant providing critical analysis of a question posed by another agent.

## Question

${question}

## Channel

${channel}

## Your Task

Provide a critical analysis of this question. Consider:

1. What assumptions are embedded in the question?
2. What perspectives might be missing?
3. What risks or edge cases should the asker consider?
4. What alternative approaches exist?

Be specific and constructive. Focus on substance, not style.

## Output Format

Respond with a JSON block:

\`\`\`json
{
  "concerns": ["specific concern 1", "specific concern 2", "specific concern 3"],
  "suggestions": ["suggestion 1", "suggestion 2"],
  "confidence": 0.85,
  "reasoning": "Your reasoning process — why these concerns matter and how they relate to the question."
}
\`\`\``;

  if (context) {
    prompt += `\n\n## Additional Context\n\n${context}`;
  }

  return prompt;
}

// ─── LLM Call ──────────────────────────────────────────────────

async function callOpinionCritiqueLLM(
  model: string,
  systemPrompt: string,
  llmUrl: string,
  llmKey: string,
): Promise<{ concerns: string[]; suggestions: string[]; confidence: number; reasoning: string } | null> {
  const provider = 'ollama_cloud';
  const config = getProviderConfig(provider);
  const endpoint = resolveLlmUrl(provider, llmUrl).replace(/\/$/, '');

  const payload = config.adaptPayload
    ? config.adaptPayload({
        model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: 'Please provide your critical analysis of this question.' },
        ],
        temperature: 0.5,
        max_tokens: 2000,
        stream: false,
      })
    : {
        model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: 'Please provide your critical analysis of this question.' },
        ],
        temperature: 0.5,
        max_tokens: 2000,
        stream: false,
      };

  console.log(`  [OpinionRouter] LLM call: model=${model} url=${endpoint}`);

  const resp = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...buildAuthHeaders(provider, llmKey),
    },
    body: JSON.stringify(payload),
  });

  if (!resp.ok) {
    const bodyText = await resp.text().catch(() => '');
    throw new Error(`LLM API error ${resp.status}: ${bodyText.slice(0, 200)}`);
  }

  const data = (await resp.json()) as any;
  const content = config.parseResponse(data) ?? '';

  // Try to extract JSON
  const jsonMatch = content.match(/```json\s*([\s\S]*?)```/) || content.match(/{[\s\S]*?}/);
  if (!jsonMatch) {
    console.warn(`  [OpinionRouter] No JSON found in LLM response: ${content.slice(0, 100)}...`);
    return null;
  }

  try {
    const obj = JSON.parse(jsonMatch[1] ?? jsonMatch[0]);
    return {
      concerns: Array.isArray(obj.concerns) ? obj.concerns : [obj.concerns ?? 'No specific concerns'],
      suggestions: Array.isArray(obj.suggestions) ? obj.suggestions : [],
      confidence: typeof obj.confidence === 'number' ? Math.min(1, Math.max(0, obj.confidence)) : 0.5,
      reasoning: obj.reasoning ?? '',
    };
  } catch {
    console.warn(`  [OpinionRouter] Failed to parse JSON from LLM response`);
    return null;
  }
}

// ─── Args ──────────────────────────────────────────────────────

function parseArgs(argv: string[]): Record<string, string> {
  const args: Record<string, string> = {};
  for (let i = 2; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      const key = argv[i].slice(2).replace(/-./g, (s) => s[1].toUpperCase());
      args[key] = argv[i + 1] ?? '';
      i++;
    }
  }
  return args;
}

// ─── Opinion Router ────────────────────────────────────────────

export class OpinionRouter {
  private sql: any;
  private config: RouterConfig;
  private running = false;
  private activeReviews = 0;
  private totalRouted = 0;
  private startTime = 0;
  private roundRobinIndex = 0;

  constructor(config: Partial<RouterConfig> = {}) {
    this.config = { ...DEFAULT_ROUTER_CONFIG, ...config };
  }

  async start(): Promise<void> {
    console.log('╔══════════════════════════════════════════╗');
    console.log('║      CONCLAVE OPINION ROUTER            ║');
    console.log('╚══════════════════════════════════════════╝\n');

    console.log(`  Server:   ${this.config.serverUrl}`);
    console.log(`  Model:    ${this.config.model}`);
    console.log(`  Poll:     every ${this.config.pollInterval}s`);
    console.log(`  Max:      ${this.config.maxConcurrent} concurrent`);
    console.log('');

    // Connect to PG
    const postgres = (await import('postgres')).default;
    this.sql = postgres(this.config.databaseUrl, {
      ssl: this.config.databaseUrl.includes('localhost') ? false : 'require',
      max: 5,
      idle_timeout: 30,
    });

    await this.sql`SELECT 1 as ok`;
    console.log('  ✅ Database connected\n');

    // Start PG LISTEN
    await this.startListening();
    this.running = true;
    this.startTime = Date.now();

    // Start polling
    this.startPolling();

    // Status display
    const statusInterval = setInterval(() => {
      if (!this.running) return;
      const uptime = Math.floor((Date.now() - this.startTime) / 60000);
      process.stdout.write(
        `\r[${new Date().toLocaleTimeString()}] ` +
          `Active: ${this.activeReviews} ` +
          `Routed: ${this.totalRouted} ` +
          `Uptime: ${uptime}m`,
      );
    }, 30_000);

    // Keep alive
    await new Promise<void>((resolve) => {
      const shutdown = async (signal: string) => {
        console.log(`\n${signal} received, shutting down...`);
        this.running = false;
        clearInterval(statusInterval);
        await this.sql.end();
        console.log('🛑 Opinion Router stopped');
        resolve();
      };
      process.on('SIGINT', () => shutdown('SIGINT'));
      process.on('SIGTERM', () => shutdown('SIGTERM'));
    });
  }

  // ─── PG LISTEN ─────────────────────────────────────────

  private async startListening(): Promise<void> {
    await this.sql.listen('new_opinion', (payload: string) => {
      if (payload) {
        console.log(`\n📡 Received notification for opinion: ${payload}`);
        this.processNextOpinion().catch((err: Error) => {
          console.error('  ❌ Error processing notified opinion:', err.message);
        });
      }
    });
    console.log('  👂 Listening for new_opinion notifications...\n');
  }

  // ─── Polling ──────────────────────────────────────────

  private startPolling(): void {
    const poll = async () => {
      if (!this.running) return;
      try {
        await this.processNextOpinion();
      } catch (err: any) {
        console.error('  ⚠ Poll error:', err.message);
      }
    };

    // Initial poll
    poll();
    setInterval(poll, this.config.pollInterval * 1000);
  }

  // ─── Process Next Opinion ─────────────────────────────

  private async processNextOpinion(): Promise<void> {
    if (this.activeReviews >= this.config.maxConcurrent) return;

    // Claim an open opinion via SKIP LOCKED
    const result = await this.sql`
      UPDATE clv_opinions
      SET status = 'in_review'
      WHERE id = (
        SELECT id FROM clv_opinions
        WHERE status = 'open'
        ORDER BY created_at ASC
        LIMIT 1
        FOR UPDATE SKIP LOCKED
      )
      RETURNING id, agent_id, principal_id, question, context, channel, requested_opinions, deadline, status
    `;

    if (result.length === 0) return;

    const opinion = result[0] as any as OpinionRow;
    this.activeReviews++;

    try {
      console.log(`  🎯 Routing opinion ${opinion.id}: "${(opinion.question || '').slice(0, 60)}..."`);
      await this.routeOpinion(opinion);
      this.totalRouted++;
    } catch (err: any) {
      console.error(`  ❌ Routing failed for opinion ${opinion.id}:`, err.message);
      // Put it back to open with retry info
      const meta = JSON.stringify({ route_error: err.message, routed_at: new Date().toISOString() });
      await this.sql`
        UPDATE clv_opinions
        SET status = 'open', metadata = ${meta}
        WHERE id = ${opinion.id}
      `;
    } finally {
      this.activeReviews--;
    }
  }

  // ─── Route an Opinion ────────────────────────────────

  private async routeOpinion(opinion: OpinionRow): Promise<void> {
    const serverUrl = this.config.serverUrl;
    const token = this.config.token;

    // 1. Auto-create ProposalNode
    const proposalNodeId = `nd_${randomUUID().replace(/-/g, '').slice(0, 24)}`;

    const nodeResp = await fetch(`${serverUrl}/v1/opinions/${opinion.id}/nodes`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({
        kind: 'proposal',
        content: {
          question: opinion.question,
          context: opinion.context ?? undefined,
        },
      }),
    });

    if (!nodeResp.ok) {
      const errBody = await nodeResp.text().catch(() => '');
      console.warn(`  ⚠ ProposalNode creation: ${nodeResp.status} ${errBody.slice(0, 150)}`);
    } else {
      const nodeData = (await nodeResp.json()) as any;
      console.log(`  📝 ProposalNode created: ${nodeData?.data?.id ?? proposalNodeId}`);
    }

    // 2. Find eligible critics — other principals subscribed to the opinion's channel
    const subscribers = await this.sql<ChannelSubRow[]>`
      SELECT cs.principal_id
      FROM clv_channel_subscriptions cs
      JOIN clv_channels ch ON ch.id = cs.channel_id
      WHERE ch.name = ${opinion.channel}
      AND cs.principal_id != ${opinion.principal_id}
    `;

    if (subscribers.length === 0) {
      console.log(`  ⏭ No other subscribers on channel '${opinion.channel}' — nothing to route`);
      await this.sql`UPDATE clv_opinions SET status = 'open' WHERE id = ${opinion.id}`;
      return;
    }

    // Round-robin: pick up to requested_opinions subscribers
    const count = Math.min(opinion.requested_opinions || 3, subscribers.length);
    const selected: ChannelSubRow[] = [];
    for (let i = 0; i < count; i++) {
      const idx = (this.roundRobinIndex + i) % subscribers.length;
      selected.push(subscribers[idx]);
    }
    this.roundRobinIndex = (this.roundRobinIndex + count) % subscribers.length;

    console.log(`  👥 Selected ${selected.length} critics (${selected.map((s) => s.principal_id).join(', ')})`);

    // 3. For each critic, find one of their agents and call LLM
    const systemPrompt = buildOpinionCritiquePrompt(opinion.question, opinion.context, opinion.channel);

    const critiquePromises = selected.map(async (sub) => {
      try {
        // Find an eligible agent for this principal
        const agents = await this.sql<CriticAgent[]>`
          SELECT id, name, principal_id, org_id, model, provider, llm_url, token
          FROM clv_agents
          WHERE principal_id = ${sub.principal_id}
            AND status = 'active'
          ORDER BY created_at ASC
          LIMIT 1
        `;

        if (agents.length === 0) {
          console.log(`  ⏭ Principal ${sub.principal_id} has no active agents — skipping`);
          return null;
        }

        const agent = agents[0];
        const model = agent.model || this.config.model;
        const llmUrl = agent.llm_url || this.config.llmUrl;
        const llmKey = this.config.llmKey;

        console.log(`  🤖 Critic ${agent.name || agent.id} (${model}) for ${sub.principal_id}`);

        // Call LLM
        const result = await callOpinionCritiqueLLM(model, systemPrompt, llmUrl, llmKey);

        if (!result) {
          console.warn(`  ⚠ LLM returned no parseable result for ${agent.id}`);
          return null;
        }

        // Create CritiqueNode via REST API
        const critiqueResp = await fetch(`${serverUrl}/v1/opinions/${opinion.id}/nodes`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
          body: JSON.stringify({
            kind: 'critique',
            content: {
              concerns: result.concerns,
              suggestions: result.suggestions,
              confidence: result.confidence,
              reasoning: result.reasoning,
            },
            parent_node_id: proposalNodeId,
            parent_edge_kind: 'critiques',
          }),
        });

        if (!critiqueResp.ok) {
          const errBody = await critiqueResp.text().catch(() => '');
          console.warn(`  ⚠ CritiqueNode creation: ${critiqueResp.status} ${errBody.slice(0, 150)}`);
          return null;
        }

        const critiqueData = (await critiqueResp.json()) as any;
        console.log(`  ✅ CritiqueNode created: ${critiqueData?.data?.id} for ${agent.name || agent.id}`);
        return critiqueData?.data;
      } catch (err: any) {
        console.warn(`  ⚠ Critic ${sub.principal_id} failed: ${err.message}`);
        return null;
      }
    });

    const critiques = await Promise.all(critiquePromises);
    const succeeded = critiques.filter(Boolean).length;

    // 4. Update opinion status
    if (succeeded >= count) {
      // All critics responded — move to synthesis phase
      console.log(`  ✅ Opinion ${opinion.id}: ${succeeded}/${count} critiques received — ready for synthesis`);
      await this.sql`UPDATE clv_opinions SET status = 'open' WHERE id = ${opinion.id}`;
    } else if (succeeded > 0) {
      // Some critics responded — still usable
      console.log(`  ⚠ Opinion ${opinion.id}: ${succeeded}/${count} critiques received (partial)`);
      await this.sql`UPDATE clv_opinions SET status = 'open' WHERE id = ${opinion.id}`;
    } else {
      // All critics failed — put back
      console.log(`  ❌ Opinion ${opinion.id}: all critics failed`);
      await this.sql`UPDATE clv_opinions SET status = 'open' WHERE id = ${opinion.id}`;
    }
  }
}

// ─── Main ─────────────────────────────────────────────────────

async function main() {
  const args = parseArgs(process.argv);
  const configPath = args.config ?? 'fleet.yaml';

  const yamlConfig: any = {};
  if (configPath && existsSync(resolve(configPath))) {
    try {
      const raw = readFileSync(resolve(configPath), 'utf-8');
      Object.assign(yamlConfig, JSON.parse(raw) || {});
    } catch {
      // Not JSON, skip
    }
  }

  const databaseUrl = process.env.DATABASE_URL || args.databaseUrl || '';
  if (!databaseUrl) {
    console.error('❌ DATABASE_URL is required. Set it as an env var or pass --database-url');
    process.exit(1);
  }

  const config: RouterConfig = {
    ...DEFAULT_ROUTER_CONFIG,
    ...yamlConfig,
    databaseUrl,
    serverUrl: process.env.SERVER_URL || args.serverUrl || DEFAULT_ROUTER_CONFIG.serverUrl,
    token: process.env.FLEET_TOKEN || process.env.CONCLAVE_TOKEN || args.token || DEFAULT_ROUTER_CONFIG.token,
    llmUrl: process.env.OLLAMA_URL || args.llmUrl || DEFAULT_ROUTER_CONFIG.llmUrl,
    llmKey: process.env.OLLAMA_KEY || args.llmKey || DEFAULT_ROUTER_CONFIG.llmKey,
    model: process.env.OPINION_MODEL || args.model || DEFAULT_ROUTER_CONFIG.model,
    pollInterval: parseInt(process.env.POLL_INTERVAL || args.pollInterval || '', 10) || DEFAULT_ROUTER_CONFIG.pollInterval,
    maxConcurrent: parseInt(process.env.MAX_CONCURRENT || args.maxConcurrent || '', 10) || DEFAULT_ROUTER_CONFIG.maxConcurrent,
  };

  const router = new OpinionRouter(config);
  await router.start();
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});