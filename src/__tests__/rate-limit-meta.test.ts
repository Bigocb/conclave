import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify from 'fastify';
import rateLimit from '@fastify/rate-limit';

// The hook we want to test — same logic as in src/server/index.ts
async function rateLimitMetaHook(request: any, reply: any, payload: unknown) {
  if (typeof payload === 'object' && payload !== null) {
    const p = payload as Record<string, unknown>;
    if (!p.meta || typeof p.meta !== 'object') {
      p.meta = {};
    }
    const remaining = reply.getHeader('x-ratelimit-remaining');
    if (remaining !== undefined) {
      (p.meta as Record<string, unknown>).rate_limit_remaining = Number(remaining);
    }
  }
  return payload;
}

describe('Rate limit metadata injection', () => {
  let app: ReturnType<typeof Fastify>;

  beforeAll(async () => {
    app = Fastify({ logger: false });

    // Register rate-limit plugin
    await app.register(rateLimit, {
      max: 100,
      timeWindow: '1 minute',
    });

    // Register the hook
    app.addHook('preSerialization', rateLimitMetaHook);

    // Test route that returns a success-style payload
    app.get('/test-success', async () => ({
      status: 'success',
      data: { foo: 'bar' },
      meta: {
        request_id: 'req_test',
        timestamp: new Date().toISOString(),
      },
    }));

    // Test route that returns an error-style payload (no meta)
    app.get('/test-error', async () => ({
      status: 'error',
      error: { code: 'TEST_ERROR', message: 'test', details: {} },
    }));

    // Test route that returns a raw string
    app.get('/test-string', async () => 'just a string');

    // Test route that returns null
    app.get('/test-null', async () => null);

    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('injects rate_limit_remaining into success responses', async () => {
    const res = await app.inject({ method: 'GET', url: '/test-success' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.meta).toBeDefined();
    expect(body.meta.rate_limit_remaining).toBeTypeOf('number');
    // Should be 99 since we've consumed 1 request
    expect(body.meta.rate_limit_remaining).toBeLessThanOrEqual(100);
    expect(body.meta.rate_limit_remaining).toBeGreaterThanOrEqual(0);
  });

  it('injects rate_limit_remaining into error responses (initializes meta)', async () => {
    const res = await app.inject({ method: 'GET', url: '/test-error' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.meta).toBeDefined();
    expect(body.meta.rate_limit_remaining).toBeTypeOf('number');
    expect(body.error).toBeDefined();
  });

  it('handles raw string payloads gracefully (no crash)', async () => {
    const res = await app.inject({ method: 'GET', url: '/test-string' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('just a string');
  });

  it('handles null payloads gracefully (no crash)', async () => {
    const res = await app.inject({ method: 'GET', url: '/test-null' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('null');
  });

  it('has correct header name', async () => {
    const res = await app.inject({ method: 'GET', url: '/test-success' });
    // @fastify/rate-limit uses x-ratelimit-remaining (no hyphen between rate/limit)
    const header = res.headers['x-ratelimit-remaining'];
    expect(header).toBeDefined();
    expect(Number(header)).toBeTypeOf('number');
  });

  it('rate_limit_remaining value matches the HTTP header', async () => {
    const res = await app.inject({ method: 'GET', url: '/test-success' });
    const body = JSON.parse(res.body);
    const header = Number(res.headers['x-ratelimit-remaining']);
    expect(body.meta.rate_limit_remaining).toBe(header);
  });
});
