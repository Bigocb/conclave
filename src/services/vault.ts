import * as crypto from 'crypto';
import { db } from '../db/index.js';
import { orgVault } from '../db/vault.js';
import { eq } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';

const ENCRYPTION_KEY = process.env.VAULT_MASTER_KEY || 'dev-master-key-32-chars-long-!!!'; // Should be 32 bytes
const IV_LENGTH = 16;

export class VaultService {
  constructor(private dbInstance = db) {}

  /**
   * Encrypts a value using AES-256-CBC
   */
  encrypt(text: string): string {
    const iv = crypto.randomBytes(IV_LENGTH);
    const cipher = crypto.createCipheriv('aes-256-cbc', Buffer.from(ENCRYPTION_KEY), iv);
    let encrypted = cipher.update(text);
    encrypted = Buffer.concat([encrypted, cipher.final()]);
    return iv.toString('hex') + ':' + encrypted.toString('hex');
  }

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
  }

  /**
   * Stores a generic secret for a specific key
   */
  async storeSecret(key: string, value: string) {
    const encryptedValue = this.encrypt(value);
    const id = `sec_${uuidv7()}`;
    
    await this.dbInstance.insert(orgVault).values({
      id,
      orgId: 'system', // Use system org or find associated org
      provider: key,
      encryptedValue,
    });
    return id;
  }

  /**
   * Retrieves a decrypted secret
   */
  async getSecret(key: string): Promise<string | null> {
    const record = await this.dbInstance.query.orgVault.findFirst({
      where: (vault: any, { eq }: any) => eq(vault.provider, key),
    });
    if (!record) return null;
    return this.decrypt(record.encryptedValue);
  }

  /**
   * Upserts a provider key for an organization
   */
  async upsertKey(orgId: string, provider: string, key: string) {
    const encryptedValue = this.encrypt(key);
    
    const existing = await this.dbInstance.query.orgVault.findFirst({
      where: (vault: any, { and, eq }: any) => and(eq(vault.orgId, orgId), eq(vault.provider, provider)),
    });

    if (existing) {
      await this.dbInstance.update(orgVault)
        .set({ encryptedValue, updatedAt: new Date().toISOString() as any })
        .where(eq(orgVault.id, existing.id));
      return existing.id;
    }

    const id = `vlt_${uuidv7()}`;
    await this.dbInstance.insert(orgVault).values({
      id,
      orgId,
      provider,
      encryptedValue,
    });
    return id;
  }

  /**
   * Retrieves a decrypted key for a provider in an organization
   */
  async getKey(orgId: string, provider: string): Promise<string | null> {
    const record = await this.dbInstance.query.orgVault.findFirst({
      where: (vault: any, { and, eq }: any) => and(eq(vault.orgId, orgId), eq(vault.provider, provider)),
    });

    if (!record) return null;
    return this.decrypt(record.encryptedValue);
  }
}

export const vaultService = new VaultService();
