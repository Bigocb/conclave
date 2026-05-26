import { FastifyInstance } from 'fastify';
import { authService } from '../services/auth.js';
import { db } from '../db/index.js';
import { users, organizations, organizationMembers, principals, agents } from '../db/schema.js';
import { eq } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';

export async function authRoutes(fastify: FastifyInstance) {
  // Public Route: Register
  fastify.post('/register', async (request: any, reply: any) => {
    const { email, password, fullName, orgName } = request.body as any;

    if (!email || !password) {
      return reply.status(400).send({ error: 'Email and password are required' });
    }

    const existingUser = await db.query.users.findFirst({
      where: eq(users.email, email),
    });

    if (existingUser) {
      return reply.status(409).send({ error: 'User already exists' });
    }

    const passwordHash = await authService.hashPassword(password);
    const userId = `usr_${uuidv7()}`;

    const { newUser, orgId } = await db.transaction(async (tx) => {
      const user = await tx.insert(users).values({
        id: userId,
        email,
        passwordHash,
        fullSName: fullName,
      }).returning().then(res => res[0]);

      const oId = `org_${uuidv7()}`;
      await tx.insert(organizations).values({
        id: oId,
        ownerId: userId,
        name: orgName || `${fullName || email}'s Organization`,
        slug: (orgName ? orgName.toLowerCase().replace(/\\s+/g, '-') : email.split('@')[0]) + '-' + uuidv7().slice(0, 4),
      });

      await tx.insert(organizationMembers).values({
        orgId: oId,
        userId: userId,
        role: 'owner',
      });

      // Auto-create a default principal for the user
      const principalId = `prn_${uuidv7()}`;
      await tx.insert(principals).values({
        id: principalId,
        orgId: oId,
        name: `${fullName || email}'s Principal`,
        roles: JSON.stringify(['general-reviewer']),
        capabilities: JSON.stringify([]),
        metadata: JSON.stringify({}),
        status: 'active',
      });

      // Auto-create a default agent so the user can submit tasks immediately
      const agentId = `agt_${uuidv7()}`;
      const agentToken = `clv_${uuidv7().replace(/-/g, '')}`;
      await tx.insert(agents).values({
        id: agentId,
        principalId,
        orgId: oId,
        name: `${fullName || email}'s Agent`,
        token: agentToken,
        model: 'gpt-4o',
        provider: 'openai',
        status: 'active',
      });

      return { newUser: user, orgId: oId };
    });

    const token = await authService.generateToken(userId, orgId);

    return reply.status(201).send({
      user: {
        id: newUser.id,
        email: newUser.email,
        fullName: newUser.fullSName,
      },
      orgId,
      token,
    });
  });

  // Public Route: Login
  fastify.post('/login', async (request: any, reply: any) => {
    const { email, password } = request.body as any;

    if (!email || !password) {
      return reply.status(400).send({ error: 'Email and password are required' });
    }

    const user = await db.query.users.findFirst({
      where: eq(users.email, email),
    });

    if (!user || !(await authService.verifyPassword(password, user.passwordHash || ''))) {
      return reply.status(401).send({ error: 'Invalid credentials' });
    }

    const { defaultOrgId } = (await authService.getUserWithDefaultOrg(user.id)) || { defaultOrgId: undefined };
    const token = await authService.generateToken(user.id, defaultOrgId);

    return reply.send({
      user: {
        id: user.id,
        email: user.email,
        fullName: user.fullSName,
      },
      orgId: defaultOrgId,
      token,
    });
  });

  // Google OAuth Implementation
  fastify.get('/auth/google', async (request: any, reply: any) => {
    const rootUrl = request.headers['host'] ? `http://${request.headers['host']}` : 'http://localhost:3000';
    const googleAuthUrl = `https://accounts.google.com/o/oauth2/v2/auth?client_id=${process.env.GOOGLE_CLIENT_ID}&redirect_uri=${rootUrl}/auth/google/callback&response_type=code&scope=openid%20email%20profile`;
    return reply.redirect(googleAuthUrl);
  });

  fastify.get('/auth/google/callback', async (request: any, reply: any) => {
    const { code } = request.query as any;
    if (!code) return reply.status(400).send({ error: 'No code provided' });

    try {
      // Exchange code for token
      const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        body: JSON.stringify({
          code,
          client_id: process.env.GOOGLE_CLIENT_ID,
          client_secret: process.env.GOOGLE_CLIENT_SECRET,
          redirect_uri: `${request.headers['host']} /auth/google/callback`, // simplified for example
          grant_type: 'authorization_code',
        }),
      });
      const { id_token, access_token } = await tokenResponse.json() as any;

      // Decode Google ID Token (simplified decoding for example)
      // In production, use google-auth-library to validate the token properly
      const payload = JSON.parse(Buffer.from(id_token.split('.')[1], 'base64').toString());
      const email = payload.email;
      const googleId = payload.sub;
      const fullName = payload.name;

      let user = await db.query.users.findFirst({
        where: eq(users.email, email),
      });

      if (!user) {
        const userId = `usr_${uuidv7()}`;
        user = await db.insert(users).values({
          id: userId,
          email,
          googleId,
          fullSName: fullName,
        }).returning().then(res => res[0]);

        const orgId = `org_${uuidv7()}`;
        await db.insert(organizations).values({
          id: orgId,
          ownerId: userId,
          name: `${fullName || email}'s Organization`,
          slug: email.split('@')[0] + '-' + uuidv7().slice(0, 4),
        });
        await db.insert(organizationMembers).values({
          orgId: orgId,
          userId: userId,
          role: 'owner',
        });
      }

      const { defaultOrgId } = (await authService.getUserWithDefaultOrg(user!.id)) || { defaultOrgId: undefined };
      const sessionToken = await authService.generateToken(user!.id, defaultOrgId);

      // Redirect back to frontend with token
      return reply.redirect(`/?token=${sessionToken}`);
    } catch (e) {
      return reply.status(500).send({ error: 'Google OAuth failed', details: e });
    }
  });
}
