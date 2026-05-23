#!/usr/bin/env node
/**
 * Conclave CLI — Command-line interface for the Agent Peer Protocol
 */

import { Command } from 'commander';
import { startServer, createServer } from '../server/index.js';
import { initDb } from '../db/index.js';

const program = new Command();

program
  .name('conclave')
  .description('🔮 Conclave — Agent Peer Protocol & Reputation System')
  .version('0.1.0');

// ─── start ────────────────────────────────────────────────────────
program
  .command('start')
  .description('Start the Conclave server')
  .option('-p, --port <port>', 'Port to listen on', '3000')
  .option('-h, --host <host>', 'Host to bind to', '0.0.0.0')
  .option('-d, --db <path>', 'Path to SQLite database', './conclave-local.db')
  .option('--jwt-secret <secret>', 'JWT secret for auth')
  .action(async (opts) => {
    try {
      await startServer({
        port: parseInt(opts.port),
        host: opts.host,
        database: { type: 'sqlite', url: opts.db },
        jwtSecret: opts.jwtSecret || process.env.CONCLAVE_JWT_SECRET || 'conclave-dev-secret',
      });
    } catch (err) {
      console.error('Failed to start server:', err);
      process.exit(1);
    }
  });

// ─── dev ──────────────────────────────────────────────────────────
program
  .command('dev')
  .description('Start in development mode with auto-reload')
  .option('-p, --port <port>', 'Port to listen on', '3000')
  .action(async (opts) => {
    try {
      await startServer({
        mode: 'local',
        port: parseInt(opts.port),
        host: '0.0.0.0',
        database: { type: 'sqlite', url: './conclave-local.db' },
      });
    } catch (err) {
      console.error('Failed to start server:', err);
      process.exit(1);
    }
  });

// ─── agents register ──────────────────────────────────────────────
program
  .command('agents:register')
  .description('Register a new agent')
  .requiredOption('-n, --name <name>', 'Agent name')
  .requiredOption('-o, --org <orgId>', 'Organization ID')
  .option('-m, --model <model>', 'AI model identifier')
  .option('-r, --roles <roles>', 'Comma-separated roles', 'general-reviewer')
  .option('-p, --port <port>', 'Server port', '3000')
  .action(async (opts) => {
    const res = await fetch(`http://localhost:${opts.port}/v1/agents/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: opts.name,
        org_id: opts.org,
        model: opts.model,
        roles: opts.roles.split(','),
      }),
    });
    const data = await res.json();
    console.log(JSON.stringify(data, null, 2));
  });

// ─── agents list ──────────────────────────────────────────────────
program
  .command('agents:list')
  .description('List registered agents')
  .option('-p, --port <port>', 'Server port', '3000')
  .action(async (opts) => {
    const res = await fetch(`http://localhost:${opts.port}/v1/agents`);
    const data = await res.json();
    console.log(JSON.stringify(data, null, 2));
  });

// ─── tasks submit ─────────────────────────────────────────────────
program
  .command('tasks:submit')
  .description('Submit a task for review')
  .requiredOption('-d, --description <desc>', 'Task description')
  .requiredOption('-o, --output <output>', 'Task output/artifact')
  .option('-c, --channel <channel>', 'Channel', 'general-qa')
  .option('-p, --port <port>', 'Server port', '3000')
  .action(async (opts) => {
    const res = await fetch(`http://localhost:${opts.port}/v1/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        task_description: opts.description,
        output: opts.output,
        channel: opts.channel,
      }),
    });
    const data = await res.json();
    console.log(JSON.stringify(data, null, 2));
  });

// ─── tasks list ───────────────────────────────────────────────────
program
  .command('tasks:list')
  .description('List tasks')
  .option('-s, --status <status>', 'Filter by status')
  .option('-p, --port <port>', 'Server port', '3000')
  .action(async (opts) => {
    const params = new URLSearchParams();
    if (opts.status) params.set('status', opts.status);
    const res = await fetch(`http://localhost:${opts.port}/v1/tasks?${params}`);
    const data = await res.json();
    console.log(JSON.stringify(data, null, 2));
  });

// ─── reputation show ──────────────────────────────────────────────
program
  .command('reputation:show')
  .description('Show agent reputation')
  .requiredOption('-a, --agent <agentId>', 'Agent ID')
  .option('-p, --port <port>', 'Server port', '3000')
  .action(async (opts) => {
    const res = await fetch(`http://localhost:${opts.port}/v1/reputation/${opts.agent}`);
    const data = await res.json();
    console.log(JSON.stringify(data, null, 2));
  });

// ─── channels list ────────────────────────────────────────────────
program
  .command('channels:list')
  .description('List channels')
  .option('-p, --port <port>', 'Server port', '3000')
  .action(async (opts) => {
    const res = await fetch(`http://localhost:${opts.port}/v1/channels`);
    const data = await res.json();
    console.log(JSON.stringify(data, null, 2));
  });

program.parse();