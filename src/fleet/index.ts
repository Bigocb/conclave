#!/usr/bin/env node
/**
 * Conclave Fleet — CLI
 *
 * Two modes:
 *   1. API-driven (default fleet): fetches config from Conclave server
 *   2. YAML-based: reads fleet.yaml locally (--config fleet.yaml)
 *
 * Usage:
 *   conclave fleet start [--config fleet.yaml]
 *   conclave fleet status [--config fleet.yaml]
 *   conclave fleet pending [--config fleet.yaml]
 *   conclave fleet approve <pending_id> [--config fleet.yaml]
 *   conclave fleet reject <pending_id> [--config fleet.yaml]
 *
 * Env vars:
 *   SERVER_URL    — Conclave API server URL (default: https://conclave-roan.vercel.app)
 *   FLEET_TOKEN   — Org token for API access
 *   FLEET_ORG_ID  — Org ID to load fleet config for (default: org_019e6027-...)
 */

import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import { parseFleetConfig, summarizeFleetConfig, BUILTIN_PROVIDERS } from './config.js';
import { FleetManager } from './manager.js';
import type { FleetConfig, ReviewerConfig } from './config.js';

// ─── Fetch config from API ──────────────────────────────────

async function fetchFleetConfigFromApi(serverUrl: string, orgId: string, token: string): Promise<FleetConfig> {
  console.log(`  Fetching fleet config from ${serverUrl}/v1/fleet/config...`);

  const configResp = await fetch(
    `${serverUrl}/v1/fleet/config?orgId=${encodeURIComponent(orgId)}`,
    {
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
    },
  );

  if (!configResp.ok) {
    const body = await configResp.text().catch(() => '');
    throw new Error(`Fleet config API returned ${configResp.status}: ${body.slice(0, 200)}`);
  }

  const configEnvelope: any = await configResp.json();
  const configData = configEnvelope?.data ?? configEnvelope;

  if (!configData?.orgId) {
    throw new Error(`Fleet config missing orgId — got: ${JSON.stringify(configData).slice(0, 200)}`);
  }

  // Fetch reviewer blueprints
  const revResp = await fetch(
    `${serverUrl}/v1/fleet/reviewers?orgId=${encodeURIComponent(orgId)}`,
    {
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
    },
  );

  if (!revResp.ok) {
    throw new Error(`Fleet reviewers API returned ${revResp.status}`);
  }

  const revEnvelope: any = await revResp.json();
  const revData = revEnvelope?.data?.reviewers ?? revEnvelope?.reviewers ?? revEnvelope ?? [];

  const reviewers: ReviewerConfig[] = (Array.isArray(revData) ? revData : []).map((r: any) => ({
    name: r.name || r.name,
    channels: typeof r.channels === 'string' ? JSON.parse(r.channels) : (r.channels || []),
    type: r.type || 'llm',
    model: r.model || '',
    provider: r.provider || '',
    llm_url: r.llmUrl || r.llm_url || '',
    llm_key: r.llmKey || r.llm_key || '',
    command: r.command || undefined,
    replicas: r.replicas || 1,
    mode: r.mode || 'auto',
    confidence_threshold: r.confidenceThreshold || r.confidence_threshold || 8,
    prompt: r.prompt || undefined,
    instructions: r.instructions || undefined,
    skills: typeof r.skills === 'string' ? JSON.parse(r.skills) : (r.skills || []),
    steps: typeof r.steps === 'string' ? JSON.parse(r.steps) : (r.steps || []),
    interval: r.interval || 30,
    max_concurrent: r.maxConcurrent || r.max_concurrent || 1,
  }));

  if (reviewers.length === 0) {
    console.warn('  ⚠ No reviewer blueprints found via API — fleet will idle');
  }

  let providers: Record<string, string> | undefined;
  if (configData.providers && typeof configData.providers === 'string') {
    try { providers = JSON.parse(configData.providers); } catch { /* ignore */ }
  } else if (configData.providers && typeof configData.providers === 'object') {
    providers = configData.providers;
  }

  // Resolve provider shortcuts to actual llm_url for each reviewer
  // (YAML path does this in parseFleetConfig, API path must do it here too)
  // Normalize variant provider names (e.g. 'ollama-cloud' -> 'ollama_cloud')
  const providerAliases: Record<string, string> = {
    'ollama-cloud': 'ollama_cloud',
  };
  const allProviders = { ...BUILTIN_PROVIDERS, ...(providers ?? {}) };
  for (const reviewer of reviewers) {
    // Normalize provider alias before lookup
    if (reviewer.provider && providerAliases[reviewer.provider]) {
      reviewer.provider = providerAliases[reviewer.provider];
    }
    if (!reviewer.llm_url && reviewer.provider) {
      const resolved = allProviders[reviewer.provider];
      if (resolved) {
        reviewer.llm_url = resolved;
        console.log(`  Resolved provider "${reviewer.provider}" → ${resolved} for reviewer "${reviewer.name}"`);
      } else {
        console.warn(`  ⚠ Reviewer "${reviewer.name}": unknown provider "${reviewer.provider}". Available: ${Object.keys(allProviders).join(', ')}`);
      }
    }
  }

  return {
    org_id: configData.orgId,
    server: configData.server || serverUrl,
    scope: configData.scope || 'public',
    token: token || configData.token || '',
    providers,
    reviewers,
    config_path: 'api',
  };
}

