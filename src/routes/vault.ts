import { FastifyInstance } from 'fastify';
import { VaultService } from '../services/vault.js';
import { authenticate } from '../middleware/auth.js';

export async function vaultRoutes(fastify: FastifyInstance) {
  const vault = new VaultService(fastify.db);
  
  // All vault routes are protected
  fastify.addHook('preHandler', authenticate);

  fastify.post('/vault/key', async (request, reply) => {
    const { provider, key } = request.body as any;
    const orgId = (request as any).orgId;

    if (!provider || !key) {
      return reply.status(400).send({ error: 'Provider and key are required' });
    }

    if (!orgId) {
      return reply.status(403).send({ error: 'No active organization associated with this session' });
    }

    try {
      const vaultId = await vault.upsertKey(orgId, provider, key);
      return reply.send({ 
        message: 'Provider key updated successfully', 
        vaultId 
      });
    } catch (e) {
      return reply.status(500).send({ error: 'Failed to store key in vault' });
    }
  });

  fastify.get('/vault/keys', async (request, reply) => {
    const orgId = (request as any).orgId;
    if (!orgId) return reply.status(403).send({ error: 'No active organization context' });
    try {
      const keys = await vault.listKeys(orgId);
      return reply.send({ data: keys });
    } catch (e) {
      return reply.status(500).send({ error: 'Failed to retrieve keys' });
    }
  });

  fastify.get('/vault/key/:provider', async (request, reply) => {
    const { provider } = request.params as any;
    const orgId = (request as any).orgId;

    if (!orgId) {
      return reply.status(403).send({ error: 'No active organization associated with this session' });
    }

    const key = await vault.getKey(orgId, provider);
    if (!key) {
      return reply.status(404).send({ error: 'No key found for this provider in organization' });
    }

    return reply.send({ key });
  });
}