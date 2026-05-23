#!/usr/bin/env node
/**
 * Conclave Fleet — CLI
 *
 * Usage:
 *   conclave fleet start --config fleet.yaml
 *   conclave fleet status [--config fleet.yaml]
 *   conclave fleet pending [--config fleet.yaml]
 *   conclave fleet approve <pending_id> [--config fleet.yaml]
 *   conclave fleet reject <pending_id> [--config fleet.yaml]
 */

import { readFileSync } from 'fs';
import { resolve } from 'path';
import { parseFleetConfig, summarizeFleetConfig } from './config.js';
import { FleetManager } from './manager.js';

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
  // Capture positional args after subcommand (like pending_id)
  if (positional.length > 1) args.arg = positional[1];
  return args;
}

// ─── Main ───────────────────────────────────────────────────

async function main() {
  const args = parseArgs(process.argv);
  const command = args.command ?? 'start';
  const configPath = args.config ?? args.configPath ?? 'fleet.yaml';

  // ─── Parse config ───────────────────────────────────────

  let config;
  try {
    config = parseFleetConfig(configPath);
  } catch (err: any) {
    console.error(`❌ Config error: ${err.message}`);
    process.exit(1);
  }

  // ─── Status ─────────────────────────────────────────────

  if (command === 'status') {
    console.log('╔══════════════════════════════════════════╗');
    console.log('║         CONCLAVE FLEET STATUS            ║');
    console.log('╚══════════════════════════════════════════╝\n');
    console.log(summarizeFleetConfig(config));

    // If there's a running fleet, we'd connect to it — for now show config summary
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
        `Uptime: ${stats.uptime_seconds}s`
      );
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
    // For pending/approve/reject, we need to connect to a running fleet.
    // In V1, the fleet manager runs in-process, so these commands
    // require a running fleet. We'll implement this as an API call
    // to the Conclave server's fleet status endpoint in the future.
    // For now, show how the MCP tools handle this.

    console.log('╔══════════════════════════════════════════╗');
    console.log('║       PENDING HUMAN APPROVALS            ║');
    console.log('╚══════════════════════════════════════════╝\n');

    // Try to read from the fleet status API
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
        console.log('  Start a fleet first: conclave fleet start --config fleet.yaml\n');
      }
    } catch {
      console.log('  No fleet running. Start one first.');
      console.log('  Usage: conclave fleet start --config fleet.yaml\n');
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