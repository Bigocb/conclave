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
}

// ─── LLM Backend (existing behavior) ────────────────────────────

export async function runLlmReview(
  agent: AgentRecord,
  input: ReviewInput,
  llmUrl: string,
  llmKey?: string,
  timeoutMs = 60000,
): Promise<ReviewOutput> {
  const systemPrompt = buildLlmSystemPrompt(input);
  const userPrompt = input.output || input.task_description || 'No output provided';

  const body = {
    model: agent.model || 'gpt-4o-mini',
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt.slice(0, 12000) },
    ],
    temperature: 0.3,
    max_tokens: 1500,
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(`${llmUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(llmKey ? { Authorization: `Bearer ${llmKey}` } : {}),
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`LLM ${res.status}: ${text.slice(0, 200)}`);
    }

    const json: any = await res.json();
    const content = json.choices?.[0]?.message?.content || '';
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
  let prompt = `You are an expert peer reviewer in the Conclave Agent Peer Protocol.

## Context

The submitting agent described what they did and what concerns them. Pay close attention to their concerns — this is the most important signal for your review.

**What the agent did:** ${input.task_description}

**Review channel:** ${input.channel}

## Your Task

1. Read the submitted work carefully
2. Consider the agent's concerns above — focus your review on addressing those specific worries
3. Evaluate the work across each specified dimension (1-10 scale): ${dims}
4. Calculate a weighted overall score
5. Write a substantive review note (max 200 words) — the submitting agent needs **actionable feedback**: what specifically should change and why
6. List specific improvement suggestions
7. Decide if the work passes review (approved: true/false)

## Scoring Guidelines

- **9-10**: Exceptional — exceeds expectations, no significant issues
- **7-8**: Good — meets expectations, minor issues only  
- **5-6**: Adequate — functional but notable gaps
- **3-4**: Below standard — significant issues that need rework
- **1-2**: Fundamental problems — needs complete rewrite`;

  if (input.instructions) {
    prompt += `\n\n## Your Reviewer Instructions\n\n${input.instructions}\n\nApply these instructions as your primary lens. Everything you evaluate should be filtered through this perspective.`;
  }

  if (input.skills && input.skills.length > 0) {
    prompt += `\n\n## Relevant Skills\n\n${input.skills.join(', ')}`;
  }

  prompt += `

## Output Format

Respond with a JSON block:

\`\`\`json
{
  "scores": { ${input.dimensions.map(d => `"${d}": number`).join(', ')} },
  "weighted_overall": number,
  "reviewer_confidence": number,
  "comment": "string",
  "suggestions": ["string"]
}`;

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
      reviewer_confidence: Math.min(1, Math.max(0, parsed.reviewer_confidence ?? 0.7)),
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
        reviewer_confidence: Math.min(1, Math.max(0, parsed.reviewer_confidence ?? 0.7)),
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