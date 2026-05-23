#!/usr/bin/env node
/**
 * Conclave Reviewer Daemon
 *
 * A persistent agent that polls channel feeds and submits structured reviews.
 * Earns budget for its principal by reviewing tasks from other agents.
 *
 * Usage:
 *   npx tsx src/reviewer/index.ts \
 *     --server http://localhost:3000 \
 *     --principal prn_reviewer \
 *     --agent agt_reviewer \
 *     --channels code-review,security-review \
 *     --model gpt-4o \
 *     --llm-url https://api.openai.com/v1 \
 *     --llm-key sk-... \
 *     --interval 30
 *
 * Environment variables (alternative to flags):
 *   CONCLAVE_SERVER, CONCLAVE_PRINCIPAL, CONCLAVE_AGENT,
 *   CONCLAVE_CHANNELS, LLM_MODEL, LLM_URL, LLM_KEY
 */

import { ConclaveApiClient } from '../mcp/api-client.js';
import { loadPromptTemplate, channelPromptPath, DEFAULT_REVIEW_PROMPT } from './prompts.js';

// ─── Types ──────────────────────────────────────────────────

interface ReviewerConfig {
  serverUrl: string;
  principalId: string;
  agentId: string;
  token?: string;
  channels: string[];
  model: string;
  llmUrl: string;
  llmKey?: string;
  intervalSec: number;
  maxConcurrent: number;
  reviewedTaskIds: Set<string>;
}

interface LLMMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

interface LLMResponse {
  scores: Record<string, number>;
  weighted_overall: number;
  reviewer_confidence: number;
  comment: string;
  suggestions: string[];
  approved: boolean;
}

interface FeedTask {
  id: string;
  task_description?: string;
  description?: string;
  dimensions?: string[];
  output?: string;
  output_format?: string;
  channel?: string;
  status?: string;
  principal_id?: string;
}

// ─── CLI Arg Parsing ────────────────────────────────────────

function parseArgs(argv: string[]): Record<string, string> {
  const args: Record<string, string> = {};
  for (let i = 2; i < argv.length; i++) {
    if (argv[i].startsWith('--') && i + 1 < argv.length && !argv[i + 1].startsWith('--')) {
      args[argv[i].slice(2)] = argv[i + 1];
      i++;
    }
  }
  return args;
}

function getConfig(): ReviewerConfig {
  const cli = parseArgs(process.argv);

  return {
    serverUrl: cli.server ?? process.env.CONCLAVE_SERVER ?? 'http://localhost:3000',
    principalId: cli.principal ?? process.env.CONCLAVE_PRINCIPAL ?? 'prn_reviewer',
    agentId: cli.agent ?? process.env.CONCLAVE_AGENT ?? 'agt_reviewer',
    token: cli.token ?? process.env.CONCLAVE_TOKEN,
    channels: (cli.channels ?? process.env.CONCLAVE_CHANNELS ?? 'code-review').split(','),
    model: cli.model ?? process.env.LLM_MODEL ?? 'gpt-4o',
    llmUrl: (cli['llm-url'] ?? process.env.LLM_URL ?? 'https://api.openai.com/v1').replace(/\/$/, ''),
    llmKey: cli['llm-key'] ?? process.env.LLM_KEY,
    intervalSec: parseInt(cli.interval ?? '30', 10),
    maxConcurrent: parseInt(cli.concurrent ?? '1', 10),
    reviewedTaskIds: new Set(),
  };
}

// ─── LLM Call ──────────────────────────────────────────────

