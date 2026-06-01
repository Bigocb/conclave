import * as bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import crypto from 'node:crypto';
import { db } from '../db/index.js';
import { users, organizationMembers } from '../db/schema.js';
import { eq } from 'drizzle-orm';

// Known secrets to try during verification (for cross-deployment compatibility)
// When a token is signed by a different deployment (Vercel vs Render), we try
// all known secrets to verify it. New tokens are always signed with the primary secret.
const FALLBACK_SECRETS = [
  'conclave-dev-secret-change-in-production',
  'conclave-dev-secret',
  'conclave_jwt_secret_2024_secure',
];

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
      console.error('[AUTH_SECRET_ERROR] CONCLAVE_JWT_SECRET is missing in production!');
      throw new Error('CRITICAL: CONCLAVE_JWT_SECRET is not defined in production environment');
    }
    const finalSecret = secret || 'conclave-dev-secret-change-in-production';
    
    // Log a hash of the secret to verify consistency across serverless functions
    // We use a simple slice/hash to avoid leaking the full secret in logs while still detecting mismatches
    const secretHash = crypto.createHash('sha256').update(finalSecret).digest('hex').slice(0, 8);
    console.log(`[AUTH_SECRET_ID] Using secret hash: ${secretHash}`);
    
    return finalSecret;
  }

  // Get all secrets to try during verification (primary + fallbacks)
  private getVerificationSecrets(): string[] {
    const primary = this.getSecret();
    // Deduplicate: if primary matches a fallback, don't try it twice
    const all = [primary, ...FALLBACK_SECRETS.filter(s => s !== primary)];
    const seen: Record<string, boolean> = {};
    return all.filter(s => { if (seen[s]) return false; seen[s] = true; return true; });
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
    // Try the primary secret first, then fallback secrets for cross-deployment compatibility
    const secrets = this.getVerificationSecrets();
    for (const secret of secrets) {
      try {
        const decoded = jwt.verify(token, secret) as { sub: string; orgId?: string };
        if (secret !== this.getSecret()) {
          console.log(`[AUTH] Token verified with fallback secret (hash: ${crypto.createHash('sha256').update(secret).digest('hex').slice(0, 8)}). Consider re-authenticating.`);
        }
        return decoded;
      } catch {
        // Try next secret
        continue;
      }
    }
    return null;
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