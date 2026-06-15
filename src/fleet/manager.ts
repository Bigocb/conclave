/**
 * Conclave Fleet — Manager
 *
 * Orchestrates reviewer daemons from a fleet.yaml config.
 * Handles: provisioning, lifecycle, dedup, human-in-the-loop queue, monitoring.
 *
 * Review Modes:
 *   auto   → LLM drafts + submits immediately
 *   human  → LLM drafts → queued for human approval → submit on approval
 *   hybrid → auto-submit if confidence >= threshold, otherwise queue for human
 */

import { randomUUID } from 'crypto';
import { EventEmitter } from 'events';
import { ConclaveApiClient } from '../mcp/api-client.js';
import { loadPromptTemplate, DEFAULT_REVIEW_PROMPT } from '../reviewer/prompts.js';
import {
  FleetConfig,
  ReviewerMode,
  principalSlug,
} from './config.js';
import { runLlmReview, runSlimReview, runCodeReview, runPipelineReview, type ReviewInput, type ReviewOutput } from './backends.js';
import { MemoryService } from '../services/index.js';
import { eq, and } from 'drizzle-orm';
import { fleetReviewers } from '../db/schema.js';
import { db } from '../db/index.js';
import crypto from 'crypto';

// ─── Vault Key Resolution ──────────────────────────────────

/**
 * Decrypt a vault-encrypted value using AES-256-CBC.
 * Used by resolveVaultKey when direct DB access is available.
 */
function decryptVaultValue(encryptedData: string): string {
  const ENCRYPTION_KEY = process.env.VAULT_MASTER_KEY || 'dev-master-key-32-chars-long-!!!';
  const [ivHex, encryptedHex] = encryptedData.split(':');
  if (!ivHex || !encryptedHex) return encryptedData;
  const iv = Buffer.from(ivHex, 'hex');
  const encryptedText = Buffer.from(encryptedHex, 'hex');
  const decipher = crypto.createDecipheriv('aes-256-cbc', Buffer.from(ENCRYPTION_KEY), iv);
  let decrypted = decipher.update(encryptedText);
  decrypted = Buffer.concat([decrypted, decipher.final()]);
  return decrypted.toString();
}

/**
 * Resolve a vault reference (org_{provider}) to a decrypted API key.
 * Uses direct postgres query + AES decryption — no Drizzle dependency needed.
 */
async function resolveVaultKey(key: string, orgId: string): Promise<string> {
  if (!key || !key.startsWith('org_')) return key;

  const providerName = key.replace(/^org_/, '');
  console.log(`  🔑 Resolving vault key '${key}' for provider '${providerName}' in org '${orgId}'`);

  // Try direct DB query using the Drizzle db instance (available when running in API server context)
  try {
    if (db) {
      const result = await (db as any).query?.orgVault?.findFirst?.({
        where: (v: any, { and, eq }: any) => and(eq(v.orgId, orgId), eq(v.provider, providerName)),
      });
      if (result?.encryptedValue) {
        const decrypted = decryptVaultValue(result.encryptedValue);
        console.log(`  🔑 Resolved vault key '${key}' → decrypted key for '${providerName}'`);
        return decrypted;
      }
    }
  } catch (err: any) {
    console.warn(`  ⚠️  Drizzle vault lookup failed: ${err.message}, trying raw SQL...`);
  }

  // Fallback: raw postgres query (works in worker context without Drizzle)
  try {
    const { default: postgres } = await import('postgres');
    const databaseUrl = process.env.DATABASE_URL;
    if (databaseUrl) {
      const sql = postgres(databaseUrl, { ssl: databaseUrl.includes('localhost') ? false : 'require', max: 1 });
      try {
        const rows = await sql`SELECT encrypted_value FROM clv_org_vault WHERE org_id = ${orgId} AND provider = ${providerName}`;
        if (rows.length > 0) {
          const decrypted = decryptVaultValue(rows[0].encrypted_value);
          console.log(`  🔑 Resolved vault key '${key}' → decrypted key for '${providerName}' (via raw SQL)`);
          return decrypted;
        }
      } finally {
        await sql.end();
      }
    }
  } catch (err: any) {
    console.warn(`  ⚠️  Raw SQL vault lookup failed: ${err.message}`);
  }

  console.warn(`  ⚠️  Vault has no key for '${providerName}' in org '${orgId}' — using raw value`);
  return key;
}


export interface PendingReview {
  id: string;
  taskId: string;
  channel: string;
  reviewerName: string;
  principalId: string;
  agentId: string;
  draft: {
    scores: Record<string, number>;
    weighted_overall: number;
    reviewer_confidence: number;
    comment: string;
    suggestions: string[];
    approved: boolean;
  };
  createdAt: string;
}

