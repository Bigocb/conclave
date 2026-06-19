/**
 * Conclave Fleet — Pluggable Reviewer Backends
 *
 * Supports four reviewer types:
 *   - llm:     OpenAI-compatible /v1/chat/completions (default)
 *   - slim:    Same as llm but with shorter timeout and lighter prompts
 *   - code:    Spawn a shell command, pipe task output, parse JSON stdout
 *   - pipeline: Chain multiple backends sequentially
 *
 * Every backend produces the same ReviewOutput shape so the consumer
 * never knows (or cares) what ran the review.
 */

import { execFile } from 'child_process';

// AgentRecord type used by reviewer backends
export type AgentRecord = {
  name?: string | null;
  model?: string | null;
  instructions?: string | null;
  skills?: string[] | null;
  command?: string | null;
  type?: string | null;
  provider?: string | null;
};

// ─── Types ──────────────────────────────────────────────────────

export interface ReviewOutput {
  scores: Record<string, number>;   // { correctness: 8, security: 7 }
  weighted_overall: number;         // 0-10 average
  reviewer_confidence: number;     // 0.0-1.0
  comment: string;                 // actionable feedback, ≤1500 chars
  suggestions: string[];           // specific improvement ideas
}

export interface ReviewInput {
  task_id: string;
  task_description: string;
  output: string;                  // the work being reviewed
  dimensions: string[];            // scoring dimensions
  channel: string;
  instructions?: string;           // agent-level custom instructions
  skills?: string[];               // skill names to inject
  memories?: string[];             // Durable project conventions/facts
}

// ─── LLM Backend (existing behavior) ────────────────────────────

import { getProviderConfig, resolveLlmUrl, buildAuthHeaders } from './providers.js';

// ─── LLM Backend (Corrected to use Provider Registry) ──────────────────────
    
export async function runLlmReview(
  agent: AgentRecord,
  input: ReviewInput,
  llmUrl: string,
  llmKey?: string,
  timeoutMs = 60000,
): Promise<ReviewOutput> {
  const systemPrompt = buildLlmSystemPrompt(input);
  const userPrompt = input.output || input.task_description || 'No output provided';

  // Resolve Provider Configuration
  const provider = agent.provider || 'openai';
  const config = getProviderConfig(provider);
  const endpoint = resolveLlmUrl(provider, llmUrl).replace(/\/$/, '');

  const payload = config.adaptPayload 
    ? config.adaptPayload({
        model: agent.model || 'gpt-4o-mini',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt.slice(0, 12000) },
        ],
        temperature: 0.3,
        max_tokens: 1500,
        stream: false,
      })
    : {
        model: agent.model || 'gpt-4o-mini',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt.slice(0, 12000) },
        ],
        temperature: 0.3,
        max_tokens: 1500,
        stream: false,
      };

  // FULL DEBUGGING: See exactly what is sent
  console.log(`[LLM-DEBUG] Backend Review Start`);
  console.log(`  Agent: ${agent.name}`);
  console.log(`  Provider: ${provider}`);
  console.log(`  URL: ${endpoint}`);
  console.log(`  Model: ${agent.model || 'gpt-4o-mini'}`);
  console.log(`  Key: ${llmKey ? `${llmKey.slice(0, 4)}...${llmKey.slice(-4)}` : 'NONE'}`);
  console.log(`[DBG-payload] FULL system_prompt (first 3000 chars):`, systemPrompt.slice(0, 3000));
  console.log(`[DBG-payload] system_prompt length: ${systemPrompt.length}`);
  const instructionsIdx = systemPrompt.indexOf('## Your Reviewer Instructions');
  if (instructionsIdx >= 0) {
    const section = systemPrompt.slice(instructionsIdx);
    const snippet = section.slice(0, 700);
    console.log(`[DBG-instructions-section] offset=${instructionsIdx} len=${section.length}`);
    console.log(`[DBG-instructions-section] snippet:\n${snippet}`);
  } else {
    console.log(`[DBG-payload] Contains instructions: false`);
  }
  console.log(`[DBG-payload] Full payload model: ${payload.model}`);
  console.log(`[DBG-payload] messages[0] role: ${payload.messages[0].role} content_length: ${payload.messages[0].content.length}`);
  console.log(`[DBG-payload] messages[1] role: ${payload.messages[1].role} content_length: ${payload.messages[1].content.length}`);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...buildAuthHeaders(provider, llmKey || ''),
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`LLM ${res.status}: ${text.slice(0, 200)}`);
    }

    const json: any = await res.json();
    const content = config.parseResponse(json) || '';
      
    console.log(`[LLM] Raw response for ${agent.name} (${content.length} chars):`, content.slice(0, 500));
    return parseLlmReviewResponse(content, input.dimensions);
  } finally {
    clearTimeout(timer);
  }
}

