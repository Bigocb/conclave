import * as bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { db } from '../db/index.js';
import { users, organizationMembers } from '../db/schema.js';
import { eq } from 'drizzle-orm';

export class AuthService {
  // We now use the shared 'db' instance from ../db/index.js instead of constructor injection
  // to allow static-like access across the app.

  async hashPassword(password: string): Promise<string> {
    return bcrypt.hash(password, 10);
  }

  async verifyPassword(password: string, hash: string): Promise<boolean> {
    return bcrypt.compare(password, hash);
  }

  async generateToken(userId: string, orgId?: string): Promise<string> {
    const payload = {
      sub: userId,
      orgId: orgId,
      iat: Math.floor(Date.now() / 1000),
    };
    return jwt.sign(payload, process.env.CONCLAVE_JWT_SECRET || 'conclave-dev-secret', { expiresIn: '7d' });
  }

  async verifyToken(token: string) {
    try {
      return jwt.verify(token, process.env.CONCLAVE_JWT_SECRET || 'conclave-dev-secret') as { sub: string; orgId?: string };
    } catch (e) {
      return null;
    }
  }

  async getUserWithDefaultOrg(userId: string) {
    if (!db) throw new Error('Database not initialized');
    
    const user = await db.query.users.findFirst({
      where: eq(users.id, userId),
    });

    if (!user) return null;

    const membership = await db.query.organizationMembers.findFirst({
      where: eq(organizationMembers.userId, userId),
    });

    return {
      user,
      defaultOrgId: membership?.orgId,
    };
  }
}

// Export a singleton instance for the rest of the app to use
export const authService = new AuthService();
