/**
 * Conclave — API Key Routes
 * POST/GET/DELETE /v1/api-keys for managing API keys
 */
import { FastifyInstance } from 'fastify';
import { ApiKeyService } from '../services/api-keys.js';
import { CreateApiKeySchema } from '../schemas/index.js';
import { success, error } from '../utils/response.js';
import { requirePermission } from '../middleware/auth.js';

export async function apiKeyRoutes(fastify: FastifyInstance) {
  const service = new ApiKeyService(fastify.db);

  // POST /api-keys — Create a new API key (requires admin permission)
  fastify.post('/api-keys', {
    preHandler: [requirePermission('admin')],
  }, async (request, reply) => {
    const parse = CreateApiKeySchema.safeParse(request.body);
    if (!parse.success) {
      return reply.status(422).send(error('VALIDATION_ERROR', parse.error.issues.map(i => i.message).join(', ')));
    }

    const { name, permission } = parse.data;
    const currentOrgId = (request as any).orgId;

    if (!currentOrgId) {
      return reply.status(403).send(error('UNAUTHORIZED', 'No active organization context'));
    }

    const { id, plaintextKey } = await service.generateKey(currentOrgId, name, permission);

    // Fetch the created row to return full details
    const key = await service.getKey(id, currentOrgId);

    return reply.status(201).send(success({
      plaintext_key: plaintextKey,
      key: key ? {
        id: key.id,
        name: key.name,
        key_prefix: key.keyPrefix,
        permission: key.permission,
        created_at: key.createdAt,
        revoked_at: key.revokedAt,
      } : { id },
    }));
  });

  // GET /api-keys — List active API keys for the current org (requires write permission)
  fastify.get('/api-keys', {
    preHandler: [requirePermission('write')],
  }, async (request, reply) => {
    const currentOrgId = (request as any).orgId;

    if (!currentOrgId) {
      return reply.status(403).send(error('UNAUTHORIZED', 'No active organization context'));
    }

    const keys = await service.listKeys(currentOrgId);

    return reply.send(success({
      keys: keys.map(k => ({
        id: k.id,
        name: k.name,
        key_prefix: k.keyPrefix,
        permission: k.permission,
        created_at: k.createdAt,
        revoked_at: k.revokedAt,
      })),
    }));
  });

  // GET /api-keys/:id — Get a single API key by ID (requires write permission)
  fastify.get('/api-keys/:id', {
    preHandler: [requirePermission('write')],
  }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const currentOrgId = (request as any).orgId;

    if (!currentOrgId) {
      return reply.status(403).send(error('UNAUTHORIZED', 'No active organization context'));
    }

    const key = await service.getKey(id, currentOrgId);
    if (!key) {
      return reply.status(404).send(error('NOT_FOUND', 'API key not found'));
    }

    return reply.send(success({
      key: {
        id: key.id,
        name: key.name,
        key_prefix: key.keyPrefix,
        permission: key.permission,
        created_at: key.createdAt,
        revoked_at: key.revokedAt,
      },
    }));
  });

  // DELETE /api-keys/:id — Revoke an API key (requires admin permission)
  fastify.delete('/api-keys/:id', {
    preHandler: [requirePermission('admin')],
  }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const currentOrgId = (request as any).orgId;

    if (!currentOrgId) {
      return reply.status(403).send(error('UNAUTHORIZED', 'No active organization context'));
    }

    // Check it exists first
    const existing = await service.getKey(id, currentOrgId);
    if (!existing) {
      return reply.status(404).send(error('NOT_FOUND', 'API key not found'));
    }

    await service.revokeKey(id, currentOrgId);
    return reply.send(success({ revoked: true, id }));
  });
}