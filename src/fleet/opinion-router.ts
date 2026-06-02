/**
 * Conclave — Opinion Router (Slice 3)
 *
 * Full Democratic topology state machine:
 *   open → critiquing → synthesizing → voting → closed
 *                         ↑              |
 *                         └──────────────┘ (loop on follow-up CritiqueNode)
 *
 * Handles:
 * - Polls for open opinions, SKIP LOCKED pick
 * - Assigns critics via round-robin, calls LLM in parallel for CritiqueNodes
 * - Detects synthesis-ready state → sets opinion to 'synthesizing'
 * - Detects new synthesis → triggers sequential vote round
 * - Detects consensus via graph: all approved → closed, any follow-up → loop back
 * - Hard 10-node limit → force close
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
import crypto from 'crypto';

// ─── Vault Key Resolution ──────────────────────────────────

/**
 * Decrypt a vault-encrypted value using AES-256-CBC.
 * Used by resolveVaultKey when direct DB access is available.
 */
function decryptVaultValue(encryptedData: string): string {
  const ENCRYPTION_KEY = process.env.VAULT_MASTER_KEY || 'dev-master-key-32-chars-long-!!!';
  // Format is ivHex.encryptedHex (separated by DOT, not colon!)
  const [ivHex, encryptedHex] = encryptedData.split('.');
  if (!ivHex || !encryptedHex) return encryptedData;
  const iv = Buffer.from(ivHex, 'hex');
  const encryptedText = Buffer.from(encryptedHex, 'hex');
  const decipher = crypto.createDecipheriv('aes-256-cbc', Buffer.from(ENCRYPTION_KEY), iv);
  let decrypted = decipher.update(encryptedText);
  decrypted = Buffer.concat([decrypted, decipher.final()]);
  return decrypted.toString();
}

/**
 * Resolve a vault reference (org_{provider}) OR decrypt an encrypted key.
 * Uses direct postgres query + AES decryption — no Drizzle dependency needed.
 */
async function resolveVaultKey(sql: any, key: string, orgId: string): Promise<string> {
  if (!key) return key;

  // Check if it's a vault reference (org_{provider})
  if (key.startsWith('org_')) {
    const providerName = key.replace(/^org_/, '');
    console.log(`  🔑 Resolving vault key '${key}' for provider '${providerName}' in org '${orgId}'`);

    try {
      // Query the vault table directly
      const vaultRows = await sql<any[]>`
        SELECT provider, key_value
        FROM clv_org_vault
        WHERE org_id = ${orgId}
          AND provider = ${providerName}
        LIMIT 1
      `;

      if (vaultRows.length === 0) {
        console.warn(`  ⚠ Vault key '${key}' not found for org '${orgId}', using fallback`);
        return key;
      }

      const vaultEntry = vaultRows[0];
      const encryptedValue = vaultEntry.key_value;

      // Check if it's already a raw key (doesn't look encrypted - no dot separator)
      if (!encryptedValue.includes('.')) {
        console.log(`  🔑 Vault key resolved (raw) for ${providerName}`);
        return encryptedValue;
      }

      // Decrypt the vault value (format: iv.ciphertext)
      const decrypted = decryptVaultValue(encryptedValue);
      console.log(`  🔑 Vault key resolved (decrypted) for ${providerName}`);
      return decrypted;
    } catch (err: any) {
      console.warn(`  ⚠ Vault key resolution failed for '${key}': ${err.message}`);
      return key;
    }
  }

  // Check if it's an already-encrypted key (has dot separator like "iv.ciphertext")
  // These are keys stored directly in fleet_reviewers.llm_key, already encrypted
  if (key.includes('.') && !key.startsWith('sk-')) {
    console.log(`  🔑 Attempting to decrypt stored key (format: iv.ciphertext)`);
    try {
      const decrypted = decryptVaultValue(key);
      console.log(`  🔑 Key decrypted successfully`);
      return decrypted;
    } catch (err: any) {
      console.warn(`  ⚠ Key decryption failed: ${err.message}, using as-is`);
      return key;
    }
  }

  // Raw key, return as-is
  return key;
}

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
  close_tag: string | null;
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