async function callLLM(config: ReviewerConfig, messages: LLMMessage[]): Promise<string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (config.llmKey) {
    headers['Authorization'] = `Bearer ${config.llmKey}`;
  }

  const res = await fetch(`${config.llmUrl}/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: config.model,
      messages,
      temperature: 0.3,
      max_tokens: 2048,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`LLM API error ${res.status}: ${body.slice(0, 500)}`);
  }

  const json = await res.json() as any;
  return json.choices?.[0]?.message?.content ?? '';
}

// ─── Parse structured review from LLM output ──────────────

function parseReviewResponse(text: string, dimensions: string[]): LLMResponse {
  // Try to extract JSON block from the response
  const jsonMatch = text.match(/```json\s*([\s\S]*?)```/) ?? text.match(/\{[\s\S]*\}/);

  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[1] ?? jsonMatch[0]);
      return {
        scores: parsed.scores ?? {},
        weighted_overall: parsed.weighted_overall ?? parsed.overall ?? 5,
        reviewer_confidence: parsed.reviewer_confidence ?? parsed.confidence ?? 0.5,
        comment: parsed.comment ?? '',
        suggestions: parsed.suggestions ?? [],
        approved: parsed.approved ?? false,
      };
    } catch {
      // Fall through to text parsing
    }
  }

  // Fallback: extract scores from text heuristically
  const scores: Record<string, number> = {};
  for (const dim of dimensions) {
    const regex = new RegExp(`${dim}[^\\d]*(\\d{1,2})`, 'i');
    const match = text.match(regex);
    if (match) {
      scores[dim] = Math.min(10, Math.max(1, parseInt(match[1], 10)));
    }
  }
  // Fill missing dimensions with 5
  for (const dim of dimensions) {
    if (!scores[dim]) scores[dim] = 5;
  }

  const overallMatch = text.match(/overall[^\\d]*(\\d{1,2})/i);
  const confMatch = text.match(/confidence[^\\d]*(0?\\.?\\d+)/i);

  return {
    scores,
    weighted_overall: overallMatch ? parseInt(overallMatch[1], 10) : 5,
    reviewer_confidence: confMatch ? parseFloat(confMatch[1]) : 0.5,
    comment: text.slice(0, 2000),
    suggestions: [],
    approved: /approved?\s*:\s*true|passes? review/i.test(text),
  };
}

// ─── Build review prompt ───────────────────────────────────

function buildReviewPrompt(task: FeedTask): LLMMessage[] {
  const desc = task.task_description ?? task.description ?? 'No description';
  const dimensions = (task.dimensions ?? ['correctness']).join(', ');
  const output = task.output ?? 'No output provided';
  const outputFormat = task.output_format ?? 'markdown';

  // Try loading a channel-specific prompt template
  const channelPrompt = task.channel
    ? loadPromptTemplate(channelPromptPath(task.channel))
    : null;

  const systemPrompt = channelPrompt ?? DEFAULT_REVIEW_PROMPT;

  const userMessage = [
    `## Task for Review`,
    ``,
    `**Description:** ${desc}`,
    `**Channel:** ${task.channel ?? 'general'}`,
    `**Review dimensions:** ${dimensions}`,
    ``,
    `### Output (${outputFormat})`,
    ``,
    output.slice(0, 12000), // Cap at ~12k chars to stay in context
    ``,
    `---`,
    ``,
    `Evaluate this work across each dimension (1-10) and provide your structured review as JSON.`,
  ].join('\n');

  return [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userMessage },
  ];
}

// ─── Review one task ───────────────────────────────────────

async function reviewTask(config: ReviewerConfig, client: ConclaveApiClient, task: FeedTask): Promise<boolean> {
  const label = `[${task.channel}] ${task.id}: "${(task.task_description ?? task.description ?? '').slice(0, 60)}"`;

  try {
    // 1. Build prompt
    const messages = buildReviewPrompt(task);

    // 2. Call LLM
    const llmOutput = await callLLM(config, messages);

    // 3. Parse structured response
    const review = parseReviewResponse(llmOutput, task.dimensions ?? ['correctness']);

    // 4. Submit to Conclave
    const result = await client.submitReview(task.id, {
      scores: review.scores,
      weighted_overall: review.weighted_overall,
      reviewer_confidence: review.reviewer_confidence,
      comment: review.comment,
      suggestions: review.suggestions,
      approved: review.approved,
    });

    console.log(`✅ Reviewed ${label} — overall: ${review.weighted_overall}, approved: ${review.approved}`);
    return true;
  } catch (err: any) {
    console.error(`❌ Failed to review ${label}: ${err.message}`);
    return false;
  }
}

// ─── Poll and review loop ──────────────────────────────────

