import * as crypto from 'crypto';
import { db } from '../db/index.js';
import { orgVault } from '../db/vault.js';
import { eq } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';

const ENCRYPTION_KEY = process.env.VAULT_MASTER_KEY || 'dev-master-key-32-chars-long-!!!'; // Should be 32 bytes
const IV_LENGTH = 16;

export const VaultService = {
  /**
   * Encrypts a value using AES-256-CBC
   */
  encrypt(text: string): string {
    const iv = crypto.randomBytes(IV_LENGTH);
    const cipher = crypto.createCipheriv('aes-256-cbc', Buffer.from(ENCRYPTION_KEY), iv);
    let encrypted = cipher.update(text);
    encrypted = Buffer.concat([encrypted, cipher.final()]);
    return iv.toString('hex') + ':' + encrypted.toString('hex');
  },

  /**
   * Decrypts a value encrypted by the encrypt method
   */
  decrypt(encryptedData: string): string {
    const [ivHex, encryptedHex] = encryptedData.split(':');
    const iv = Buffer.from(ivHex, 'hex');
    const encryptedText = Buffer.from(encryptedHex, 'hex');
    const decipher = crypto.createDecipheriv('aes-256-cbc', Buffer.from(ENCRYPTION_KEY), iv);
    let decrypted = decipher.update(encryptedText);
    decrypted = Buffer.concat([decrypted, decipher.final()]);
    return decrypted.toString();
  },

  /**
   * Upserts a provider key for an organization
   */
  async upsertKey(orgId: string, provider: string, key: string) {
    const encryptedValue = this.encrypt(key);
    
    const existing = await db.query.orgVault.findFirst({
      where: (vault: any, { and, eq }: any) => and(eq(vault.orgId, orgId), eq(vault.provider, provider)),
    });

    if (existing) {
      await db.update(orgVault)
        .set({ encryptedValue, updatedAt: new Date().toISOString() as any })\n        .where(eq(orgVault.id, existing.id));
      return existing.id;
    }

    const id = `vlt_${uuidv7()}`;
    await db.insert(orgVault).values({
      id,
      orgId,
      provider,
      encryptedValue,
    });
    return id;
  },

  /**
   * Retrieves a decrypted key for a provider in an organization
   */
  async getKey(orgId: string, provider: string): Promise<string | null> {
    const record = await db.query.orgVault.findFirst({
      where: (vault: any, { and, eq }: any) => and(eq(vault.orgId, orgId), eq(vault.provider, provider)),
    });

    if (!record) return null;
    return this.decrypt(record.encryptedValue);
  },
};
