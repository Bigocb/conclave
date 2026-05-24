#!/usr/bin/env node
/**
 * Conclave — Reviewer Daemon
 *
 * Standalone daemon that connects to a Conclave server, polls open tasks,
 * and submits LLM-generated reviews.
 *
 * Usage:
 *   npx tsx src/reviewer-daemon.ts
 *   SERVER_URL=https://conclave-roan.vercel.app npx tsx src/reviewer-daemon.ts
 *   npx tsx src/reviewer-daemon.ts --config fleet.yaml
 *
 * Reads fleet.yaml by default, or uses env vars:
 *   CONCLAVE_SERVER   — Server URL (default: http://localhost:3000)
 *   OLLAMA_KEY         — API key for Ollama Cloud
 *   OPENAI_KEY         — API key for OpenAI
 *   OPENROUTER_KEY     — API key for OpenRouter
 */

import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import { FleetManager } from './fleet/manager.js';
import { parseFleetConfig } from './fleet/config.js';

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

// ─── Main ───────────────────────────────────────────────────

async function main() {
  const args = parseArgs(process.argv);
  const configPath = args.config ?? 'fleet.yaml';

  console.log('╔══════════════════════════════════════════╗');
  console.log('║       CONCLAVE REVIEWER DAEMON           ║');
  console.log('╚══════════════════════════════════════════╝\n');

  // ─── Parse fleet config ──────────────────────────────────

  if (!existsSync(resolve(configPath))) {
    console.error(`❌ Config not found: ${configPath}`);
    console.error('   Create one with: conclave fleet init');
    console.error('   Or specify path:  --config path/to/fleet.yaml\n');
    process.exit(1);
  }

  let config;
  try {
    config = parseFleetConfig(configPath);
  } catch (err: any) {
    console.error(`❌ Config error: ${err.message}`);
    process.exit(1);
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