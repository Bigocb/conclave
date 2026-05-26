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

  private getSecret(): string {
    const secret = process.env.CONCLAVE_JWT_SECRET;
    if (!secret && process.env.NODE_ENV === 'production') {
      throw new Error('CRITICAL: CONCLAVE_JWT_SECRET is not defined in production environment');
    }
    return secret || 'conclave-dev-secret';
  }

  async generateToken(userId: string, orgId?: string): Promise<string> {
    const payload = {
      sub: userId,
      orgId: orgId,
      iat: Math.floor(Date.now() / 1000),
    };
    return jwt.sign(payload, this.getSecret(), { expiresIn: '7d' });
  }

  async verifyToken(token: string) {
    try {
      return jwt.verify(token, this.getSecret()) as { sub: string; orgId?: string };
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
