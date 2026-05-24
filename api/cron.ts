/**
 * Conclave — Vercel Cron Review Endpoint
 *
 * Called every 2 minutes by Vercel Cron.
 * Does a single sweep: find open tasks → call LLMs → submit reviews.
 *
 * Also callable manually: GET/POST /v1/cron/review
 * Protected by CRON_SECRET env var (or VERCEL_CRON_SECRET by default).
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';

let app: any = null;
let initPromise: Promise<void> | null = null;

async function initApp() {
  if (app) return;
  if (initPromise) { await initPromise; return; }

  initPromise = (async () => {
    const serverModule = await import('../dist/server/index.js');
    const config = {
      mode: (process.env.CONCLAVE_MODE || 'cloud') as 'local' | 'self-hosted' | 'cloud',
      port: 3000,
      host: '0.0.0.0',
      database: { url: process.env.DATABASE_URL! },
      jwtSecret: process.env.CONCLAVE_JWT_SECRET || 'conclave-dev-secret-change-in-production',
    };
    const { fastify } = await serverModule.createServer(config);
    await fastify.ready();
    app = fastify;
  })();

  await initPromise;
}

export const config = {
  maxDuration: 60,
};

interface ReviewerDef {
  name: string;
  channels: string[];
  model: string;
  provider: string;
  llm_url: string;
  llm_key: string;
  mode: string;
  instructions: string;
  skills: string[];
  replicas: number;
  interval: number;
}

interface FleetConfig {
  org_id: string;
  server: string;
  scope: string;
  providers: Record<string, string>;
  reviewers: ReviewerDef[];
}

/** Parse fleet.yaml — same logic as src/fleet/config.ts but self-contained for serverless */
function parseFleetYaml(yaml: string): FleetConfig {
  // Minimal YAML parser for our fleet config format
  const lines = yaml.split('\n');
  const config: any = { providers: {}, reviewers: [] };
  let currentReviewer: any = null;
  let inReviewers = false;

  for (const rawLine of lines) {
    const line = rawLine;
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    // Top-level string keys
    if (line.startsWith('org_id:')) config.org_id = line.split(':')[1].trim().replace(/["']/g, '');
    else if (line.startsWith('server:')) config.server = line.split(':')[1].trim().replace(/["']/g, '');
    else if (line.startsWith('scope:')) config.scope = line.split(':')[1].trim().replace(/["']/g, '');

    // Providers section
    else if (line.match(/^\s*\w+_?\w*:/) && !line.startsWith(' ') && !inReviewers) {
      // Could be a provider mapping
    }

    // Start of reviewers list
    else if (trimmed === '- name:' || trimmed.startsWith("- name:")) {
      inReviewers = true;
      currentReviewer = {};
      const val = trimmed.replace('- name:', '').trim().replace(/["']/g, '');
      currentReviewer.name = val;
      currentReviewer.channels = [];
      currentReviewer.skills = [];
      currentReviewer.replicas = 1;
      currentReviewer.interval = 15;
      currentReviewer.mode = 'auto';
      config.reviewers.push(currentReviewer);
    }

    // Reviewer fields
    else if (currentReviewer && line.match(/^\s+/)) {
      const [key, ...rest] = trimmed.split(':');
      const val = rest.join(':').trim().replace(/["']/g, '');
      if (key === 'channels') {
        // Parse YAML list: [general-qa, code-review]
        const match = val.match(/\[(.*)\]/);
        if (match) currentReviewer.channels = match[1].split(',').map(s => s.trim());
      } else if (key === 'skills') {
        const match = val.match(/\[(.*)\]/);
        if (match) currentReviewer.skills = match[1].split(',').map(s => s.trim());
      } else if (key === 'replicas' || key === 'interval') {
        currentReviewer[key] = parseInt(val, 10) || (key === 'replicas' ? 1 : 15);
      } else if (val) {
        currentReviewer[key] = val;
      }
    }

    // Provider mapping (e.g. "ollama_cloud: https://...")
    else if (line.includes(': https://') || line.includes(': http://')) {
      const [key, ...rest] = line.split(': ');
      const val = rest.join(': ').trim();
      config.providers[key.trim()] = val;
    }
  }

  return config as FleetConfig;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // Verify cron secret if set
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret) {
    const provided = (req.headers['authorization'] as string)?.replace('Bearer ', '') || req.query?.secret;
    if (provided !== cronSecret) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
  }

  // Allow Vercel Cron headers
  if (process.env.VERCEL && !cronSecret) {
    // Vercel Cron sends X-Vercel-Cron-Secret header if configured
  }

  const startTime = Date.now();

  try {
    await initApp();

    // 1. Read fleet config from env (JSON) or embedded defaults
    let fleetConfig: FleetConfig;
    const fleetJson = process.env.FLEET_CONFIG;

    if (fleetJson) {
      fleetConfig = JSON.parse(fleetJson);
    } else {
      // Use default config for Ollama Cloud reviewers
      const ollamaKey = process.env.OLLAMA_KEY || '';
      fleetConfig = {
        org_id: 'org_dev',
        server: `https://${req.headers.host}`,
        scope: 'public',
        providers: { ollama_cloud: 'https://www.ollama.com/v1' },
        reviewers: [
          {
            name: 'Code Reviewer',
            channels: ['general-qa', 'code-review'],
            model: 'deepseek-v4-flash',
            provider: 'ollama_cloud',
            llm_url: 'https://www.ollama.com/v1',
            llm_key: ollamaKey,
            mode: 'auto',
            instructions: 'You are a senior code reviewer. Focus on correctness, security, performance, and readability. Cite specific lines. Be constructive and specific. Max 200 words.',
            skills: ['security-audit', 'system-design'],
            replicas: 1,
            interval: 15,
          },
          {
            name: 'General Reviewer',
            channels: ['general-qa', 'code-review'],
            model: 'glm-5.1',
            provider: 'ollama_cloud',
            llm_url: 'https://www.ollama.com/v1',
            llm_key: ollamaKey,
            mode: 'auto',
            instructions: 'Review for factual accuracy, clarity, and quality. Be concise, specific, and helpful. Focus on what matters most.',
            skills: ['reasoning'],
            replicas: 1,
            interval: 20,
          },
          {
            name: 'Architecture Reviewer',
            channels: ['general-qa', 'code-review'],
            model: 'deepseek-v4-flash',
            provider: 'ollama_cloud',
            llm_url: 'https://www.ollama.com/v1',
            llm_key: ollamaKey,
            mode: 'auto',
            instructions: 'You are an expert in software architecture, system design, and scalability. Review with an eye toward maintainability, extensibility, and clean abstractions.',
            skills: ['system-design', 'scalability'],
            replicas: 1,
            interval: 25,
          },
        ],
      };
    }

    // 2. Ensure reviewer principals/agents exist (provision)
    const results: any[] = [];

    for (const reviewer of fleetConfig.reviewers) {
      const principalSlug = 'prn_' + reviewer.name.toLowerCase().replace(/[^a-z0-9]+/g, '').slice(0, 20);

      // Get or create principal
      let principalId: string;
      try {
        const listRes = await app.inject({ method: 'GET', url: '/v1/principals', headers: { 'x-agent-id': 'agt_dev' } });
        const principals = JSON.parse(listRes.body).data || [];
        const existing = principals.find((p: any) => p.name === reviewer.name);
        if (existing) {
          principalId = existing.id;
        } else {
          const createRes = await app.inject({
            method: 'POST', url: '/v1/principals',
            headers: { 'x-agent-id': 'agt_dev', 'content-type': 'application/json' },
            payload: JSON.stringify({ name: reviewer.name, roles: reviewer.channels.map((c: string) => `reviewer:${c}`), capabilities: ['review'], metadata: { fleet: true, mode: reviewer.mode, model: reviewer.model } }),
          });
          principalId = JSON.parse(createRes.body).data.id;
        }
      } catch (e: any) {
        results.push({ reviewer: reviewer.name, error: `Principal setup failed: ${e.message}` });
        continue;
      }

      // Get or create agent
      let agentId: string;
      try {
        const agentListRes = await app.inject({ method: 'GET', url: `/v1/principals/${principalId}/agents`, headers: { 'x-agent-id': 'agt_dev' } });
        const agents = JSON.parse(agentListRes.body).data?.agents || JSON.parse(agentListRes.body).data || [];
        const existing = Array.isArray(agents) ? agents.find((a: any) => a.name?.includes(reviewer.name)) : null;
        if (existing) {
          agentId = existing.id;
        } else {
          const regRes = await app.inject({
            method: 'POST', url: `/v1/principals/${principalId}/agents`,
            headers: { 'x-agent-id': 'agt_dev', 'content-type': 'application/json' },
            payload: JSON.stringify({
              name: `${reviewer.name} #1`,
              type: 'llm',
              model: reviewer.model,
              provider: reviewer.provider,
              llm_url: reviewer.llm_url,
              instructions: reviewer.instructions,
              skills: reviewer.skills,
            }),
          });
          agentId = JSON.parse(regRes.body).data?.agent_id || JSON.parse(regRes.body).data?.id || `agt_${principalId.replace('prn_', '')}`;
        }
      } catch (e: any) {
        results.push({ reviewer: reviewer.name, error: `Agent setup failed: ${e.message}` });
        continue;
      }

      // Subscribe to channels
      for (const channel of reviewer.channels) {
        try {
          await app.inject({ method: 'POST', url: `/v1/channels/${channel}/subscribe`, headers: { 'x-agent-id': agentId } });
        } catch { /* already subscribed */ }
      }

      // 3. Poll channels for open tasks and review them
      const reviewed: string[] = [];

      for (const channel of reviewer.channels) {
        try {
          const feedRes = await app.inject({ method: 'GET', url: `/v1/channels/${channel}/feed`, headers: { 'x-agent-id': agentId } });
          const feedData = JSON.parse(feedRes.body);
          const tasks = feedData.data?.tasks || [];

          for (const task of tasks) {
            if (task.status === 'completed' || task.status === 'cancelled') continue;

            // Check if this principal already reviewed this task
            const detailRes = await app.inject({ method: 'GET', url: `/v1/tasks/${task.task_id || task.id}`, headers: { 'x-agent-id': agentId } });
            const taskData = JSON.parse(detailRes.body).data;
            if (!taskData || taskData.status === 'completed') continue;

            const existingReviews = taskData.reviews || [];
            if (existingReviews.some((r: any) => r.principal_id === principalId)) continue;

            // Build review prompt
            const dimensions = taskData.dimensions || ['correctness', 'readability', 'security', 'performance'];
            const prompt = `Review the following ${taskData.output_format || 'code'} for ${dimensions.join(', ')}.\n\nTask: ${taskData.description}\n\nOutput to review:\n${taskData.output || 'No output provided'}\n\nRespond with ONLY a JSON block:\n\`\`\`json\n{\n  "scores": {${dimensions.map((d: string) => `"${d}": <1-10>`).join(', ')}},\n  "weighted_overall": <1-10>,\n  "reviewer_confidence": <0.0-1.0>,\n  "comment": "<detailed review, max 500 words>",\n  "suggestions": ["<suggestion 1>", "<suggestion 2>"]\n}\n\`\`\``;

            // Call LLM
            const llmUrl = reviewer.llm_url || (fleetConfig.providers[reviewer.provider] || '');
            const llmKey = reviewer.llm_key || process.env.OLLAMA_KEY || '';

            try {
              const llmRes = await fetch(`${llmUrl}/chat/completions`, {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  ...(llmKey ? { 'Authorization': `Bearer ${llmKey}` } : {}),
                },
                body: JSON.stringify({
                  model: reviewer.model,
                  messages: [
                    { role: 'system', content: reviewer.instructions },
                    { role: 'user', content: prompt },
                  ],
                  temperature: 0.3,
                  max_tokens: 1500,
                }),
              });

              if (!llmRes.ok) {
                const errBody = await llmRes.text().catch(() => '');
                results.push({ reviewer: reviewer.name, task: task.task_id || task.id, error: `LLM ${llmRes.status}: ${errBody.slice(0, 200)}` });
                continue;
              }

              const llmJson = await llmRes.json() as any;
              const content = llmJson.choices?.[0]?.message?.content || '';
              if (!content) {
                results.push({ reviewer: reviewer.name, task: task.task_id || task.id, error: 'Empty LLM response' });
                continue;
              }

              // Parse LLM response
              let parsed: any = null;
              const jsonMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/);
              const jsonStr = jsonMatch ? jsonMatch[1] : content;
              const braceStart = jsonStr.indexOf('{');
              if (braceStart !== -1) {
                try {
                  parsed = JSON.parse(jsonStr.slice(braceStart).replace(/}[^}]*$/, '}'));
                } catch {
                  let depth = 0, end = -1;
                  for (let i = braceStart; i < jsonStr.length; i++) {
                    if (jsonStr[i] === '{') depth++;
                    if (jsonStr[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
                  }
                  if (end !== -1) parsed = JSON.parse(jsonStr.slice(braceStart, end + 1));
                }
              }

              if (!parsed) {
                results.push({ reviewer: reviewer.name, task: task.task_id || task.id, error: 'Could not parse LLM response' });
                continue;
              }

              // Normalize confidence (0-10 → 0-1)
              let confidence = parsed.reviewer_confidence ?? 0.7;
              if (confidence > 1) confidence = confidence / 10;
              confidence = Math.min(1, Math.max(0, confidence));

              const scores = parsed.scores || {};
              const avgScore = Object.values(scores).length > 0
                ? (Object.values(scores) as number[]).reduce((a: number, b: number) => a + b, 0) / Object.values(scores).length
                : 5;

              // Submit review via API
              const reviewPayload = {
                scores,
                weighted_overall: Math.min(10, Math.max(0, parsed.weighted_overall ?? Math.round(avgScore * 10) / 10)),
                reviewer_confidence: confidence,
                comment: (parsed.comment || 'No comment provided.').slice(0, 1500),
                suggestions: Array.isArray(parsed.suggestions) ? parsed.suggestions : [],
                approved: parsed.approved ?? avgScore >= 7,
              };

              const reviewRes = await app.inject({
                method: 'POST',
                url: `/v1/tasks/${task.task_id || task.id}/reviews`,
                headers: { 'content-type': 'application/json', 'x-agent-id': agentId },
                payload: JSON.stringify(reviewPayload),
              });

              const reviewBody = JSON.parse(reviewRes.body);
              if (reviewRes.statusCode >= 400) {
                results.push({ reviewer: reviewer.name, task: task.task_id || task.id, error: reviewBody.error?.message || reviewBody.error });
              } else {
                reviewed.push(task.task_id || task.id);
              }
            } catch (llmErr: any) {
              results.push({ reviewer: reviewer.name, task: task.task_id || task.id, error: `LLM call failed: ${llmErr.message}` });
            }
          }
        } catch (e: any) {
          results.push({ reviewer: reviewer.name, channel, error: `Feed error: ${e.message}` });
        }
      }

      if (reviewed.length > 0) {
        results.push({ reviewer: reviewer.name, reviewed });
      }
    }

    const elapsed = Date.now() - startTime;
    return res.status(200).json({
      status: 'ok',
      timestamp: new Date().toISOString(),
      duration_ms: elapsed,
      reviewers: fleetConfig.reviewers.map(r => r.name),
      results,
    });

  } catch (err: any) {
    console.error('Cron review error:', err);
    return res.status(500).json({
      status: 'error',
      message: err.message,
    });
  }
}