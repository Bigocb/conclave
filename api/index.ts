/**
 * Conclave — Vercel Serverless Function Adapter
 * 
 * Bootstraps the Fastify app once (cached across cold starts),
 * then uses fastify.inject() to handle each request.
 * 
 * On first cold start, also runs drizzle-kit push to ensure
 * the database schema is up-to-date (since we can't do this
 * at build time when DATABASE_URL isn't available).
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { execSync } from 'node:child_process';

let app: any = null;
let initPromise: Promise<void> | null = null;

async function initApp() {
  if (app) return;
  if (initPromise) { await initPromise; return; }

  initPromise = (async () => {
    // Push schema to DB on first cold start
    // This ensures tables exist without needing a separate migration step
    if (process.env.DATABASE_URL) {
      try {
        console.log('Pushing database schema...');
        execSync('npx drizzle-kit push', {
          stdio: 'inherit',
          env: { ...process.env },
          timeout: 30000,
        });
        console.log('Schema push complete.');
      } catch (err) {
        console.error('Schema push failed (tables may already exist):', err);
        // Continue anyway — tables might already be up to date
      }
    }

    // Dynamic import of the compiled server
    const serverModule = await import('../dist/server/index.js');
    const config = {
      mode: (process.env.CONCLAVE_MODE || 'cloud') as 'local' | 'self-hosted' | 'cloud',
      port: 3000,
      host: '0.0.0.0',
      database: {
        url: process.env.DATABASE_URL!,
      },
      jwtSecret: process.env.CONCLAVE_JWT_SECRET || 'conclave-dev-secret-change-in-production',
    };

    const { fastify } = await serverModule.createServer(config);
    await fastify.ready();
    app = fastify;
  })();

  await initPromise;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  await initApp();

  const method = req.method || 'GET';
  const url = req.url || '/';
  const headers: Record<string, string> = {};
  for (const [key, val] of Object.entries(req.headers)) {
    if (typeof val === 'string') {
      headers[key] = val;
    } else if (Array.isArray(val)) {
      headers[key] = val.join(', ');
    }
  }

  let body: string | undefined;
  if (req.body) {
    body = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
    if (!headers['content-type']) {
      headers['content-type'] = 'application/json';
    }
  }

  const response = await app.inject({
    method: method as any,
    url,
    headers,
    payload: body || '',
  });

  res.status(response.statusCode);
  for (const [key, value] of Object.entries(response.headers)) {
    if (value !== undefined) {
      res.setHeader(key, String(value));
    }
  }
  res.send(response.body);
}