interface ReviewerProcess {
  reviewerName: string;
  principalId: string;
  agents: Array<{ agentId: string; token: string; index: number }>;
  channels: string[];
  type: 'llm' | 'slim' | 'code' | 'pipeline';
  command?: string;             // shell command for type=code
  steps?: string[];             // reviewer names for type=pipeline
  mode: ReviewerMode;
  confidenceThreshold: number;
  interval: number;
  maxConcurrent: number;
  prompt: string;
  model: string;
  llmUrl: string;
  llmKey: string;
  instructions?: string;
  skills?: string[];
  running: boolean;
  timer?: ReturnType<typeof setInterval>;
  activeReviews: number;
  reviewedTaskIds: Set<string>;
}

export interface FleetStats {
  org_id: string;
  scope: string;
  reviewers: Array<{
    name: string;
    principal_id: string;
    mode: ReviewerMode;
    agents: number;
    status: 'running' | 'stopped' | 'error';
    active_reviews: number;
    total_reviews_completed: number;
  }>;
  pending_approvals: number;
  total_agents: number;
  uptime_seconds: number;
}

// ─── LLM Client ─────────────────────────────────────────────

import { getProviderConfig, resolveLlmUrl, buildAuthHeaders } from './providers.js';

async function callLLM(opts: {
    url: string;
    key: string;
    model: string;
    systemPrompt: string;
    userMessage: string;
    provider?: string;
  }): Promise<string> {
    const provider = opts.provider || 'openai';
    const config = getProviderConfig(provider);
    const endpoint = resolveLlmUrl(provider, opts.url).replace(/\/$/, '');

    const payload = config.adaptPayload 
      ? config.adaptPayload({
          model: opts.model,
          messages: [
            { role: 'system', content: opts.systemPrompt },
            { role: 'user', content: opts.userMessage },
          ],
          temperature: 0.3,
          max_tokens: 2000,
          stream: false,
        })
      : {
          model: opts.model,
          messages: [
            { role: 'system', content: opts.systemPrompt },
            { role: 'user', content: opts.userMessage },
          ],
          temperature: 0.3,
          max_tokens: 2000,
          stream: false,
        };

    console.log(`[LLM-DEBUG] Requesting review for ${opts.model}`);
    console.log(`  URL: ${endpoint}`);
    console.log(`  Key (full): ${opts.key || 'NONE'}`);

    const resp = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...buildAuthHeaders(opts.provider, opts.key),
      },
      body: JSON.stringify(payload),
    });

    if (!resp.ok) {
      const bodyText = await resp.text().catch(() => '');
      throw new Error(`LLM API error ${resp.status}: ${bodyText.slice(0, 200)}`);
    }

    const data = await resp.json() as any;
    return config.parseResponse(data) ?? '';
  }

// ─── Parse LLM structured review output ─────────────────────