interface BlackboardNode {
  id: string;
  opinion_id: string;
  payload_type: string;
  author_id: string;
  round: number;
  content: any;
  created_at: string;
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

const HARD_NODE_LIMIT = 10;

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

function buildVotePrompt(
  question: string,
  context: string | null,
  critiques: string[],
  synthesis: string | null,
  priorVotes: string[],
): string {
  let prompt = `You are evaluating a synthesis produced by the asker in response to your critiques.

## Original Question

${question}

## Your Prior Critique

${critiques.join('\n\n')}

## Synthesis (asker's response)

${synthesis || 'No synthesis yet'}

## Prior Votes (for sequential context)

${priorVotes.length > 0 ? priorVotes.join('\n\n') : 'No prior votes yet — you are the first voter.'}

## Your Task

Review the synthesis. Did it adequately address your concerns? If so, vote APPROVED. If not, provide follow-up critique.

## Output Format

Respond with a JSON block:

\`\`\`json
{
  "approved": true,
  "agreement_level": 0.85,
  "conditions": [],
  "reasoning": "Why you approve or disagree with the synthesis."
}
\`\`\`

Set approved: false to trigger a follow-up critique round.`;

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

async function callVoteLLM(
  model: string,
  systemPrompt: string,
  llmUrl: string,
  llmKey: string,
): Promise<{ approved: boolean; agreement_level: number; conditions: string[]; reasoning: string } | null> {
  const provider = 'ollama_cloud';
  const config = getProviderConfig(provider);
  const endpoint = resolveLlmUrl(provider, llmUrl).replace(/\/$/, '');

  const payload = config.adaptPayload
    ? config.adaptPayload({
        model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: 'Please evaluate the synthesis and cast your vote.' },
        ],
        temperature: 0.5,
        max_tokens: 2000,
        stream: false,
      })
    : {
        model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: 'Please evaluate the synthesis and cast your vote.' },
        ],
        temperature: 0.5,
        max_tokens: 2000,
        stream: false,
      };

  console.log(`  [OpinionRouter] Vote LLM call: model=${model} url=${endpoint}`);

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

  const jsonMatch = content.match(/```json\s*([\s\S]*?)```/) || content.match(/{[\s\S]*?}/);
  if (!jsonMatch) {
    console.warn(`  [OpinionRouter] No JSON found in vote response: ${content.slice(0, 100)}...`);
    return null;
  }

  try {
    const obj = JSON.parse(jsonMatch[1] ?? jsonMatch[0]);
    return {
      approved: obj.approved === true,
      agreement_level: typeof obj.agreement_level === 'number' ? Math.min(1, Math.max(0, obj.agreement_level)) : 0.5,
      conditions: Array.isArray(obj.conditions) ? obj.conditions : [],
      reasoning: obj.reasoning ?? '',
    };
  } catch {
    console.warn(`  [OpinionRouter] Failed to parse vote JSON`);
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
    console.log('║    CONCLAVE OPINION ROUTER — Slice 3    ║');
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
    await this.sql.listen('opinion_node_submitted', (payload: string) => {
      if (payload) {
        console.log(`\n📡 Node submitted notification for opinion: ${payload}`);
        this.handleNodeSubmitted(payload).catch((err: Error) => {
          console.error('  ❌ Error handling node submission:', err.message);
        });
      }
    });
    console.log('  👂 Listening for new_opinion + opinion_node_submitted notifications...\n');
  }

  // ─── Polling ──────────────────────────────────────────

  private startPolling(): void {
    const poll = async () => {
      if (!this.running) return;
      try {
        // Poll for open opinions (critique phase)
        await this.processNextOpinion();
        // Poll for opinions in synthesizing state that need vote triggering
        await this.checkSynthesizingOpinions();
        // Poll for opinions in voting state that need consensus check
        await this.checkVotingOpinions();
      } catch (err: any) {
        console.error('  ⚠ Poll error:', err.message);
      }
    };

    // Initial poll
    poll();
    setInterval(poll, this.config.pollInterval * 1000);
  }

  // ─── Handle Node Submitted Notification ─────────────

  private async handleNodeSubmitted(opinionId: string): Promise<void> {
    if (!this.running) return;

    try {
      // Get the opinion's current status
      const opinions = await this.sql`
        SELECT id, status, close_tag FROM clv_opinions WHERE id = ${opinionId}
      `;
      if (opinions.length === 0) return;
      const opinion = opinions[0];

      // If closed, ignore
      if (opinion.status === 'closed') return;

      // If in synthesizing, trigger vote round
      if (opinion.status === 'synthesizing') {
        console.log(`  🗳️ Opinion ${opinionId} in synthesizing — triggering vote round`);
        await this.triggerVoteRound(opinionId);
        return;
      }

      // If in voting, check consensus
      if (opinion.status === 'voting') {
        console.log(`  📊 Opinion ${opinionId} in voting — checking consensus`);
        await this.checkAndFinalizeConsensus(opinionId);
        return;
      }
    } catch (err: any) {
      console.error(`  ❌ handleNodeSubmitted error for ${opinionId}:`, err.message);
    }
  }

  // ─── Process Next Opinion (Critique Phase) ──────────

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
      RETURNING id, agent_id, principal_id, question, context, channel, requested_opinions, deadline, status, close_tag
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

  // ─── Route an Opinion (Critique Phase) ────────────────

  private async routeOpinion(opinion: OpinionRow): Promise<void> {
    const serverUrl = this.config.serverUrl;
    const token = this.config.token;

    // 1. Find the root ProposalNode for this opinion (for edge linking)
    let rootNodeId: string | null = null;
    try {
      const graphResp = await fetch(`${serverUrl}/v1/opinions/${opinion.id}/graph`, {
        headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      });
      if (graphResp.ok) {
        const graphData = (await graphResp.json()) as any;
        const root = graphData?.data?.nodes?.find((n: any) => n.kind === 'proposal');
        rootNodeId = root?.id ?? null;
      }
    } catch {
      // non-fatal, continue without parent edge
    }

    // 2. Auto-create ProposalNode (if one doesn't exist yet)
    const proposalBody = JSON.stringify({
      kind: 'proposal',
      content: {
        question: opinion.question,
        context: opinion.context ?? undefined,
      },
    });

    // Check if we already have a proposal node
    if (!rootNodeId) {
      const nodeResp = await fetch(`${serverUrl}/v1/opinions/${opinion.id}/nodes`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: proposalBody,
      });

      if (nodeResp.ok) {
        const nodeData = (await nodeResp.json()) as any;
        rootNodeId = nodeData?.data?.id ?? null;
        console.log(`  📝 ProposalNode created: ${rootNodeId ?? 'unknown'}`);
      } else {
        const errBody = await nodeResp.text().catch(() => '');
        console.warn(`  ⚠ ProposalNode creation: ${nodeResp.status} ${errBody.slice(0, 150)}`);
      }
    }

    // 2. Check 10-node limit now
    const nodeCount = await this.sql`
      SELECT COUNT(*) as cnt FROM clv_blackboard_nodes WHERE opinion_id = ${opinion.id}
    `;
    if (parseInt(nodeCount[0]?.cnt || '0', 10) >= HARD_NODE_LIMIT) {
      console.log(`  ⏭ Opinion ${opinion.id} already at ${HARD_NODE_LIMIT} nodes — closing`);
      await this.sql`
        UPDATE clv_opinions SET status = 'closed', close_tag = 'consensus_not_reached' WHERE id = ${opinion.id}
      `;
      return;
    }

    // 3. Find eligible critics — other principals subscribed to the opinion's channel
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

    // 4. For each critic, find one of their agents and call LLM
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
        
        // Get model and LLM URL from agent
        const model = agent.model || this.config.model;
        const llmUrl = agent.llm_url || this.config.llmUrl;
        
        // Get LLM key from fleet reviewer config (not from the empty config!)
        // Query the fleet reviewers table to find the reviewer's configured key
        const reviewers = await this.sql<any[]>`
          SELECT model, llm_url, llm_key, provider
          FROM clv_fleet_reviewers
          WHERE org_id = ${agent.org_id}
          LIMIT 1
        `;
        
        let llmKey = this.config.llmKey; // fallback to config
        if (reviewers.length > 0) {
          const rev = reviewers[0];
          // Use reviewer config if available, and resolve vault reference
          if (rev.llm_key) {
            try {
              llmKey = await resolveVaultKey(this.sql, rev.llm_key, agent.org_id);
            } catch (keyErr: any) {
              console.warn(`  ⚠ Key resolution failed: ${keyErr.message}, trying direct use`);
              // If resolution fails, try using as raw key (might already be decrypted)
              llmKey = rev.llm_key;
            }
          }
        }
        
        // Debug: log what key we're using (masked)
        console.log(`  🔑 Using key: ${llmKey ? llmKey.slice(0,8) + '...' + llmKey.slice(-4) : 'NONE'}`);

        console.log(`  🤖 Critic ${agent.name || agent.id} (${model}) for ${sub.principal_id}`);

        // Call LLM
        const result = await callOpinionCritiqueLLM(model, systemPrompt, llmUrl, llmKey);

        if (!result) {
          console.warn(`  ⚠ LLM returned no parseable result for ${agent.id}`);
          return null;
        }

        // Create CritiqueNode via REST API
        const critiqueBody = JSON.stringify({
          kind: 'critique',
          content: {
            concerns: result.concerns,
            suggestions: result.suggestions,
            confidence: result.confidence,
          },
          ...(rootNodeId ? { parent_node_id: rootNodeId, parent_edge_kind: 'critiques' } : {}),
        });
        const critiqueResp = await fetch(`${serverUrl}/v1/opinions/${opinion.id}/nodes`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
          body: critiqueBody,
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

    // 5. Update opinion status
    if (succeeded >= count) {
      // All critics responded — move to synthesis phase
      console.log(`  ✅ Opinion ${opinion.id}: ${succeeded}/${count} critiques received — ready for synthesis`);
      await this.sql`UPDATE clv_opinions SET status = 'synthesizing' WHERE id = ${opinion.id}`;
    } else if (succeeded > 0) {
      // Some critics responded — still useful, move to synthesis
      console.log(`  ⚠ Opinion ${opinion.id}: ${succeeded}/${count} critiques received (partial) — ready for synthesis`);
      await this.sql`UPDATE clv_opinions SET status = 'synthesizing' WHERE id = ${opinion.id}`;
    } else {
      // All critics failed — put back
      console.log(`  ❌ Opinion ${opinion.id}: all critics failed`);
      await this.sql`UPDATE clv_opinions SET status = 'open' WHERE id = ${opinion.id}`;
    }
  }

  // ─── Check Synthesizing Opinions ─────────────────────

  private async checkSynthesizingOpinions(): Promise<void> {
    // Find opinions in synthesizing state that have a SynthesisNode
    const opinions = await this.sql`
      SELECT o.id, o.status
      FROM clv_opinions o
      WHERE o.status = 'synthesizing'
      ORDER BY o.created_at ASC
      LIMIT 5
    `;

    for (const opinion of opinions) {
      // Check if a SynthesisNode exists
      const synthNodes = await this.sql`
        SELECT id, payload FROM clv_blackboard_nodes
        WHERE opinion_id = ${opinion.id} AND kind = 'synthesis'
        ORDER BY created_at DESC
        LIMIT 1
      `;

      if (synthNodes.length > 0) {
        console.log(`  🗳️ Opinion ${opinion.id}: SynthesisNode detected — triggering vote round`);
        await this.triggerVoteRound(opinion.id);
      }
    }
  }

  // ─── Trigger Vote Round ──────────────────────────────

  private async triggerVoteRound(opinionId: string): Promise<void> {
    // Set opinion to voting
    await this.sql`UPDATE clv_opinions SET status = 'voting' WHERE id = ${opinionId}`;

    // Check 10-node limit
    const nodeCount = await this.sql`
      SELECT COUNT(*) as cnt FROM clv_blackboard_nodes WHERE opinion_id = ${opinionId}
    `;
    if (parseInt(nodeCount[0]?.cnt || '0', 10) >= HARD_NODE_LIMIT) {
      console.log(`  ⏭ Opinion ${opinionId}: ${HARD_NODE_LIMIT} node limit reached — force closing`);
      await this.sql`
        UPDATE clv_opinions SET status = 'closed', close_tag = 'consensus_not_reached' WHERE id = ${opinionId}
      `;
      return;
    }

    // Get the opinion
    const opinions = await this.sql`
      SELECT id, principal_id, question, context, channel FROM clv_opinions WHERE id = ${opinionId}
    `;
    if (opinions.length === 0) return;
    const opinion = opinions[0];

    // Get the latest SynthesisNode
    const synthNodes = await this.sql`
      SELECT id, payload FROM clv_blackboard_nodes
      WHERE opinion_id = ${opinionId} AND kind = 'synthesis'
      ORDER BY created_at DESC
      LIMIT 1
    `;
    if (synthNodes.length === 0) return;
    const synthesis = synthNodes[0];

    // Get critics who previously produced CritiqueNodes
    const criticPrincipals = await this.sql`
      SELECT DISTINCT n.principal_id
      FROM clv_blackboard_nodes n
      JOIN clv_blackboard_edges e ON e.source_node_id = n.id
      WHERE n.opinion_id = ${opinionId}
        AND n.kind = 'critique'
        AND e.kind = 'critiques'
    `;

    if (criticPrincipals.length === 0) {
      console.log(`  ⏭ Opinion ${opinionId}: no critics found for vote round`);
      return;
    }

    // Get all CritiqueNode narratives for context
    const critiqueNodes = await this.sql`
      SELECT n.payload, a.name as agent_name
      FROM clv_blackboard_nodes n
      LEFT JOIN clv_agents a ON a.id = n.agent_id
      WHERE n.opinion_id = ${opinionId} AND n.kind = 'critique'
      ORDER BY n.created_at ASC
    `;

    const critiqueTexts = critiqueNodes.map((c: any) => {
      const payload = typeof c.payload === 'string' ? JSON.parse(c.payload) : (c.payload || {});
      return `${c.agent_name || 'Agent'}: ${payload.recommendation || payload.concerns?.join(', ') || 'No details'}`;
    });

    const synthesisContent = synthesis.payload
      ? (typeof synthesis.payload === 'string' ? JSON.parse(synthesis.payload) : synthesis.payload)
      : {};

    const synthesisText = synthesisContent.recommendation
      || synthesisContent.responses_to_critiques?.map((r: any) => `${r.critique_node_id}: ${r.accepted ? '✅ Accepted' : '❌ Rejected'} - ${r.resolution}`).join('\n')
      || synthesisContent.revised_proposal
      || 'Synthesis submitted';

    // Trigger critics SEQUENTIALLY (each sees prior votes)
    const allResults: Array<{ approved: boolean; agreement_level: number; conditions: string[]; reasoning: string } | null> = [];

    for (const cp of criticPrincipals) {
      // Check node limit before each vote
      const currCount = await this.sql`
        SELECT COUNT(*) as cnt FROM clv_blackboard_nodes WHERE opinion_id = ${opinionId}
      `;
      if (parseInt(currCount[0]?.cnt || '0', 10) >= HARD_NODE_LIMIT) {
        console.log(`  ⏭ Opinion ${opinionId}: ${HARD_NODE_LIMIT} limit reached during vote round`);
        break;
      }

      // Find critic's agent
      const agents = await this.sql<CriticAgent[]>`
        SELECT id, name, principal_id, org_id, model, provider, llm_url, token
        FROM clv_agents
        WHERE principal_id = ${cp.principal_id}
          AND status = 'active'
        ORDER BY created_at ASC
        LIMIT 1
      `;
      if (agents.length === 0) continue;

      const agent = agents[0];

      // Build prior votes text
      const priorVotes = allResults
        .filter((r): r is NonNullable<typeof r> => r !== null)
        .map((r) => `approval=${r.approved} level=${r.agreement_level} reasoning=${r.reasoning}`);

      const votePrompt = buildVotePrompt(opinion.question, opinion.context, critiqueTexts, synthesisText, priorVotes);
      const model = agent.model || this.config.model;
      const llmUrl = agent.llm_url || this.config.llmUrl;
      const llmKey = this.config.llmKey;

      console.log(`  🗳️ Voter ${agent.name || agent.id} (${model}) — sequential vote`);

      try {
        const result = await callVoteLLM(model, votePrompt, llmUrl, llmKey);
        allResults.push(result);

        if (!result) {
          console.warn(`  ⚠ Vote LLM returned no result for ${agent.id}`);
          continue;
        }

        // Create ConsensusNode or follow-up CritiqueNode via REST API
        const synthNodeResp = await fetch(`${this.config.serverUrl}/v1/opinions/${opinionId}/graph`, {
          headers: { ...(this.config.token ? { Authorization: `Bearer ${this.config.token}` } : {}) },
        });
        let latestSynthId: string | null = null;
        if (synthNodeResp.ok) {
          const graphData = (await synthNodeResp.json()) as any;
          const synthesis = graphData?.data?.nodes?.find((n: any) => n.kind === 'synthesis');
          latestSynthId = synthesis?.id ?? null;
        }

        if (result.approved) {
          const voteBody = JSON.stringify({
            kind: 'consensus',
            content: {
              approved: true,
              confidence: result.agreement_level,
              notes: result.reasoning,
            },
            ...(latestSynthId ? { parent_node_id: latestSynthId, parent_edge_kind: 'votes_on' } : {}),
          });
          const voteResp = await fetch(`${this.config.serverUrl}/v1/opinions/${opinionId}/nodes`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              ...(this.config.token ? { Authorization: `Bearer ${this.config.token}` } : {}),
            },
            body: voteBody,
          });

          if (voteResp.ok) {
            const voteData = (await voteResp.json()) as any;
            console.log(`  ✅ ConsensusNode created: ${voteData?.data?.id} for ${agent.name || agent.id}`);
          } else {
            const errBody = await voteResp.text().catch(() => '');
            console.warn(`  ⚠ ConsensusNode creation: ${voteResp.status} ${errBody.slice(0, 150)}`);
          }
        } else {
          // Follow-up CritiqueNode
          const followBody = JSON.stringify({
            kind: 'critique',
            content: {
              concerns: [result.reasoning],
              suggestions: result.conditions.length > 0 ? result.conditions : undefined,
              confidence: result.agreement_level,
            },
            ...(latestSynthId ? { parent_node_id: latestSynthId, parent_edge_kind: 'critiques' } : {}),
          });
          const followUpResp = await fetch(`${this.config.serverUrl}/v1/opinions/${opinionId}/nodes`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              ...(this.config.token ? { Authorization: `Bearer ${this.config.token}` } : {}),
            },
            body: followBody,
          });

          if (followUpResp.ok) {
            const fuData = (await followUpResp.json()) as any;
            console.log(`  🔄 Follow-up CritiqueNode created: ${fuData?.data?.id} for ${agent.name || agent.id}`);
          } else {
            const errBody = await followUpResp.text().catch(() => '');
            console.warn(`  ⚠ Follow-up CritiqueNode creation: ${followUpResp.status} ${errBody.slice(0, 150)}`);
          }
        }
      } catch (err: any) {
        console.warn(`  ⚠ Voter ${cp.principal_id} failed: ${err.message}`);
        allResults.push(null);
      }
    }

    // After all sequential votes, check consensus
    await this.checkAndFinalizeConsensus(opinionId);
  }

  // ─── Check Voting Opinions ───────────────────────────

  private async checkVotingOpinions(): Promise<void> {
    const opinions = await this.sql`
      SELECT id FROM clv_opinions WHERE status = 'voting' ORDER BY created_at ASC LIMIT 5
    `;

    for (const opinion of opinions) {
      await this.checkAndFinalizeConsensus(opinion.id);
    }
  }

  // ─── Check and Finalize Consensus ────────────────────

  private async checkAndFinalizeConsensus(opinionId: string): Promise<void> {
    // Get the latest SynthesisNode
    const synthNodes = await this.sql`
      SELECT id FROM clv_blackboard_nodes
      WHERE opinion_id = ${opinionId} AND kind = 'synthesis'
      ORDER BY created_at DESC
      LIMIT 1
    `;

    if (synthNodes.length === 0) return;
    const synthId = synthNodes[0].id;

    // Find all ConsensusNodes that vote_on the synthesis
    const voteEdges = await this.sql`
      SELECT e.source_node_id, n.payload
      FROM clv_blackboard_edges e
      JOIN clv_blackboard_nodes n ON n.id = e.source_node_id
      WHERE e.opinion_id = ${opinionId}
        AND e.target_node_id = ${synthId}
        AND e.kind = 'votes_on'
        AND n.kind = 'consensus'
    `;

    // Find follow-up CritiqueNodes targeting the synthesis
    const followUpEdges = await this.sql`
      SELECT e.source_node_id, n.payload
      FROM clv_blackboard_edges e
      JOIN clv_blackboard_nodes n ON n.id = e.source_node_id
      WHERE e.opinion_id = ${opinionId}
        AND e.target_node_id = ${synthId}
        AND e.kind = 'critiques'
        AND n.kind = 'critique'
    `;

    // Check node limit
    const nodeCount = await this.sql`
      SELECT COUNT(*) as cnt FROM clv_blackboard_nodes WHERE opinion_id = ${opinionId}
    `;
    const total = parseInt(nodeCount[0]?.cnt || '0', 10);

    // If any follow-up critique exists → loop back to synthesizing
    if (followUpEdges.length > 0) {
      console.log(`  🔄 Opinion ${opinionId}: ${followUpEdges.length} follow-up critiques — back to synthesizing`);
      await this.sql`UPDATE clv_opinions SET status = 'synthesizing' WHERE id = ${opinionId}`;
      return;
    }

    // Check if all critics have voted
    const critics = await this.sql`
      SELECT DISTINCT n.principal_id
      FROM clv_blackboard_nodes n
      JOIN clv_blackboard_edges e ON e.source_node_id = n.id
      WHERE n.opinion_id = ${opinionId}
        AND n.kind = 'critique'
        AND e.kind = 'critiques'
    `;

    const voters = await this.sql`
      SELECT DISTINCT n.principal_id
      FROM clv_blackboard_nodes n
      JOIN clv_blackboard_edges e ON e.source_node_id = n.id
      WHERE n.opinion_id = ${opinionId}
        AND n.kind = 'consensus'
        AND e.kind = 'votes_on'
    `;

    // Not all critics have voted yet
    if (voters.length < critics.length) return;

    // All voted — analyze results
    let approvedCount = 0;
    let totalVotes = voteEdges.length;

    for (const edge of voteEdges) {
      const payload = typeof edge.payload === 'string' ? JSON.parse(edge.payload) : (edge.payload || {});
      if (payload.approved === true) {
        approvedCount++;
      }
    }

    // Hard limit check
    if (total >= HARD_NODE_LIMIT) {
      console.log(`  📊 Opinion ${opinionId}: ${total} nodes reached limit — force closing`);
      await this.sql`
        UPDATE clv_opinions SET status = 'closed', close_tag = 'consensus_not_reached' WHERE id = ${opinionId}
      `;
      return;
    }

    // Consensus check
    if (totalVotes > 0 && approvedCount === totalVotes) {
      // All approved
      console.log(`  ✅ Opinion ${opinionId}: CONSENSUS REACHED (${approvedCount}/${totalVotes})`);
      await this.sql`
        UPDATE clv_opinions SET status = 'closed', close_tag = 'consensus_reached' WHERE id = ${opinionId}
      `;
    } else {
      // Some rejected — still in voting (they may produce ConsensusNode with approved:false or follow-up)
      console.log(`  ⏳ Opinion ${opinionId}: ${approvedCount}/${totalVotes} approved — still in voting`);
      await this.sql`UPDATE clv_opinions SET status = 'voting' WHERE id = ${opinionId}`;
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