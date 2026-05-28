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
    const body = await resp.text().catch(() => '');
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
          const resp = await regClient.registerAgentUnderPrincipal(principalId, {
            name: `${reviewer.name} #${i + 1}`,
            type: reviewer.type || 'llm',
            model: reviewer.model,
            provider: reviewer.provider,
            llm_url: reviewer.llm_url,
            command: reviewer.command,
            instructions: reviewer.instructions,
            skills: reviewer.skills,
          });
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

      // 3. Create API client with a robust authentication strategy
      // We use the org-level token as the primary authority to avoid 403s during task fetching
      const pollingClient = new ConclaveApiClient({
        serverUrl: this.config.server,
        principalId,
        agentId: agents[0]?.agentId,
        token: this.config.token, 
      });
      
      // If the agent has a specific token, we can use it for submission, 
      // but the pollingClient uses the config.token to ensure it can always see the feed.
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
          if (taskStatus === 'completed' || taskStatus === 'cancelled') continue;

          // Skip own org's tasks in private mode
          if (this.config.scope === 'private' && feedItem.org_id && feedItem.org_id !== this.config.org_id) {
            continue;
          }

          if (proc.activeReviews >= proc.maxConcurrent) break;

          // Mark as seen to prevent duplicate picks
          proc.reviewedTaskIds.add(taskId);
          console.log(`  🎯 ${proc.reviewerName} found task ${taskId} on channel ${channel}`);

          // Fetch full task details (feed only has summary)
          let fullTask = feedItem;
          let taskFetchFailed = false;
          try {
            const taskResp = await client.getTask(taskId);
            fullTask = taskResp.data;
          } catch {
            taskFetchFailed = true;
          }

          // Skip tasks we can't fetch — wrong org or insufficient permissions
          if (taskFetchFailed) {
            console.log(`  ⚠ ${proc.reviewerName}: Cannot fetch task ${taskId} — skipping`);
            proc.reviewedTaskIds.delete(taskId);
            continue;
          }

          // Process async
          this.reviewTask(principalId, fullTask, channel).catch(err => {
            console.error(`  ❌ Review failed for task ${taskId}:`, err.message);
            // Remove from seen set so it can be retried on the next poll
            proc.reviewedTaskIds.delete(taskId);
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
      // 1. Build input for any backend type
      const taskId = task.id ?? task.task_id;
      const reviewInput: ReviewInput = {
        task_id: taskId,
        task_description: task.description,
        output: task.output,
        dimensions: Array.isArray(task.dimensions) ? task.dimensions : JSON.parse(task.dimensions || '[]'),
        channel,
        instructions: proc.instructions,
        skills: proc.skills,
      };

      // Build a minimal agent record for the backend
      const agentRecord: any = {
        model: proc.model,
        instructions: proc.instructions,
        skills: proc.skills,
      };

      // 2. Dispatch to the right backend based on type
      let draft: ReviewOutput;
      const reviewerType = proc.type || 'llm';

      if (reviewerType === 'code') {
        if (!proc.command) throw new Error('Code reviewer has no command configured');
        draft = await runCodeReview(agentRecord, reviewInput, proc.command);
      } else if (reviewerType === 'slim') {
        draft = await runSlimReview(agentRecord, reviewInput, proc.llmUrl, proc.llmKey);
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
            const stepAgent: any = { model: stepProc.model, instructions: stepProc.instructions, skills: stepProc.skills };
            const stepType = stepProc.type || 'llm';
            if (stepType === 'code') return runCodeReview(stepAgent, input, stepProc.command!);
            if (stepType === 'slim') return runSlimReview(stepAgent, input, stepProc.llmUrl, stepProc.llmKey);
            return runLlmReview(stepAgent, input, stepProc.llmUrl, stepProc.llmKey);
          },
        );
      } else {
        // Default: full LLM review
        draft = await runLlmReview(agentRecord, reviewInput, proc.llmUrl, proc.llmKey);
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