function parseReviewResponse(raw: string): {
  scores: Record<string, number>;
  weighted_overall: number;
  reviewer_confidence: number;
  comment: string;
  suggestions: string[];
  approved: boolean;
} | null {
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

// ─── Fleet Manager ──────────────────────────────────────────

export class FleetManager extends EventEmitter {
  private config: FleetConfig;
  private processes: Map<string, ReviewerProcess> = new Map();
  private pendingApprovals: PendingReview[] = [];
  private totalReviewsCompleted: Map<string, number> = new Map();
  private apiClients: Map<string, ConclaveApiClient> = new Map();
  private startTime: number = 0;
  private running: boolean = false;
  private _syncTimer?: ReturnType<typeof setInterval>;
  private memoryService: MemoryService;

  constructor(config: FleetConfig) {
    super();
    this.config = config;
    // Use default parameter like other services to avoid type issues
    this.memoryService = new MemoryService(db as any);
  }

  // ─── Pulse Relay ───────────────────────────────────────────

  private async broadcastPulse(type: string, payload: any): Promise<void> {
    try {
      // Note: This is a fire-and-forget call to the Pulse Daemon (on Render)
      // We don't 'await' it in a way that blocks the main fleet loop
      const pulseUrl = `${process.env.PULSE_URL || 'http://pulse-daemon:3001'}/broadcast`;
      
      fetch(pulseUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          orgId: this.config.org_id,
          event: { type, payload, timestamp: new Date().toISOString() },
        }),
      }).catch(err => console.error(`[Pulse Relay] Background broadcast failed: ${err.message}`));
    } catch (err: any) {
      console.error(`[Pulse Relay] Fatal error: ${err.message}`);
    }
  }


  async provision(): Promise<void> {
    console.log('🔧 Provisioning fleet...\n');

    for (const reviewer of this.config.reviewers) {
      const slug = principalSlug(reviewer.name);

      // 1. Get or create principal
      let principalId: string = '';
      let principal: any = null;

      // Try to find existing principal by listing and matching name
      const tempClient = new ConclaveApiClient({
        serverUrl: this.config.server,
        principalId: 'prn_dev',
        token: this.config.token, // use org-level token for auth
      });

      try {
        const listResp = await tempClient.listPrincipals();
        const existing = (listResp.data as any[])?.find((p: any) => p.name === reviewer.name);
        if (existing) {
          principal = existing;
          principalId = existing.id;
          console.log(`  Principal exists: ${principalId} (${reviewer.name})`);
        }
      } catch { /* list failed */ }

      if (!principal) {
        console.log(`  Creating principal: ${reviewer.name}`);
        const resp = await tempClient.createPrincipal({
          name: reviewer.name,
          roles: reviewer.channels.map((c: string) => `reviewer:${c}`),
          capabilities: ['review'],
          metadata: { fleet: true, mode: reviewer.mode, model: reviewer.model },
          org_id: this.config.org_id,
        });
        principal = resp.data;
        principalId = (principal as any).id;
      }

      // Create a client for registration with the reviewer's principal
      const regClient = new ConclaveApiClient({
        serverUrl: this.config.server,
        principalId,
        token: this.config.token,
      });

      // 2. Register agents (one per replica) — reuse existing agents when possible
      const agents: Array<{ agentId: string; token: string; index: number }> = [];

      // Try to find existing agents for this principal
      let existingAgents: any[] = [];
      try {
        const agentListResp = await tempClient.listAgentsUnderPrincipal(principalId);
        existingAgents = ((agentListResp.data as any)?.agents ?? agentListResp.data as any[]) ?? [];
      } catch { /* list failed, will create new */ }

      const existingCount = existingAgents.length;
      for (let i = 0; i < reviewer.replicas; i++) {
        // Reuse existing agent if available
        if (i < existingCount) {
          const existing = existingAgents[i];
          // Fetch full agent details to get token for auth
          let agentToken = '';
          try {
            const agentResp = await tempClient.getAgent(existing.id);
            agentToken = agentResp.data?.token ?? '';
          } catch { /* fallback to empty token */ }
          agents.push({ agentId: existing.id, token: agentToken, index: i });
          console.log(`  Agent reused: ${existing.id} (${existing.name})`);
          continue;
        }

        // Create new agent only if needed
        const suffix = reviewer.replicas > 1 ? `_${i + 1}` : '';
        try {
          // Strip undefined/null/empty values before sending to avoid 422 validation errors
          const agentData: Record<string, any> = {
            name: `${reviewer.name} #${i + 1}`,
            type: reviewer.type || 'llm',
            model: reviewer.model || undefined,
            provider: reviewer.provider || undefined,
            llm_url: reviewer.llm_url || undefined,
            command: reviewer.command || undefined,
            instructions: reviewer.instructions || undefined,
            skills: reviewer.skills?.length ? reviewer.skills : undefined,
          };
          // Remove undefined entries
          Object.keys(agentData).forEach(k => agentData[k] === undefined && delete agentData[k]);
          const resp = await regClient.registerAgentUnderPrincipal(principalId, agentData as any);
          const data = resp.data as any;
          const registeredAgentId = data.agent_id ?? data.id ?? `agt_${principalId.replace('prn_', '')}`;
          agents.push({ agentId: registeredAgentId, token: data.token ?? '', index: i });
          console.log(`  Agent registered: ${registeredAgentId} under ${principalId}`);
        } catch (err: any) {
          if (err.message?.includes('already exists') || err.message?.includes('duplicate')) {
            const fallbackId = `agt_${principalId.replace('prn_', '')}_${i}`;
            agents.push({ agentId: fallbackId, token: '', index: i });
            console.log(`  Agent exists: ${fallbackId}`);
          } else {
            console.warn(`  ⚠ Agent registration failed: ${err.message}`);
            const fallbackId = `agt_${principalId.replace('prn_', '')}_${i}`;
            agents.push({ agentId: fallbackId, token: '', index: i });
          }
        }
      }

      // 3. Ensure every agent has a usable clv_ token, then create the API client
      for (let i = 0; i < agents.length; i++) {
        if (agents[i].token && agents[i].token.startsWith('clv_')) continue;
        try {
          const agentTokenResp = await fetch(`${this.config.server}/v1/agents/${agents[i].agentId}/regenerate-token`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${this.config.token}`,
            },
          });
          if (agentTokenResp.ok) {
            const tokenData = await agentTokenResp.json() as any;
            const freshToken = tokenData.data?.token ?? tokenData.token ?? '';
            if (freshToken) {
              agents[i] = { ...agents[i], token: freshToken };
              console.log(`  🔑 Refreshed token for ${agents[i].agentId}`);
            }
          } else {
            const errBody = await agentTokenResp.text().catch(() => '');
            console.warn(`  ⚠ Token refresh for ${agents[i].agentId} failed: ${agentTokenResp.status} ${errBody.slice(0, 200)}`);
          }
        } catch (err: any) {
          console.warn(`  ⚠ Token refresh for ${agents[i].agentId} threw: ${err.message}`);
        }
      }

      const agentToken = agents[0]?.token || '';
      if (!agentToken || !agentToken.startsWith('clv_')) {
        console.warn(`  ⚠ ${reviewer.name}: no valid agent token available, reviews will use the fleet token and may fail with SELF_REVIEW_FORBIDDEN`);
      }
      const pollingClient = new ConclaveApiClient({
        serverUrl: this.config.server,
        principalId,
        agentId: agents[0]?.agentId,
        token: agentToken || this.config.token,
      });
      if (agents[0]?.token) {
        pollingClient.setToken(agents[0].token);
      }
      this.apiClients.set(principalId, pollingClient);

      // 4. Subscribe to channels — use the newly created principal directly
      for (const ch of reviewer.channels) {
        try {
          const subResp = await fetch(`${this.config.server}/v1/channels/${encodeURIComponent(ch)}/subscribe`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${this.config.token}`,
            },
            body: JSON.stringify({ principal_id: principalId }),
          });
          if (subResp.ok) {
            console.log(`  Subscribed: ${principalId} → ${ch}`);
          } else {
            const errBody = await subResp.text().catch(() => '');
            console.warn(`  ⚠ Subscribe ${ch}: ${subResp.status} ${errBody.slice(0, 150)}`);
          }
        } catch (err: any) {
          console.warn(`  ⚠ Subscribe ${ch}: ${err.message}`);
        }
      }

      // 4. Load prompt template
      let prompt: string = DEFAULT_REVIEW_PROMPT;
      if (reviewer.prompt) {
        try {
          prompt = loadPromptTemplate(reviewer.prompt) ?? DEFAULT_REVIEW_PROMPT;
        } catch {
          console.warn(`  ⚠ Custom prompt not found for ${reviewer.name}, using default`);
        }
      }

      // 5. Create process entry
      // FETCH ACTUAL CONFIG FROM DB: Override YAML with DB values if they exist
      let finalModel = reviewer.model;
      let finalUrl = reviewer.llm_url;
      let finalKey = reviewer.llm_key;

      try {
        const agentData = await tempClient.getAgent(agents[0]?.agentId);
        const data = agentData.data as any;
        if (data) {
          finalModel = data.model || finalModel;
          finalUrl = data.llm_url || finalUrl;
          // If we have an agent token, we can use it as the LLM key for certain providers
          // or we still rely on the reviewer.llm_key for the actual API key
          if (data.token && !finalKey) {
            finalKey = data.token;
          }
        }
      } catch (err: any) {
        console.warn(`  ⚠ Could not sync DB config for ${reviewer.name}: ${err.message}`);
      }

      this.processes.set(principalId, {
        reviewerName: reviewer.name,
        principalId,
        agents,
        channels: reviewer.channels,
        type: reviewer.type || 'llm',
        command: reviewer.command,
        steps: reviewer.steps,
        mode: reviewer.mode,
        confidenceThreshold: reviewer.confidence_threshold,
        interval: reviewer.interval ?? 30,
        maxConcurrent: reviewer.max_concurrent ?? 1,
        prompt,
        model: finalModel,
        llmUrl: finalUrl,
        llmKey: finalKey,
        instructions: reviewer.instructions,
        skills: reviewer.skills,
        running: false,
        activeReviews: 0,
        reviewedTaskIds: new Set(),
      });
      console.log(`[DBG-provision] ${reviewer.name} → instructions=${JSON.stringify(reviewer.instructions)} skills=${JSON.stringify(reviewer.skills)} model=${finalModel} llmUrl=${finalUrl}`);

      this.totalReviewsCompleted.set(principalId, 0);
    }

    console.log('\n✅ Fleet provisioned\n');
  }

  // ─── Start / Stop ────────────────────────────────────────

  async start(): Promise<void> {
    this.running = true;
    this.startTime = Date.now();
    console.log('🚀 Starting fleet...\n');

    const pids = Array.from(this.processes.keys());
    for (const principalId of pids) {
      const proc = this.processes.get(principalId)!;
      proc.running = true;
      this.startPolling(principalId);

      const modeIcon = proc.mode === 'auto' ? '🤖' : proc.mode === 'human' ? '👤' : '🔀';
      console.log(`  ${modeIcon} ${proc.reviewerName} (${proc.mode}) — polling every ${proc.interval}s`);
    }

    this.emit('started');
    console.log('\n✅ Fleet running\n');

    // ─── Periodic config re-sync (every 5 min) ──────────────────
    this._syncTimer = setInterval(() => this.syncReviewerConfig(), 5 * 60 * 1000);
  }

  async stop(): Promise<void> {
    this.running = false;

    const pids = Array.from(this.processes.keys());
    for (const pid of pids) {
      const proc = this.processes.get(pid)!;
      proc.running = false;
      if (proc.timer) {
        clearInterval(proc.timer);
        proc.timer = undefined;
      }
    }

    // Clear sync timer
    if (this._syncTimer) {
      clearInterval(this._syncTimer);
      this._syncTimer = undefined;
    }

    this.emit('stopped');
    console.log('\n🛑 Fleet stopped');
  }

  // ─── Config Re-sync ─────────────────────────────────────

  /** Re-fetch reviewer config from API and update running processes */
  async syncReviewerConfig(): Promise<void> {
    const { server, org_id, token } = this.config;
    if (!server || !org_id) return;

    try {
      const resp = await fetch(
        `${server}/v1/fleet/reviewers?orgId=${encodeURIComponent(org_id)}`,
        { headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) } },
      );
      if (!resp.ok) return;
      const envelope: any = await resp.json();
      const reviewers: any[] = envelope?.data?.reviewers ?? envelope?.reviewers ?? [];

      for (const r of reviewers) {
        const name = r.name;
        const proc = Array.from(this.processes.values()).find(p => p.reviewerName === name);
        if (!proc) continue;

        // Update mutable config fields on the running process
        if (r.model) proc.model = r.model;
        if (r.llmUrl || r.llm_url) proc.llmUrl = r.llmUrl || r.llm_url;
        if (r.llmKey || r.llm_key) proc.llmKey = r.llmKey || r.llm_key;
        if (r.provider) proc.type = r.provider; // type field holds provider
        console.log(`  🔄 Synced config for ${name}`);
      }
    } catch (err: any) {
      console.warn(`  ⚠ Config sync failed: ${err.message}`);
    }
  }

  // ─── Polling Loop ────────────────────────────────────────

  private startPolling(principalId: string): void {
    const proc = this.processes.get(principalId)!;

    // Immediate first poll
    this.pollFeed(principalId).catch(err => {
      console.error(`  ❌ ${proc.reviewerName} poll error:`, err.message);
    });

    proc.timer = setInterval(() => {
      if (!proc.running) return;
      this.pollFeed(principalId).catch(err => {
        console.error(`  ❌ ${proc.reviewerName} poll error:`, err.message);
      });
    }, proc.interval * 1000);
  }

  private async pollFeed(principalId: string): Promise<void> {
    const proc = this.processes.get(principalId)!;
    const client = this.apiClients.get(principalId)!;

    // Heartbeat broadcast for the NOC page
    this.broadcastPulse('FLEET_HEARTBEAT', { 
      reviewerName: proc.reviewerName, 
      principalId 
    });

    if (proc.activeReviews >= proc.maxConcurrent) return;


    for (const channel of proc.channels) {
      try {
        const resp = await client.getChannelFeed(channel);
        const data = resp.data as any;
        const tasks: any[] = data?.tasks ?? [];
        console.log(`  📡 ${proc.reviewerName} polled ${channel}: ${Array.isArray(tasks) ? tasks.length : 'not-array'} tasks`);
        if (!Array.isArray(tasks)) continue;

        for (const feedItem of tasks) {
          // Feed items use 'task_id', not 'id'
          const taskId = feedItem.task_id ?? feedItem.id;
          if (!taskId) continue;

          // Skip if already reviewed by this principal (local dedup)
          if (proc.reviewedTaskIds.has(taskId)) continue;

          // Skip tasks that are already completed or have enough reviews
          const taskStatus = feedItem.status;
          if (taskStatus === 'completed' || taskStatus === 'cancelled') {
            console.log(`  ⏭ ${proc.reviewerName}: Skipping ${taskId} (status: ${taskStatus})`);
            this.broadcastPulse('FLEET_SKIP', { taskId, reason: `status: ${taskStatus}`, reviewerName: proc.reviewerName });
            continue;
          }
          // Skip tasks from other orgs — fleet agents only belong to one org
          if (feedItem.org_id && feedItem.org_id !== this.config.org_id) {
            console.log(`  ⏭ ${proc.reviewerName}: Skipping ${taskId} (org mismatch: ${feedItem.org_id} != ${this.config.org_id})`);
            this.broadcastPulse('FLEET_SKIP', { taskId, reason: 'org mismatch', reviewerName: proc.reviewerName });
            continue;
          }

          if (proc.activeReviews >= proc.maxConcurrent) break;

          // Mark as seen to prevent duplicate picks
          proc.reviewedTaskIds.add(taskId);
          console.log(`  🎯 ${proc.reviewerName} found task ${taskId} on channel ${channel}`);
          this.broadcastPulse('FLEET_TASK_FOUND', { taskId, channel, reviewerName: proc.reviewerName });

          // Fetch full task details (feed only has summary)
          let fullTask = feedItem;
          let taskFetchFailed = false;
          try {
            const taskResp = await client.getTask(taskId);
            fullTask = taskResp.data;
          } catch (err: any) {
            taskFetchFailed = true;
            console.log(`  ⚠ ${proc.reviewerName}: Cannot fetch task ${taskId} — ${err.message || err}`);
          }

          // Skip tasks we can't fetch — wrong org or insufficient permissions
          if (taskFetchFailed) {
            this.broadcastPulse('FLEET_FETCH_ERROR', { taskId, reviewerName: proc.reviewerName, error: 'Cannot fetch task' });
            proc.reviewedTaskIds.delete(taskId);
            continue;
          }

          // Process async
          this.reviewTask(principalId, fullTask, channel).catch(err => {
            const isDuplicate = err.message?.includes('409') && (
              err.message?.includes('DUPLICATE_REVIEW') ||
              err.message?.includes('already reviewed')
            );
            if (isDuplicate) {
              console.log(`  ⏭ ${proc.reviewerName}: Already reviewed task ${taskId} (server-side dedup)`);
              // Keep in reviewedTaskIds — don't retry tasks we've already reviewed
            } else {
              console.error(`  ❌ Review failed for task ${taskId}:`, err.message);
              // Remove from seen set so it can be retried on the next poll
              proc.reviewedTaskIds.delete(taskId);
            }
          });

          proc.activeReviews++;
        }
      } catch (err: any) {
        console.error(`  ⚠ Feed error for ${channel}:`, err.message);
      }
    }
  }

  // ─── Review Task ─────────────────────────────────────────

  private async reviewTask(principalId: string, task: any, channel: string): Promise<void> {
    const proc = this.processes.get(principalId)!;
    const client = this.apiClients.get(principalId)!;
    const agent = proc.agents[0];

    console.log(`  📋 ${proc.reviewerName}: Reviewing task ${task.id ?? task.task_id} from ${channel}`);
    this.broadcastPulse('FLEET_REVIEW_START', { taskId: task.id ?? task.task_id, channel, reviewerName: proc.reviewerName });

    try {
      // 1. Build input for any backend type
      const taskId = task.id ?? task.task_id;
      
      // Fetch memories for the task's principal (the submitter) to inject into the review prompt
      let memories: string[] = [];
      const principalId = task.principalId;
      if (principalId) {
        try {
          const memoryEntries = await this.memoryService.getByPrincipal(principalId);
          
          // Build structured convention block from high-confidence conventions
          const conventions = memoryEntries
            .filter(m => m.confidence !== null && m.confidence >= 0.6 && m.category !== 'fact')
            .map(m => {
              const sourceInfo = m.sourceTaskId
                ? `\n  Evidence: "${m.value.slice(0, 200)}"\n  Source: task ${m.sourceTaskId}`
                : `\n  Evidence: "${m.value.slice(0, 200)}"`;
              return `- ${m.value} (confidence: ${m.confidence}, category: ${m.category})${sourceInfo}`;
            });

          if (conventions.length > 0) {
            memories = [
              '## Known Conventions (from past reviews)',
              '',
              'The following conventions were established in previous reviews. Follow them unless you have a strong reason to deviate.',
              '',
              ...conventions,
              '',
              '---',
            ];
          } else {
            // Fallback: show raw memory values (backward compat with old-style memories)
            memories = memoryEntries.map(m => m.value);
          }

          if (memories.length > 0) {
            console.log(`[DBG-reviewTask] Loaded ${memoryEntries.length} memories (${conventions.length} conventions) for principal ${principalId}`);
          }
        } catch (memErr) {
          console.warn(`[DBG-reviewTask] Failed to load memories for principal ${principalId}:`, memErr);
        }
      }

      const reviewInput: ReviewInput = {
        task_id: taskId,
        task_description: task.description,
        output: task.output,
        dimensions: Array.isArray(task.dimensions) ? task.dimensions : JSON.parse(task.dimensions || '[]'),
        channel,
        instructions: proc.instructions,
        skills: proc.skills,
        memories,
      };
      console.log(`[DBG-reviewTask] reviewerName=${proc.reviewerName} proc.instructions=${JSON.stringify(proc.instructions)} proc.skills=${JSON.stringify(proc.skills)}`);

      // Build a minimal agent record for the backend
      const agentRecord: any = {
        name: proc.reviewerName,
        model: proc.model,
        provider: 'ollama_cloud', // Standardizing to the working provider
        instructions: proc.instructions,
        skills: proc.skills,
      };
      console.log(`[DBG-agentRecord] name=${proc.reviewerName} instructions=${JSON.stringify(proc.instructions)} skills=${JSON.stringify(proc.skills)}`);

      // Resolve vault reference before calling LLM
      const resolvedKey = await resolveVaultKey(proc.llmKey, this.config.org_id);
      const maskedKey = resolvedKey ? resolvedKey.slice(0, 5) + '***' : '(empty)';
      console.log(`[DBG-key] ${proc.reviewerName}: llmKey=${proc.llmKey?.slice(0, 5) ?? '(none)'}*** → resolved=${maskedKey} org=${this.config.org_id?.slice(0, 8)}***`);

      // 2. Dispatch to the right backend based on type
      let draft: ReviewOutput;
      const reviewerType = proc.type || 'llm';

      if (reviewerType === 'code') {
        if (!proc.command) throw new Error('Code reviewer has no command configured');
        draft = await runCodeReview(agentRecord, reviewInput, proc.command);
      } else if (reviewerType === 'slim') {
        draft = await runSlimReview(agentRecord, reviewInput, proc.llmUrl, resolvedKey);
      } else if (reviewerType === 'pipeline') {
        if (!proc.steps || proc.steps.length === 0) throw new Error('Pipeline reviewer has no steps');
        draft = await runPipelineReview(
          proc.steps,
          agentRecord,
          reviewInput,
          async (stepName: string, input: ReviewInput) => {
            // Find the step's process
            const stepProc = Array.from(this.processes.values()).find(p => p.reviewerName === stepName);
            if (!stepProc) throw new Error(`Pipeline step "${stepName}" not found`);
            const stepResolvedKey = await resolveVaultKey(stepProc.llmKey, this.config.org_id);
            const stepMasked = stepResolvedKey ? stepResolvedKey.slice(0, 5) + '***' : '(empty)';
            console.log(`[DBG-key] pipeline-step ${stepName}: llmKey=${stepProc.llmKey?.slice(0, 5) ?? '(none)'}*** → resolved=${stepMasked}`);
            const stepAgent: any = { model: stepProc.model, instructions: stepProc.instructions, skills: stepProc.skills };
            const stepType = stepProc.type || 'llm';
            if (stepType === 'code') return runCodeReview(stepAgent, input, stepProc.command!);
            if (stepType === 'slim') return runSlimReview(stepAgent, input, stepProc.llmUrl, stepResolvedKey);
            return runLlmReview(stepAgent, input, stepProc.llmUrl, stepResolvedKey);
          },
        );
      } else {
        // Default: full LLM review
        draft = await runLlmReview(agentRecord, reviewInput, proc.llmUrl, resolvedKey);
      }

      if (!draft || draft.weighted_overall === undefined) {
        console.warn(`  ⚠ ${proc.reviewerName}: Backend returned invalid review for task ${task.id} — skipping`);
        return;
      }

      // 2. Sanitize scores to meet API constraints (int 1-10, weighted_overall >= 1)
      const sanitizedScores: Record<string, number> = {};
      for (const [dim, val] of Object.entries(draft.scores)) {
        sanitizedScores[dim] = Math.max(1, Math.min(10, Math.round(val)));
      }

      // 3. PROTOCOL ENFORCEMENT: Force exact dimension names matching the task
      const taskDimensions: string[] = Array.isArray(task.dimensions)
        ? task.dimensions
        : (typeof task.dimensions === 'string' ? JSON.parse(task.dimensions) : []);
      const finalScores: Record<string, number> = {};

      if (taskDimensions.length > 0) {
        // Check which task dimensions are covered by the LLM output
        const missingDims = taskDimensions.filter(d => sanitizedScores[d] === undefined);
        const extraDims = Object.keys(sanitizedScores).filter(d => !taskDimensions.includes(d));

        if (missingDims.length > 0 || extraDims.length > 0) {
          // Attempt fuzzy match: find the closest task dimension for each LLM dimension
          const llmDims = Object.keys(sanitizedScores);
          const dimMap: Record<string, string> = {};
          for (const taskDim of taskDimensions) {
            // Find the closest LLM dimension by substring matching
            const match = llmDims.find(ld =>
              ld.toLowerCase().includes(taskDim.toLowerCase()) ||
              taskDim.toLowerCase().includes(ld.toLowerCase())
            );
            if (match) {
              dimMap[match] = taskDim;
            }
          }

          // Build final scores using the mapping, fall back to 'correctness' or 5
          for (const taskDim of taskDimensions) {
            const llmKey = Object.entries(dimMap).find(([llm, task]) => task === taskDim)?.[0];
            if (llmKey && sanitizedScores[llmKey] !== undefined) {
              finalScores[taskDim] = sanitizedScores[llmKey];
            } else if (sanitizedScores[taskDim] !== undefined) {
              finalScores[taskDim] = sanitizedScores[taskDim];
            } else {
              finalScores[taskDim] = 5; // neutral fallback
            }
          }

          if (missingDims.length > 0) {
            console.log(`  ⚠ ${proc.reviewerName}: LLM used wrong dimensions for task ${taskId}. ` +
              `Missing: [${missingDims.join(', ')}], Extra: [${extraDims.join(', ')}]. Corrected via fuzzy match.`);
          }
        } else {
          // All dimensions match exactly — use as-is
          Object.assign(finalScores, sanitizedScores);
        }
      } else {
        // No defined dimensions on the task — use LLM output as-is
        Object.assign(finalScores, sanitizedScores);
      }

      const sanitizedOverall = Math.max(1, Math.min(10, Math.round(draft.weighted_overall)));

      // 4. Protocol: compute approved from overall score
      const approved = sanitizedOverall >= 7;
      const reviewPayload = {
        scores: finalScores,
        weighted_overall: sanitizedOverall,
        reviewer_confidence: draft.reviewer_confidence ?? 5,
        comment: draft.comment || '',
        suggestions: draft.suggestions || [],
        approved,
      };

      if (proc.mode === 'auto') {
        await client.submitReview(taskId, reviewPayload);
        this.incrementCompleted(principalId);
        console.log(`  ✅ ${proc.reviewerName}: Auto-reviewed task ${taskId} (overall: ${draft.weighted_overall})`);
        this.broadcastPulse('FLEET_REVIEW_SUBMITTED', { taskId, reviewerName: proc.reviewerName, mode: 'auto' });
        this.emit('review_completed', { principalId, taskId, mode: 'auto' });

      } else if (proc.mode === 'human') {
        const pending: PendingReview = {
          id: `pnd_${randomUUID().replace(/-/g, '').slice(0, 24)}`,
          taskId,
          channel,
          reviewerName: proc.reviewerName,
          principalId,
          agentId: agent.agentId,
          draft: reviewPayload,
          createdAt: new Date().toISOString(),
        };
        this.pendingApprovals.push(pending);
        console.log(`  👤 ${proc.reviewerName}: Draft queued for human approval — task ${task.id} (pending: ${this.pendingApprovals.length})`);
        this.broadcastPulse('FLEET_REVIEW_QUEUED', { taskId: task.id, reviewerName: proc.reviewerName, mode: 'human' });
        this.emit('review_pending', pending);

      } else if (proc.mode === 'hybrid') {
        if (draft.reviewer_confidence ?? 5 >= proc.confidenceThreshold) {
          await client.submitReview(task.id, reviewPayload);
          this.incrementCompleted(principalId);
          console.log(`  ✅ ${proc.reviewerName}: Auto-reviewed (confidence ${draft.reviewer_confidence} ≥ ${proc.confidenceThreshold}) task ${task.id}`);
          this.emit('review_completed', { principalId, taskId: task.id, mode: 'hybrid_auto' });
        } else {
          const pending: PendingReview = {
            id: `pnd_${randomUUID().replace(/-/g, '').slice(0, 24)}`,
            taskId: task.id,
            channel,
            reviewerName: proc.reviewerName,
            principalId,
            agentId: agent.agentId,
            draft: reviewPayload,
            createdAt: new Date().toISOString(),
          };
          this.pendingApprovals.push(pending);
          console.log(`  🔀 ${proc.reviewerName}: Low confidence (${draft.reviewer_confidence} < ${proc.confidenceThreshold}) — queued for human — task ${task.id}`);
          this.broadcastPulse('FLEET_REVIEW_QUEUED', { taskId: task.id, reviewerName: proc.reviewerName, mode: 'hybrid_low_conf' });
          this.emit('review_pending', pending);
        }
      }
    } finally {
      proc.activeReviews--;
    }
  }

  private incrementCompleted(principalId: string): void {
    const current = this.totalReviewsCompleted.get(principalId) ?? 0;
    this.totalReviewsCompleted.set(principalId, current + 1);
  }

  // ─── Human Approval ─────────────────────────────────────

  getPendingApprovals(): PendingReview[] {
    return [...this.pendingApprovals];
  }

  async approvePending(pendingId: string, edits?: Partial<PendingReview['draft']>): Promise<void> {
    const idx = this.pendingApprovals.findIndex(p => p.id === pendingId);
    if (idx === -1) throw new Error(`Pending review ${pendingId} not found`);

    const pending = this.pendingApprovals[idx];
    const client = this.apiClients.get(pending.principalId)!;

    const final = { ...pending.draft, ...edits };

    await client.submitReview(pending.taskId, final);

    this.pendingApprovals.splice(idx, 1);
    this.incrementCompleted(pending.principalId);

    console.log(`  ✅ Approved: ${pending.reviewerName} review of task ${pending.taskId}`);
    this.emit('review_approved', { pendingId, taskId: pending.taskId });
  }

  rejectPending(pendingId: string): void {
    const idx = this.pendingApprovals.findIndex(p => p.id === pendingId);
    if (idx === -1) throw new Error(`Pending review ${pendingId} not found`);

    const pending = this.pendingApprovals[idx];
    this.pendingApprovals.splice(idx, 1);

    // Un-mark so another reviewer could pick it up
    const proc = this.processes.get(pending.principalId);
    if (proc) proc.reviewedTaskIds.delete(pending.taskId);

    console.log(`  ❌ Rejected: ${pending.reviewerName} review of task ${pending.taskId}`);
    this.emit('review_rejected', { pendingId, taskId: pending.taskId });
  }

  // ─── Status ──────────────────────────────────────────────

  getStats(): FleetStats {
    const pids = Array.from(this.processes.keys());

    return {
      org_id: this.config.org_id,
      scope: this.config.scope,
      reviewers: pids.map(principalId => {
        const proc = this.processes.get(principalId)!;
        return {
          name: proc.reviewerName,
          principal_id: principalId,
          mode: proc.mode,
          agents: proc.agents.length,
          status: proc.running ? 'running' as const : 'stopped' as const,
          active_reviews: proc.activeReviews,
          total_reviews_completed: this.totalReviewsCompleted.get(principalId) ?? 0,
        };
      }),
      pending_approvals: this.pendingApprovals.length,
      total_agents: pids.reduce((s, pid) => s + (this.processes.get(pid)?.agents.length ?? 0), 0),
      uptime_seconds: this.running ? Math.floor((Date.now() - this.startTime) / 1000) : 0,
    };
  }

  isRunning(): boolean {
    return this.running;
  }

  getConfig(): FleetConfig {
    return this.config;
  }
}