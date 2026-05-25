import { FastifyInstance } from 'fastify';
import { AuthService } from '../services/auth.js';
import { db } from '../db/index.js';
import { users, organizations, organizationMembers } from '../db/schema.js';
import { eq } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuidv7';

export async function authRoutes(fastify: FastifyInstance) {
  // Public Route: Register
  fastify.post('/auth/register', async (request, reply) => {
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

    const passwordHash = await AuthService.hashPassword(password);
    const userId = `usr_${uuidv7()}`;

    const newUser = await db.insert(users).values({
      id: userId,
      email,
      passwordHash,
      fullSName: fullName,
    }).returning().then(res => res[0]);

    const orgId = `org_${uuidv7()}`;
    await db.insert(organizations).values({
      id: orgId,
      ownerId: userId,
      name: orgName || `${fullName || email}'s Organization`,
      slug: (orgName ? orgName.toLowerCase().replace(/\s+/g, '-') : email.split('@')[0]) + '-' + uuidv7().slice(0, 4),
    });

    await db.insert(organizationMembers).values({
      orgId: orgId,
      userId: userId,
      role: 'owner',
    });

    const token = await AuthService.generateToken(userId, orgId);

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
  fastify.post('/auth/login', async (request, reply) => {
    const { email, password } = request.body as any;

    if (!email || !password) {
      return reply.status(400).send({ error: 'Email and password are required' });
    }

    const user = await db.query.users.findFirst({
      where: eq(users.email, email),
    });

    if (!user || !(await AuthService.verifyPassword(password, user.passwordHash || ''))) {
      return reply.status(401).send({ error: 'Invalid credentials' });
    }

    const { defaultOrgId } = await AuthService.getUserWithDefaultOrg(user.id);
    const token = await AuthService.generateToken(user.id, defaultOrgId);

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
  fastify.get('/auth/google', async (request, reply) => {
    const rootUrl = request.headers['host'] ? `http://${request.headers['host']}` : 'http://localhost:3000';
    const googleAuthUrl = `https://accounts.google.com/o/oauth2/v2/auth?client_id=${process.env.GOOGLE_CLIENT_ID}&redirect_uri=${rootUrl}/auth/google/callback&response_type=code&scope=openid%20email%20profile`;
    return reply.redirect(googleAuthUrl);
  });

  fastify.get('/auth/google/callback', async (request, reply) => {
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

      const { defaultOrgId } = await AuthService.getUserWithDefaultOrg(user.id);
      const sessionToken = await AuthService.generateToken(user.id, defaultOrgId);

      // Redirect back to frontend with token
      return reply.redirect(`/?token=${sessionToken}`);
    } catch (e) {
      return reply.status(500).send({ error: 'Google OAuth failed', details: e });
    }
  });
}