// ─── Slim Backend (LLM with aggressive timeout + light prompt) ──

export async function runSlimReview(
  agent: AgentRecord,
  input: ReviewInput,
  llmUrl: string,
  llmKey?: string,
): Promise<ReviewOutput> {
  // Slim uses 10s timeout and a truncated prompt
  return runLlmReview(agent, input, llmUrl, llmKey, 10_000);
}

// ─── Code Backend (shell command) ───────────────────────────────

export async function runCodeReview(
  agent: AgentRecord,
  input: ReviewInput,
  command: string,
  timeoutMs = 30000,
): Promise<ReviewOutput> {
  // Build the payload that gets piped to the command via stdin
  const payload = JSON.stringify({
    task_id: input.task_id,
    task_description: input.task_description,
    output: input.output,
    dimensions: input.dimensions,
    channel: input.channel,
    instructions: agent.instructions || '',
    skills: agent.skills || [],
  });

  return new Promise((resolve, reject) => {
    // Parse command into file + args (basic split on spaces, respect quotes)
    const parts = splitCommand(command);
    const file = parts[0];
    const args = parts.slice(1);

    const child = execFile(file, args, {
      timeout: timeoutMs,
      maxBuffer: 1024 * 1024, // 1MB
      env: { ...process.env, CONCLAVE_TASK_ID: input.task_id, CONCLAVE_CHANNEL: input.channel },
    }, (error, stdout, stderr) => {
      if (error) {
        // Non-zero exit code — treat as review failure
        reject(new Error(`Code reviewer exited ${error.code || 'unknown'}: ${stderr?.slice(0, 300)}`));
        return;
      }

      try {
        const result = JSON.parse(stdout.trim());
        // Validate shape
        if (!result.scores || typeof result.weighted_overall !== 'number') {
          throw new Error('Code reviewer output missing required fields: scores, weighted_overall');
        }
        resolve({
          scores: result.scores,
          weighted_overall: Math.min(10, Math.max(0, result.weighted_overall)),
          reviewer_confidence: result.reviewer_confidence ?? 1.0,
          comment: (result.comment || '').slice(0, 1500),
          suggestions: result.suggestions || [],
        });
      } catch (parseErr: any) {
        reject(new Error(`Code reviewer output parse error: ${parseErr.message}\nStdout: ${stdout.slice(0, 300)}`));
      }
    });

    // Pipe payload to stdin
    if (child.stdin) {
      child.stdin.write(payload);
      child.stdin.end();
    }
  });
}

// ─── Pipeline Backend ───────────────────────────────────────────

export async function runPipelineReview(
  steps: string[],                            // reviewer names to chain
  agent: AgentRecord,
  input: ReviewInput,
  runStep: (name: string, input: ReviewInput) => Promise<ReviewOutput>,
): Promise<ReviewOutput> {
  if (steps.length === 0) {
    throw new Error('Pipeline reviewer has no steps defined');
  }

  const results: ReviewOutput[] = [];
  let currentInput = { ...input };

  for (const stepName of steps) {
    const stepResult = await runStep(stepName, currentInput);
    results.push(stepResult);

    // Append previous step's findings to the input for the next step
    currentInput.instructions = [
      currentInput.instructions || '',
      `Previous review (${stepName}): score ${stepResult.weighted_overall}/10`,
      stepResult.comment,
    ].filter(Boolean).join('\n');
  }

  // Aggregate: average scores, take the most confident review's comment
  const allScores: Record<string, number[]> = {};
  for (const r of results) {
    for (const [dim, val] of Object.entries(r.scores)) {
      (allScores[dim] ??= []).push(val);
    }
  }

  const avgScores: Record<string, number> = {};
  for (const [dim, vals] of Object.entries(allScores)) {
    avgScores[dim] = vals.reduce((a, b) => a + b, 0) / vals.length;
  }

  const avgOverall = results.reduce((a, r) => a + r.weighted_overall, 0) / results.length;
  const bestConfidence = Math.max(...results.map(r => r.reviewer_confidence));

  // Use the last step's comment (deepest review), but include all suggestions
  const allSuggestions = results.flatMap(r => r.suggestions);
  const lastComment = results[results.length - 1]?.comment || '';

  return {
    scores: avgScores,
    weighted_overall: Math.round(avgOverall * 10) / 10,
    reviewer_confidence: bestConfidence,
    comment: lastComment.slice(0, 1500),
    suggestions: Array.from(new Set(allSuggestions)),
  };
}

