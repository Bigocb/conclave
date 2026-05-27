/**
 * Conclave — Organization routes
 */

import type { FastifyInstance, FastifyPluginCallback } from 'fastify';
import { CreateOrgSchema, UpdateOrgSchema } from '../schemas/index.js';
import { OrgService } from '../services/orgs.js';
import { ReputationService } from '../services/reputation.js';
import { success, error } from '../utils/response.js';
import { authenticate } from '../middleware/auth.js';
import { randomUUID } from 'crypto';
import { db } from '../db/index.js';
import { organizationMembers } from '../db/schema.js';

export const orgRoutes: FastifyPluginCallback = (fastify: FastifyInstance, _opts, done) => {
  const db = fastify.db;
  const orgSvc = new OrgService(db);
  const repSvc = new ReputationService(db);

  // GET /v1/orgs — list all organizations
  fastify.get('/orgs', async (_request, reply) => {
    const orgs = await orgSvc.list();
    reply.send(success({ organizations: orgs, total: orgs.length }));
  });

  // POST /v1/orgs
  fastify.post('/orgs', async (request, reply) => {
    const parsed = CreateOrgSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(422).send(error('VALIDATION_ERROR', 'Invalid input', parsed.error.flatten()));
    }
    const data = parsed.data;

    // Auto-generate slug from name if not provided
    if (!data.slug) {
      data.slug = data.name.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50) || 'org-' + randomUUID().slice(0, 8);
    }

    // Check for duplicate slug
    const existing = await orgSvc.getBySlug(data.slug);
    if (existing) {
      return reply.code(409).send(error('DUPLICATE_SLUG', `Organization with slug '${data.slug}' already exists`));
    }

    const id = `org_${randomUUID().replace(/-/g, '').slice(0, 24)}`;

    try {
      const userId = (request as any).user?.id || 'usr_system';
      const org = await orgSvc.create({
        id,
        ownerId: userId,
        name: data.name,
        slug: data.slug,
        description: data.description,
        policies: data.policies as Record<string, unknown> | undefined,
      });

      // Add creator as owner member
      if (userId !== 'usr_system') {
        const { organizationMembers } = await import('../db/schema.js');
        const { eq } = await import('drizzle-orm');
        // Check if already a member
        const existingMember = await db.query.organizationMembers.findFirst({
          where: (m: any) => eq(m.orgId, id) && eq(m.userId, userId),
        });
        if (!existingMember) {
          await db.insert(organizationMembers).values({
            orgId: id,
            userId,
            role: 'owner',
          });
        }
      }

      reply.code(201).send(success(org));
    } catch (err: any) {
      if (err.message?.includes('UNIQUE constraint')) {
        return reply.code(409).send(error('DUPLICATE_SLUG', `Organization with slug '${data.slug}' already exists`));
      }
      throw err;
    }
  });

  // GET /v1/orgs/:id
  fastify.get('/orgs/:id', async (request: any, reply) => {
    const { id } = request.params as { id: string };
    const org = await orgSvc.getById(id);
    if (!org) return reply.code(404).send(error('ORG_NOT_FOUND', 'Organization not found'));
    const agents = await orgSvc.getAgents(id);
    reply.send(success({ ...org, agents, agent_count: agents.length }));
  });

  // PUT /v1/orgs/:id
  fastify.put('/orgs/:id', async (request: any, reply) => {
    const { id } = request.params as { id: string };
    const parsed = UpdateOrgSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(422).send(error('VALIDATION_ERROR', 'Invalid input', parsed.error.flatten()));
    }
    const org = await orgSvc.update(id, parsed.data as any);
    if (!org) return reply.code(404).send(error('ORG_NOT_FOUND', 'Organization not found'));
    reply.send(success(org));
  });

  // GET /v1/orgs/:id/agents
  fastify.get('/orgs/:id/agents', async (request: any, reply) => {
    const { id } = request.params as { id: string };
    const agents = await orgSvc.getAgents(id);
    reply.send(success({ agents, total: agents.length }));
  });

  // GET /v1/orgs/:id/reputation
  fastify.get('/orgs/:id/reputation', async (request: any, reply) => {
    const { id } = request.params as { id: string };
    const org = await orgSvc.getById(id);
    if (!org) return reply.code(404).send(error('ORG_NOT_FOUND', 'Organization not found'));
    const agents = await orgSvc.getAgents(id);

    // Aggregate reputation from agents
    const agentReps = [];
    const principalIds = agents.map(a => a.principalId);
    const allReps = await repSvc.__bulkGetByPrincipals(principalIds);
    
    const repMap = new Map(allReps.map(r => [r.principal_id, r]));

    for (const agent of agents) {
      agentReps.push({ ...agent, reputation: repMap.get(agent.principalId) });
    }

    const orgReputation = {
      overall: agentReps.length > 0
        ? Math.round(agentReps.reduce((s, a) => s + (a.reputation?.performer?.overall ?? 0), 0) / agentReps.length * 10) / 10
        : null,
      agent_count: agents.length,
    };

    reply.send(success({ org_id: id, org_name: org.name, reputation: orgReputation, agents: agentReps }));
  });

  done();
};