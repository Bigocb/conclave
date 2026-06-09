#!/usr/bin/env node
/**
 * Conclave — Reviewer Daemon
 *
 * Standalone daemon that connects to a Conclave server, polls open tasks,
 * and submits LLM-generated reviews.
 *
 * Two modes:
 *   1. API-driven (default): fetches fleet config from the Conclave server API
 *   2. YAML-based (fallback): reads fleet.yaml locally (--config fleet.yaml)
 *
 * Usage:
 *   npx tsx src/reviewer-daemon.ts
 *   SERVER_URL=https://conclave-bp4o.onrender.com FLEET_TOKEN=... npx tsx src/reviewer-daemon.ts
 *   npx tsx src/reviewer-daemon.ts --config fleet.yaml
 *
 * Env vars:
 *   SERVER_URL    — Conclave API server URL (default: https://conclave-bp4o.onrender.com)
 *   FLEET_TOKEN   — Org token for API access
 *   FLEET_ORG_ID  — Org ID to load fleet config for
 */

import { existsSync } from 'fs';
import { resolve } from 'path';
import { FleetManager } from './fleet/manager.js';
import { parseFleetConfig } from './fleet/config.js';
import type { FleetConfig, ReviewerConfig } from './fleet/config.js';

// ─── Args ───────────────────────────────────────────────────

function parseArgs(argv: string[]): Record<string, string> {
  const args: Record<string, string> = {};
  for (let i = 2; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      const key = argv[i].slice(2).replace(/-./g, s => s[1].toUpperCase());
      args[key] = argv[i + 1] ?? '';
      i++;
    }
  }
  return args;
}

// ─── Graceful shutdown ──────────────────────────────────────

let manager: FleetManager | null = null;

async function shutdown(signal: string) {
  console.log(`\n${signal} received, shutting down...`);
  if (manager) {
    await manager.stop();
  }
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

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
    command: r.command,
    replicas: r.replicas || 1,
    mode: r.mode || 'auto',
    confidence_threshold: r.confidenceThreshold || r.confidence_threshold || 8,
    prompt: r.prompt,
    instructions: r.instructions,
    skills: typeof r.skills === 'string' ? JSON.parse(r.skills) : (r.skills || []),
    steps: typeof r.steps === 'string' ? JSON.parse(r.steps) : (r.steps || []),
    interval: r.interval || 30,
    max_concurrent: r.maxConcurrent || r.max_concurrent || 1,
  }));

  if (reviewers.length === 0) {
    console.warn('  ⚠ No reviewer blueprints found via API — fleet will idle');
  }

  // Parse providers from config
  let providers: Record<string, string> | undefined;
  if (configData.providers && typeof configData.providers === 'string') {
    try {
      providers = JSON.parse(configData.providers);
    } catch { /* ignore */ }
  } else if (configData.providers && typeof configData.providers === 'object') {
    providers = configData.providers;
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

// ─── Main ───────────────────────────────────────────────────

async function main() {
  const args = parseArgs(process.argv);
  const configPath = args.config ?? '';

  console.log('╔══════════════════════════════════════════╗');
  console.log('║       CONCLAVE REVIEWER DAEMON           ║');
  console.log('╚══════════════════════════════════════════╝\n');

  let config: FleetConfig;

  if (configPath && existsSync(resolve(configPath))) {
    // ─── YAML mode (explicit --config) ───────────────────
    console.log('  Mode: YAML config file\n');
    try {
      config = parseFleetConfig(configPath);
    } catch (err: any) {
      console.error(`❌ Config error: ${err.message}`);
      process.exit(1);
    }
  } else {
    // ─── API mode (default) ─────────────────────────────
    console.log('  Mode: API-driven config\n');

    const serverUrl = process.env.SERVER_URL || 'https://conclave-bp4o.onrender.com';
    const orgId = process.env.FLEET_ORG_ID || 'org_019e6027-580a-767a-8f13-cf40de5363a9';
    const token = process.env.FLEET_TOKEN || process.env.CONCLAVE_TOKEN || '';

    if (!orgId) {
      console.error('❌ FLEET_ORG_ID is required in API mode');
      console.error('   Set FLEET_ORG_ID env var or use --config fleet.yaml');
      process.exit(1);
    }

    try {
      config = await fetchFleetConfigFromApi(serverUrl, orgId, token);
    } catch (err: any) {
      console.error(`❌ Failed to fetch fleet config from API: ${err.message}`);
      console.error('   Falling back to local fleet.yaml if available...');

      if (existsSync(resolve('fleet.yaml'))) {
        config = parseFleetConfig('fleet.yaml');
      } else if (existsSync(resolve('fleet.docker.yaml'))) {
        config = parseFleetConfig('fleet.docker.yaml');
      } else {
        process.exit(1);
      }
    }
  }

  console.log(`  Server:  ${config.server}`);
  console.log(`  Org:     ${config.org_id}`);
  console.log(`  Scope:   ${config.scope}`);
  console.log(`  Reviewers: ${config.reviewers.length}`);
  for (const r of config.reviewers) {
    const modeIcon = r.mode === 'auto' ? '🤖' : r.mode === 'human' ? '👤' : '🔀';
    console.log(`    ${modeIcon} ${r.name} (${r.type || 'llm'}) → channels: ${r.channels.join(', ')}`);
  }
  console.log('');

  // ─── Check server connectivity ───────────────────────────

  console.log('🔍 Checking server connectivity...');
  try {
    const healthResp = await fetch(`${config.server}/v1/health`);
    if (!healthResp.ok) throw new Error(`Health check returned ${healthResp.status}`);
    const health: any = await healthResp.json();
    console.log(`  ✅ Server is live: ${health.status || 'ok'}\n`);
  } catch (err: any) {
    console.error(`  ❌ Cannot reach server at ${config.server}: ${err.message}`);
    console.error('     Make sure the server is running and accessible.\n');
    process.exit(1);
  }

  // ─── Provision and start ─────────────────────────────────

  manager = new FleetManager(config);

  try {
    console.log('🔧 Provisioning fleet...\n');
    await manager.provision();
  } catch (err: any) {
    console.error(`❌ Provisioning failed: ${err.message}`);
    process.exit(1);
  }

  console.log('');
  await manager.start();

  // ─── Status refresh ──────────────────────────────────────

  const statusInterval = setInterval(() => {
    if (!manager) return;
    const stats = manager.getStats();
    const now = new Date().toLocaleTimeString();
    const active = stats.reviewers.reduce((s, r) => s + r.active_reviews, 0);
    const completed = stats.reviewers.reduce((s, r) => s + r.total_reviews_completed, 0);
    process.stdout.write(`\r[${now}] ` +
      `Reviewers: ${stats.reviewers.filter(r => r.status === 'running').length}/${stats.reviewers.length} ` +
      `Active: ${active} ` +
      `Completed: ${completed} ` +
      `Pending: ${stats.pending_approvals} ` +
      `Uptime: ${Math.floor(stats.uptime_seconds / 60)}m`);
  }, 15_000);

  // Keep process alive
  await new Promise(() => {}); // Never resolves — runs until SIGINT/SIGTERM

  // Cleanup (unreachable but makes TS happy)
  clearInterval(statusInterval);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
