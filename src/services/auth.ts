import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { db } from '../db/index.js';
import { users, organizationMembers } from '../db/schema.js';
import { eq, and } from 'drizzle-orm';

const JWT_SECRET = process.env.CONCLAVE_JWT_SECRET || 'conclave-dev-secret-change-in-production';
const SALT_ROUNDS = 10;

export const AuthService = {
  async hashPassword(password: string): Promise<string> {
    return bcrypt.hash(password, SALT_ROUNDS);
  },

  async verifyPassword(password: string, hash: string): Promise<boolean> {
    return bcrypt.compare(password, hash);
  },

  async generateToken(userId: string, orgId?: string): Promise<string> {
    const payload = {
      sub: userId,
      orgId: orgId,
      iat: Math.floor(Date.now() / 1000),
    };
    return jwt.sign(payload, JWT_SECRET, { expiresIn: '7d' });
  },

  async verifyToken(token: string) {
    try {
      return jwt.verify(token, JWT_SECRET) as { sub: string; orgId?: string };
    } catch (e) {
      return null;
    }
  },

  async getUserWithDefaultOrg(userId: string) {
    const user = await db.query.users.findFirst({
      where: eq(users.id, userId),
    });

    if (!user) return null;

    // Get the first organization the user belongs to as the default
    const membership = await db.query.organizationMembers.findFirst({
      where: eq(organizationMembers.userId, userId),
    });

    return {
      user,
      defaultOrgId: membership?.orgId,
    };
  },
};
