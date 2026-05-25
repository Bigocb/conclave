import 'fastify';

declare module 'fastify' {
  interface FastifyRequest {
    user?: {
      id: string;
      email: string;
    };
    orgId?: string;
    agentId?: string;
  }
  interface FastifyInstance {
    db: any;
    pgClient: any;
  }
}