async function pollAndReview(config: ReviewerConfig, client: ConclaveApiClient): Promise<number> {
  let reviewed = 0;

  for (const channel of config.channels) {
    try {
      const result = await client.getChannelFeed(channel);
      const items: any[] = Array.isArray(result.data) ? result.data : (result.data?.tasks ?? result.data?.items ?? []);

      for (const item of items) {
        // Only review tasks (not opinions or notifications)
        if (!item.id?.startsWith('tsk_')) continue;

        // Skip already-reviewed tasks
        if (config.reviewedTaskIds.has(item.id)) continue;

        // Skip own tasks
        if (item.principal_id === config.principalId) continue;

        // Skip completed/expired
        if (item.status === 'completed' || item.status === 'expired' || item.status === 'archived') continue;

        // Need the full task to get the output
        let task: FeedTask = item;
        if (!item.output) {
          try {
            const fullTask = await client.getTask(item.id);
            task = fullTask.data;
          } catch {
            console.error(`  Could not fetch task ${item.id}, skipping`);
            config.reviewedTaskIds.add(item.id);
            continue;
          }
        }

        // Review it
        const ok = await reviewTask(config, client, task);
        config.reviewedTaskIds.add(item.id);
        if (ok) reviewed++;

        // Respect concurrency
        if (reviewed >= config.maxConcurrent) break;
      }
    } catch (err: any) {
      console.error(`⚠️ Error polling channel "${channel}": ${err.message}`);
    }
  }

  return reviewed;
}

// ─── Main ──────────────────────────────────────────────────

async function main() {
  const config = getConfig();

  console.log([
    `╔══════════════════════════════════════════════╗`,
    `║     Conclave Reviewer Daemon                 ║`,
    `╚══════════════════════════════════════════════╝`,
    ``,
    `  Server:    ${config.serverUrl}`,
    `  Principal: ${config.principalId}`,
    `  Agent:     ${config.agentId}`,
    `  Channels:  ${config.channels.join(', ')}`,
    `  Model:     ${config.model}`,
    `  LLM URL:   ${config.llmUrl}`,
    `  Interval:  ${config.intervalSec}s`,
    ``,
    `  Earning +3 budget per review.`,
    `  Watching for new tasks...`,
    ``,
  ].join('\n'));

  const client = new ConclaveApiClient({
    serverUrl: config.serverUrl,
    principalId: config.principalId,
    agentId: config.agentId,
    token: config.token,
  });

  // Ensure the reviewer principal and agent exist
  await ensureReviewerExists(client, config);

  // Subscribe to channels
  for (const channel of config.channels) {
    try {
      await client.subscribeToChannel(channel);
      console.log(`  Subscribed to ${channel}`);
    } catch (err: any) {
      if (err.message?.includes('ALREADY_SUBSCRIBED')) {
        console.log(`  Already subscribed to ${channel}`);
      } else {
        console.error(`  Failed to subscribe to ${channel}: ${err.message}`);
      }
    }
  }

  console.log('');

  // Poll loop
  let round = 0;
  const loop = async () => {
    round++;
    try {
      const count = await pollAndReview(config, client);
      const ts = new Date().toISOString().slice(11, 19);
      if (count > 0) {
        console.log(`[${ts}] Round ${round}: reviewed ${count} task(s)`);
      } else {
        // Only log idle every 10th round to reduce noise
        if (round % 10 === 1) {
          console.log(`[${ts}] Round ${round}: idle — no new tasks`);
        }
      }
    } catch (err: any) {
      console.error(`[${new Date().toISOString().slice(11, 19)}] Poll error: ${err.message}`);
    }
  };

  // Initial poll
  await loop();

  // Schedule polling
  setInterval(loop, config.intervalSec * 1000);
}

async function ensureReviewerExists(client: ConclaveApiClient, config: ReviewerConfig) {
  // Try to get the principal
  try {
    await client.getPrincipal(config.principalId);
  } catch {
    // Create it
    try {
      await client.createPrincipal({
        name: 'Reviewer Agent',
        org_id: 'org_dev',
        roles: ['reviewer'],
        capabilities: config.channels,
      });
      console.log(`  Created principal ${config.principalId}`);
    } catch (err: any) {
      console.error(`  Could not create principal: ${err.message}`);
    }
  }

  // Try to get the agent
  try {
    await client.getAgent(config.agentId);
  } catch {
    // Register it
    try {
      await client.registerAgentUnderPrincipal(config.principalId, {
        name: 'Reviewer Agent',
        model: config.model,
      });
      console.log(`  Registered agent ${config.agentId}`);
    } catch (err: any) {
      console.error(`  Could not register agent: ${err.message}`);
    }
  }
}

main().catch((err) => {
  console.error('Reviewer daemon failed to start:', err);
  process.exit(1);
});