// ─── Helpers ────────────────────────────────────────────────────

function buildLlmSystemPrompt(input: ReviewInput): string {
  const dims = input.dimensions.join(', ');

  // Build output format section using string concatenation
  // (can't use triple backticks inside template literals)
  const dimsJson = input.dimensions.map(d => '"' + d + '": number').join(', ');
  const outputFormat = '\n\n## Output Format\n\nRespond with a JSON block:\n\n' +
    '```json\n{\n  "scores": { ' + dimsJson + ' },\n' +
    '  "weighted_overall": number,\n  "reviewer_confidence": number,\n' +
    '  "comment": "string",\n  "suggestions": ["string"],\n' +
    '  "approved": true\n}\n```';

  let prompt = `You are an expert peer reviewer in the Conclave Agent Peer Protocol.

## Context

The submitting agent described what they did and what concerns them. Pay close attention to their concerns — this is the most important signal for your review.

**What the agent did:** ${input.task_description}

**Review channel:** ${input.channel}

## Durable Project Conventions

${input.memories && input.memories.length > 0
  ? input.memories.join('\n')
  : 'No specific project conventions identified for this review.'}

## Your Task

1. Read the submitted work carefully
2. Consider the agent's concerns above — focus your review on addressing those specific worries
3. Evaluate the work across each specified dimension (1-10 scale): ${dims}
4. Calculate a weighted overall score
5. Write a substantive review note (max 200 words) — the submitting agent needs **actionable feedback**: what specifically should change and why
6. List specific improvement suggestions
7. Decide if the work passes review (approved: true/false)

## CRITICAL: Use EXACTLY these dimension names

Your "scores" object MUST use exactly these keys, no substitutes, no aliases:
${input.dimensions.map(d => '  - "' + d + '"').join('\n')}

Do NOT change dimension names or add new ones. If a dimension is missing from your scores, the review will be rejected.

## Scoring Guidelines

- **9-10**: Exceptional — exceeds expectations, no significant issues
- **7-8**: Good — meets expectations, minor issues only
- **5-6**: Adequate — functional but notable gaps
- **3-4**: Below standard — significant issues that need rework
- **1-2**: Fundamental problems — needs complete rewrite`;

  if (input.instructions) {
    // Inject personality at the TOP of the prompt so it overrides the base persona
    const personalityBlock = `## Your Reviewer Instructions

${input.instructions}

Apply these instructions as your primary lens. They take precedence over any other guidance in this prompt. Evaluate everything through this perspective first.`;
    prompt = personalityBlock + '\n\n---\n\n' + prompt;
    console.log(`[DBG-instructions] Agent instructions FOUND and injected at top of prompt (${input.instructions.length} chars): ${input.instructions.slice(0, 500)}${input.instructions.length > 500 ? '...' : ''}`);
  }

  if (input.skills && input.skills.length > 0) {
    prompt += '\n\n## Relevant Skills\n\n' + input.skills.join(', ');
  }

  prompt += outputFormat;

  return prompt;
}

