/**
 * Conclave — OpenAPI Spec Integration Tests
 * Tests that GET /v1/openapi.json returns a valid auto-generated spec
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify from 'fastify';
import swagger from '@fastify/swagger';

describe('OpenAPI Spec /v1/openapi.json', () => {
  let app: ReturnType<typeof Fastify>;

  beforeAll(async () => {
    app = Fastify();

    // Register @fastify/swagger with the same config as production
    await app.register(swagger, {
      openapi: {
        info: {
          title: 'Conclave API',
          description: 'Peer review and reputation protocol for autonomous agents',
          version: '1.0.0',
        },
        servers: [{ url: '/v1', description: 'Main API server' }],
        components: {
          securitySchemes: {
            BearerAuth: {
              type: 'http',
              scheme: 'bearer',
              bearerFormat: 'JWT',
              description: 'Bearer tokens: clv_ agent tokens or clv_api_ API keys',
            },
          },
        },
      },
    });

    // A simple route so the spec has content
    app.get('/v1/health', {
      schema: {
        response: {
          200: {
            type: 'object',
            properties: {
              status: { type: 'string' },
            },
          },
        },
      },
    }, async () => ({ status: 'ok' }));

    // Expose the OpenAPI spec at /v1/openapi.json
    app.get('/v1/openapi.json', async (_request: any, _reply: any) => {
      return app.swagger();
    });

    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('GET /v1/openapi.json returns 200', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/openapi.json',
    });

    expect(res.statusCode).toBe(200);
  });

  it('response is valid OpenAPI spec with required fields', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/openapi.json',
    });

    const body = JSON.parse(res.body);
    expect(body.openapi).toBeDefined();
    expect(body.openapi.startsWith('3')).toBe(true); // 3.0.3 or 3.1.x
    expect(body.info).toBeDefined();
    expect(body.info.title).toBe('Conclave API');
    expect(body.info.version).toBe('1.0.0');
  });

  it('contains paths from registered routes', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/openapi.json',
    });

    const body = JSON.parse(res.body);
    expect(body.paths).toBeDefined();
    const pathKeys = Object.keys(body.paths);
    expect(pathKeys.length).toBeGreaterThan(0);
    // Note: swagger normalizes paths — the key is the internal Fastify path
    expect(pathKeys).toContain('/health');
    expect(pathKeys).toContain('/openapi.json');
  });

  it('contains BearerAuth security scheme', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/openapi.json',
    });

    const body = JSON.parse(res.body);
    expect(body.components?.securitySchemes?.BearerAuth).toBeDefined();
    expect(body.components.securitySchemes.BearerAuth.type).toBe('http');
    expect(body.components.securitySchemes.BearerAuth.scheme).toBe('bearer');
  });
});