// ─── Args ───────────────────────────────────────────────────

function parseArgs(argv: string[]): Record<string, string> {
  const args: Record<string, string> = {};
  for (let i = 2; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      const key = argv[i].slice(2).replace(/-./g, s => s[1].toUpperCase());
      args[key] = argv[i + 1] ?? '';
      i++;
    } else if (!args.command) {
      args.command = argv[i];
    }
  }
  // First non-flag arg after node script is the subcommand
  const positional = argv.slice(2).filter(a => !a.startsWith('--'));
  if (!args.command && positional.length > 0) {
    args.command = positional[0];
  }
  if (positional.length > 1) args.arg = positional[1];
  return args;
}

// ─── Main ───────────────────────────────────────────────────

async function main() {
  const args = parseArgs(process.argv);
  const command = args.command ?? 'start';
  const configPath = args.config ?? args.configPath ?? '';

  // ─── Parse config ───────────────────────────────────────

  let config: FleetConfig;

  if (configPath && existsSync(resolve(configPath))) {
    // YAML mode
    try {
      config = parseFleetConfig(configPath);
    } catch (err: any) {
      console.error(`❌ Config error: ${err.message}`);
      process.exit(1);
    }
    console.log(`[DBG-fleet-mode] YAML mode (${configPath})`);
    for (const r of config.reviewers) {
      console.log(`[DBG-fleet-config] reviewer=${r.name} instructions=${JSON.stringify(r.instructions)} llm_url=${r.llm_url} model=${r.model}`);
    }
  } else {
    // API mode (default)
    const serverUrl = process.env.SERVER_URL || 'https://conclave-roan.vercel.app';
    const orgId = process.env.FLEET_ORG_ID || 'org_019e6027-580a-767a-8f13-cf40de5363a9';
    const token = process.env.FLEET_TOKEN || process.env.CONCLAVE_TOKEN || '';

    console.log('  Mode: API-driven fleet config\n');

    if (!orgId) {
      console.error('❌ FLEET_ORG_ID is required in API mode');
      console.error('   Set FLEET_ORG_ID env var or use --config fleet.yaml');
      process.exit(1);
    }

    try {
      config = await fetchFleetConfigFromApi(serverUrl, orgId, token);
      console.log(`[DBG-fleet-mode] API mode — fetched from ${serverUrl}`);
      for (const r of config.reviewers) {
        console.log(`[DBG-fleet-config] reviewer=${r.name} instructions=${JSON.stringify(r.instructions)} llm_url=${r.llm_url} model=${r.model}`);
      }
    } catch (err: any) {
      console.error(`❌ Failed to fetch fleet config from API: ${err.message}`);
      console.error('   Falling back to local fleet.yaml...');
      if (existsSync(resolve('fleet.yaml'))) {
        config = parseFleetConfig('fleet.yaml');
      } else if (existsSync(resolve('fleet.docker.yaml'))) {
        config = parseFleetConfig('fleet.docker.yaml');
      } else {
        process.exit(1);
      }
    }
  }

  // ─── Status ─────────────────────────────────────────────

  if (command === 'status') {
    console.log('╔══════════════════════════════════════════╗');
    console.log('║         CONCLAVE FLEET STATUS            ║');
    console.log('╚══════════════════════════════════════════╝\n');
    console.log(summarizeFleetConfig(config));
    process.exit(0);
  }

  // ─── Start ──────────────────────────────────────────────

  if (command === 'start') {
    const manager = new FleetManager(config);

    try {
      await manager.provision();
    } catch (err: any) {
      console.error(`❌ Provisioning failed: ${err.message}`);
      process.exit(1);
    }

    await manager.start();

    // Status dashboard refresh
    const statusInterval = setInterval(() => {
      const stats = manager.getStats();
      const now = new Date().toLocaleTimeString();
      process.stdout.write(`\r[${now}] ` +
        `Reviewers: ${stats.reviewers.filter(r => r.status === 'running').length}/${stats.reviewers.length} ` +
        `Active: ${stats.reviewers.reduce((s, r) => s + r.active_reviews, 0)} ` +
        `Completed: ${stats.reviewers.reduce((s, r) => s + r.total_reviews_completed, 0)} ` +
        `Pending: ${stats.pending_approvals} ` +
        `Uptime: ${stats.uptime_seconds}s`);
    }, 10000);

    // Graceful shutdown
    const shutdown = async () => {
      clearInterval(statusInterval);
      await manager.stop();
      process.exit(0);
    };

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);

    // Keep process alive
    return;
  }

  // ─── Pending ────────────────────────────────────────────

  if (command === 'pending') {
    console.log('╔══════════════════════════════════════════╗');
    console.log('║       PENDING HUMAN APPROVALS            ║');
    console.log('╚══════════════════════════════════════════╝\n');

    try {
      const resp = await fetch(`${config.server}/v1/fleet/pending`);
      if (resp.ok) {
        const data = await resp.json() as any;
        const pending: any[] = data?.data?.pending ?? [];
        if (pending.length === 0) {
          console.log('  No pending approvals.\n');
        } else {
          for (const p of pending) {
            console.log(`  📋 ${p.id}`);
            console.log(`     Reviewer:   ${p.reviewerName}`);
            console.log(`     Task:       ${p.taskId}`);
            console.log(`     Channel:    ${p.channel}`);
            console.log(`     Overall:    ${p.draft.weighted_overall}/10`);
            console.log(`     Confidence: ${p.draft.reviewer_confidence}/10`);
            console.log(`     Comment:    ${p.draft.comment.slice(0, 100)}...`);
            console.log('');
          }
        }
      } else {
        console.log('  No fleet running or endpoint not available.');
        console.log('  Start a fleet first: conclave fleet start\n');
      }
    } catch {
      console.log('  No fleet running. Start one first.');
      console.log('  Usage: conclave fleet start\n');
    }

    process.exit(0);
  }

  // ─── Approve ────────────────────────────────────────────

  if (command === 'approve') {
    const pendingId = args.arg ?? args.pendingId;
    if (!pendingId) {
      console.error('❌ Usage: conclave fleet approve <pending_id>');
      process.exit(1);
    }

    try {
      const resp = await fetch(`${config.server}/v1/fleet/approve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pending_id: pendingId }),
      });

      if (resp.ok) {
        console.log(`✅ Approved pending review: ${pendingId}`);
      } else {
        const err = await resp.json() as any;
        console.error(`❌ Approval failed: ${err.error?.message ?? resp.statusText}`);
      }
    } catch (err: any) {
      console.error(`❌ Could not reach fleet: ${err.message}`);
    }

    process.exit(0);
  }

  // ─── Reject ──────────────────────────────────────────────

  if (command === 'reject') {
    const pendingId = args.arg ?? args.pendingId;
    if (!pendingId) {
      console.error('❌ Usage: conclave fleet reject <pending_id>');
      process.exit(1);
    }

    try {
      const resp = await fetch(`${config.server}/v1/fleet/reject`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pending_id: pendingId }),
      });

      if (resp.ok) {
        console.log(`❌ Rejected pending review: ${pendingId}`);
      } else {
        const err = await resp.json() as any;
        console.error(`❌ Rejection failed: ${err.error?.message ?? resp.statusText}`);
      }
    } catch (err: any) {
      console.error(`❌ Could not reach fleet: ${err.message}`);
    }

    process.exit(0);
  }

  // ─── Unknown ─────────────────────────────────────────────

  console.error(`Unknown command: ${command}`);
  console.error('Usage: conclave fleet <start|status|pending|approve|reject> [--config fleet.yaml]');
  process.exit(1);
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