function parseLlmReviewResponse(content: string, dimensions: string[]): ReviewOutput {
  // Try to extract JSON from the response (LLM may wrap in markdown)
  let jsonStr = content;

  // Strip markdown code fences if present
  const fenceMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) {
    jsonStr = fenceMatch[1].trim();
  }

  // Find JSON object in the response — handle nested braces by tracking depth
  const braceStart = jsonStr.indexOf('{');
  if (braceStart !== -1) {
    let depth = 0;
    let braceEnd = -1;
    let inString = false;
    let escapeNext = false;
    for (let i = braceStart; i < jsonStr.length; i++) {
      const ch = jsonStr[i];
      if (escapeNext) { escapeNext = false; continue; }
      if (ch === '\\' && inString) { escapeNext = true; continue; }
      if (ch === '"') { inString = !inString; continue; }
      if (inString) continue;
      if (ch === '{') depth++;
      if (ch === '}') {
        depth--;
        if (depth === 0) { braceEnd = i; break; }
      }
    }
    if (braceEnd !== -1) {
      jsonStr = jsonStr.slice(braceStart, braceEnd + 1);
    }
  }

  try {
    const parsed = JSON.parse(jsonStr);

    const scores: Record<string, number> = {};
    for (const dim of dimensions) {
      const val = parsed.scores?.[dim];
      scores[dim] = typeof val === 'number' ? Math.min(10, Math.max(0, Math.round(val))) : 5;
    }

    return {
      scores,
      weighted_overall: Math.min(10, Math.max(0, parsed.weighted_overall ?? 5)),
      reviewer_confidence: Math.min(1, Math.max(0, ((parsed.reviewer_confidence ?? 0.7) > 1 ? (parsed.reviewer_confidence / 10) : parsed.reviewer_confidence))),
      comment: (parsed.comment || 'No comment provided.').slice(0, 1500),
      suggestions: Array.isArray(parsed.suggestions) ? parsed.suggestions : [],
    };
  } catch {
    // Second attempt: try to repair truncated JSON by closing open braces
    try {
      let repaired = jsonStr;
      // Count open vs close braces
      const openBraces = (repaired.match(/{/g) || []).length;
      const closeBraces = (repaired.match(/}/g) || []).length;
      const openBrackets = (repaired.match(/\[/g) || []).length;
      const closeBrackets = (repaired.match(/]/g) || []).length;
      // Close unclosed strings
      const unescapedQuotes = (repaired.match(/(?<!\\)"/g) || []).length;
      if (unescapedQuotes % 2 !== 0) repaired += '"';
      // Close unclosed brackets and braces
      for (let i = 0; i < openBrackets - closeBrackets; i++) repaired += ']';
      for (let i = 0; i < openBraces - closeBraces; i++) repaired += '}';

      const parsed = JSON.parse(repaired);
      const scores: Record<string, number> = {};
      for (const dim of dimensions) {
        const val = parsed.scores?.[dim];
        scores[dim] = typeof val === 'number' ? Math.min(10, Math.max(0, Math.round(val))) : 5;
      }
      return {
        scores,
        weighted_overall: Math.min(10, Math.max(0, parsed.weighted_overall ?? 5)),
        reviewer_confidence: Math.min(1, Math.max(0, ((parsed.reviewer_confidence ?? 0.7) > 1 ? (parsed.reviewer_confidence / 10) : parsed.reviewer_confidence))),
        comment: (parsed.comment || 'No comment provided.').slice(0, 1500),
        suggestions: Array.isArray(parsed.suggestions) ? parsed.suggestions : [],
      };
    } catch {
      // Fallback: couldn't parse JSON, return review with the raw content as comment
      return {
        scores: Object.fromEntries(dimensions.map(d => [d, 5])),
        weighted_overall: 5,
        reviewer_confidence: 0.3,
        comment: content.slice(0, 1500) || 'Review produced unparsable output.',
        suggestions: [],
      };
    }
  }
}

/**
 * Basic command splitter — respects double-quoted strings.
 * e.g. 'python3 "review.py" --mode strict' → ['python3', 'review.py', '--mode', 'strict']
 */
function splitCommand(cmd: string): string[] {
  const result: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i];
    if (ch === '"') {
      inQuotes = !inQuotes;
    } else if (ch === ' ' && !inQuotes) {
      if (current) result.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  if (current) result.push(current);
  return result;
}