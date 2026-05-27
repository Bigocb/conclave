import { FastifyRequest, FastifyReply } from 'fastify';
import { authService } from '../services/auth.js';
import { db } from '../db/index.js';
import { agents } from '../db/schema.js';
import { eq } from 'drizzle-orm';

export async function authenticate(request: FastifyRequest, reply: FastifyReply) {
  let token: string | undefined;
  const authHeader = request.headers.authorization;

  if (authHeader && authHeader.startsWith('Bearer ')) {
    token = authHeader.slice(7);
  } else {
    // Fallback to query parameter for SSE/EventSource
    token = (request.query as any)?.token;
  }

  if (!token) {
    return reply.status(401).send({
      error: 'Unauthorized',
      message: 'Missing or invalid authentication token',
    });
  }

  // Support clv_ agent tokens (lookup in DB)
  if (token.startsWith('clv_')) {
    const agent = await db.query.agents.findFirst({
      where: eq(agents.token, token),
    });

    if (!agent) {
      return reply.status(401).send({
        error: 'Unauthorized',
        message: 'Invalid agent token',
      });
    }

    (request as any).agentId = agent.id;
    (request as any).principalId = agent.principalId;
    (request as any).orgId = agent.orgId;
    (request as any).user = { id: agent.principalId };

    return { sub: agent.principalId, orgId: agent.orgId };
  }

  // Standard JWT user token flow
  const decoded = await authService.verifyToken(token);

  if (!decoded) {
    return reply.status(401).send({
      error: 'Unauthorized',
      message: 'Session expired or invalid token',
    });
  }

  const { user, defaultOrgId } = (await authService.getUserWithDefaultOrg(decoded.sub)) || { user: null, defaultOrgId: undefined };

  if (!user) {
    return reply.status(401).send({
      error: 'Unauthorized',
      message: 'User no longer exists',
    });
  }

  // Attach identity context to the request for subsequent route handlers
  request.user = user;
  request.orgId = decoded.orgId || defaultOrgId;

  // Look up first agent for this user's principal so tasks can be submitted
  try {
    const principalId = (user as any)?.id ? await getDefaultPrincipalId(user.id, decoded.orgId || defaultOrgId) : null;
    if (principalId) {
      const agent = await db.query.agents.findFirst({
        where: eq(agents.principalId, principalId as any),
      });
      if (agent) {
        (request as any).agentId = agent.id;
        (request as any).principalId = agent.principalId;
      }
    }
  } catch (e) {
    // Non-fatal — some routes may not need agentId
  }

  return decoded;
}

async function getDefaultPrincipalId(userId: string, orgId: string): Promise<string | null> {
  const { principals } = await import('../db/schema.js');
  const { eq } = await import('drizzle-orm');
  const principal = await db.query.principals.findFirst({
    where: eq(principals.orgId, orgId as any),
  });
  return principal?.id || null;
}
