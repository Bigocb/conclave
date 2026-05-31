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

async function callLLM(opts: {
    url: string;
    key: string;
    model: string;
    systemPrompt: string;
    userMessage: string;
  }): Promise<string> {
    // Handle Ollama Cloud Specifics
    const isOllamaCloud = opts.url.includes('ollama.com');
    let endpoint = opts.url.replace(/\\/$/, '');

    if (isOllamaCloud) {
      // Ollama Cloud uses /api/chat instead of /v1/chat/completions
      endpoint = endpoint.endsWith('/api/chat') ? endpoint : `${endpoint}/api/chat`;
    } else {
      // Normalize OpenAI-style URL
      if (endpoint.endsWith('/v1')) {
        endpoint += '/chat/completions';
      } else if (endpoint.endsWith('/chat/completions')) {
        // already full
      } else if (!endpoint.includes('/chat/completions')) {
        endpoint += '/v1/chat/completions';
      }
    }

    const body = {
      model: opts.model,
      messages: [
        { role: 'system', content: opts.systemPrompt },
        { role: 'user', content: opts.userMessage },
      ],
      temperature: 0.3,
      max_tokens: 2000,
      stream: false,
    };

    const resp = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${opts.key}`,
      },
      body: JSON.stringify(body),
    });

    if (!resp.ok) {
      const bodyText = await resp.text().catch(() => '');
      throw new Error(`LLM API error ${resp.status}: ${bodyText.slice(0, 200)}`);
    }

    const data = await resp.json() as any;
    
    if (isOllamaCloud) {
      return data.message?.content ?? '';
    }
    
    return data.choices?.[0]?.message?.content ?? '';
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
    const jsonMatch = raw.match(/```json\\s*([\\s\\S]*?)\\s*```/) || raw.match(/\\{[\\s\\S]*\\}/);
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

  constructor(config: FleetConfig) {
    super();
    this.config = config;
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
    console.log('🔧 Provisioning fleet...\\n');

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

      // 3. Create API client with the first agent's ID and its own token
      let agentToken = agents[0]?.token || '';
      if (!agentToken) {
        // Try to get/fetch a token for the first agent so auth resolves correctly
        try {
          const agentTokenResp = await fetch(`${this.config.server}/v1/agents/${agents[0]?.agentId}/regenerate-token`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${this.config.token}`,
            },
          });
          if (agentTokenResp.ok) {
            const tokenData = await agentTokenResp.json() as any;
            agentToken = tokenData.data?.token ?? tokenData.token ?? '';
            agents[0] = { ...agents[0], token: agentToken };
          }
        } catch { /* fallback */ }
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
        model: reviewer.model,
        llmUrl: reviewer.llm_url,
        llmKey: reviewer.llm_key,
        instructions: reviewer.instructions,
        skills: reviewer.skills,
        running: false,
        activeReviews: 0,
        reviewedTaskIds: new Set(),
      });

      this.totalReviewsCompleted.set(principalId, 0);
    }

    console.log('\\n✅ Fleet provisioned\\n');
  }

  // ─── Start / Stop ────────────────────────────────────────

  async start(): Promise<void> {
    this.running = true;
    this.startTime = Date.now();
    console.log('🚀 Starting fleet...\\n');

    const pids = Array.from(this.processes.keys());
    for (const principalId of pids) {
      const proc = this.processes.get(principalId)!;
      proc.running = true;
      this.startPolling(principalId);

      const modeIcon = proc.mode === 'auto' ? '🤖' : proc.mode === 'human' ? '👤' : '🔀';
      console.log(`  ${modeIcon} ${proc.reviewerName} (${proc.mode}) — polling every ${proc.interval}s`);
    }

    this.emit('started');
    console.log('\\n✅ Fleet running\\n');
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

    this.emit('stopped');
    console.log('\\n🛑 Fleet stopped');
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
          // Skip own org's tasks in private mode
          if (this.config.scope === 'private' && feedItem.org_id && feedItem.org_id !== this.config.org_id) {
            console.log(`  ⏭ ${proc.reviewerName}: Skipping ${taskId} (private scope mismatch: ${feedItem.org_id} != ${this.config.org_id})`);
            this.broadcastPulse('FLEET_SKIP', { taskId, reason: 'private scope mismatch', reviewerName: proc.reviewerName });
            continue;
          }

          if (proc.activeReviews >= proc.maxConcurrent) break;

          // Mark as seen to prevent duplicate picks
          proc.reviewedTaskIds.add(taskId);
        }
      } catch (err: any) {
        console.error(`  ❌ ${proc.reviewerName} poll error:`, err.message);
      }
    }
  }
}
