import { FastifyRequest, FastifyReply } from 'fastify';
import { authService } from '../services/auth.js';

export async function authenticate(request: FastifyRequest, reply: FastifyReply) {
  const authHeader = request.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return reply.status(401).send({
      error: 'Unauthorized',
      message: 'Missing or invalid authentication token',
    });
  }

  const token = authHeader.slice(7);
  const decoded = await authService.verifyToken(token);

  if (!decoded) {
    return reply.status(401).send({
      error: 'Unauthorized',
      message: 'Session expired or invalid token',
    });
  }

  const { user, defaultOrgId } = await authService.getUserWithDefaultOrg(decoded.sub);

  if (!user) {
    return reply.status(401).send({
      error: 'Unauthorized',
      message: 'User no longer exists',
    });
  }

  // Attach identity context to the request for subsequent route handlers
  request.user = user;
  request.orgId = decoded.orgId || defaultOrgId;

  return decoded;
}
