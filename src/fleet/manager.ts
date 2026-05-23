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

// ─── Types ──────────────────────────────────────────────────

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
  mode: ReviewerMode;
  confidenceThreshold: number;
  interval: number;
  maxConcurrent: number;
  prompt: string;
  model: string;
  llmUrl: string;
  llmKey: string;
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
  // Normalize URL: ensure /v1/chat/completions endpoint
  let endpoint = opts.url.replace(/\/$/, '');
  if (endpoint.endsWith('/v1')) {
    endpoint += '/chat/completions';
  } else if (endpoint.endsWith('/chat/completions')) {
    // already full
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
  });

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`LLM API error ${resp.status}: ${body.slice(0, 200)}`);
  }

  const data = await resp.json() as any;
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

  constructor(config: FleetConfig) {
    super();
    this.config = config;
  }

  // ─── Provisioning ────────────────────────────────────────

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
        principalId: 'prn_dev', // use a known principal for bootstrapping
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

      // Create API client with the actual principal ID
      const client = new ConclaveApiClient({
        serverUrl: this.config.server,
        principalId,
      });
      this.apiClients.set(principalId, client);

      // 2. Register agents (one per replica)
      const agents: Array<{ agentId: string; token: string; index: number }> = [];
      for (let i = 0; i < reviewer.replicas; i++) {
        const suffix = reviewer.replicas > 1 ? `_${i + 1}` : '';
        const agentId = `agt_${principalId.replace('prn_', '')}${suffix}`;
        try {
          const resp = await client.registerAgentUnderPrincipal(principalId, {
            name: `${reviewer.name} #${i + 1}`,
            model: reviewer.model,
            provider: reviewer.provider,
            llm_url: reviewer.llm_url,
            instructions: reviewer.instructions,
            skills: reviewer.skills,
          });
          const data = resp.data as any;
          agents.push({ agentId: data.agent_id ?? data.id ?? agentId, token: data.token ?? '', index: i });
          console.log(`  Agent registered: ${agentId} under ${principalId}`);
        } catch (err: any) {
          if (err.message?.includes('already exists') || err.message?.includes('duplicate')) {
            agents.push({ agentId, token: '', index: i });
            console.log(`  Agent exists: ${agentId}`);
          } else {
            console.warn(`  ⚠ Agent registration failed: ${err.message}`);
            agents.push({ agentId, token: '', index: i });
          }
        }
      }

      // 3. Subscribe to channels
      for (const ch of reviewer.channels) {
        try {
          await client.subscribeToChannel(ch);
          console.log(`  Subscribed: ${principalId} → ${ch}`);
        } catch (err: any) {
          if (!err.message?.includes('already subscribed') && !err.message?.includes('duplicate')) {
            console.warn(`  ⚠ Subscribe ${ch}: ${err.message}`);
          }
        }
      }

      // 4. Load prompt template
      let prompt = DEFAULT_REVIEW_PROMPT;
      if (reviewer.prompt) {
        try {
          prompt = loadPromptTemplate(reviewer.prompt);
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
        mode: reviewer.mode,
        confidenceThreshold: reviewer.confidence_threshold,
        interval: reviewer.interval ?? 30,
        maxConcurrent: reviewer.max_concurrent ?? 1,
        prompt,
        model: reviewer.model,
        llmUrl: reviewer.llm_url,
        llmKey: reviewer.llm_key,
        running: false,
        activeReviews: 0,
        reviewedTaskIds: new Set(),
      });

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
    console.log('\n🛑 Fleet stopped');
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

    if (proc.activeReviews >= proc.maxConcurrent) return;

    for (const channel of proc.channels) {
      try {
        const resp = await client.getChannelFeed(channel);
        const data = resp.data as any;
        const tasks: any[] = data?.tasks ?? [];
        if (!Array.isArray(tasks)) continue;

        for (const feedItem of tasks) {
          // Feed items use 'task_id', not 'id'
          const taskId = feedItem.task_id ?? feedItem.id;
          if (!taskId) continue;

          // Skip if already reviewed by this principal (local dedup)
          if (proc.reviewedTaskIds.has(taskId)) continue;

          // Skip own org's tasks in private mode
          if (this.config.scope === 'private' && feedItem.org_id && feedItem.org_id !== this.config.org_id) {
            continue;
          }

          if (proc.activeReviews >= proc.maxConcurrent) break;

          // Mark as seen to prevent duplicate picks
          proc.reviewedTaskIds.add(taskId);

          // Fetch full task details (feed only has summary)
          let fullTask = feedItem;
          try {
            const taskResp = await client.getTask(taskId);
            fullTask = taskResp.data;
          } catch {
            // Use feed item as fallback
          }

          // Process async
          this.reviewTask(principalId, fullTask, channel).catch(err => {
            console.error(`  ❌ Review failed for task ${taskId}:`, err.message);
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

    try {
      // 1. Call LLM to draft review
      const userMessage = `## Task to Review\n\n**Description:** ${task.description}\n\n**Channel:** ${channel}\n**Dimensions:** ${Array.isArray(task.dimensions) ? task.dimensions.join(', ') : task.dimensions}\n\n**Output:**\n${task.output}`;

      const rawResponse = await callLLM({
        url: proc.llmUrl,
        key: proc.llmKey,
        model: proc.model,
        systemPrompt: proc.prompt,
        userMessage,
      });

      const draft = parseReviewResponse(rawResponse);
      if (!draft) {
        console.warn(`  ⚠ ${proc.reviewerName}: Could not parse LLM response for task ${task.id} — skipping`);
        return;
      }

      // 2. Route based on mode
      if (proc.mode === 'auto') {
        await client.submitReview(task.id, draft);
        this.incrementCompleted(principalId);
        console.log(`  ✅ ${proc.reviewerName}: Auto-reviewed task ${task.id} (overall: ${draft.weighted_overall})`);
        this.emit('review_completed', { principalId, taskId: task.id, mode: 'auto' });

      } else if (proc.mode === 'human') {
        const pending: PendingReview = {
          id: `pnd_${randomUUID().replace(/-/g, '').slice(0, 24)}`,
          taskId: task.id,
          channel,
          reviewerName: proc.reviewerName,
          principalId,
          agentId: agent.agentId,
          draft,
          createdAt: new Date().toISOString(),
        };
        this.pendingApprovals.push(pending);
        console.log(`  👤 ${proc.reviewerName}: Draft queued for human approval — task ${task.id} (pending: ${this.pendingApprovals.length})`);
        this.emit('review_pending', pending);

      } else if (proc.mode === 'hybrid') {
        if (draft.reviewer_confidence >= proc.confidenceThreshold) {
          await client.submitReview(task.id, draft);
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
            draft,
            createdAt: new Date().toISOString(),
          };
          this.pendingApprovals.push(pending);
          console.log(`  🔀 ${proc.reviewerName}: Low confidence (${draft.reviewer_confidence} < ${proc.confidenceThreshold}) — queued for human — task ${task.id}`);
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