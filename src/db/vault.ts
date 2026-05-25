import { pgTable, text, timestamp } from 'drizzle-orm/pg-core';

// ─── BYOK Vault (Organization keys) ──────────────────────────────────────
// Stores sensitive API keys for LLM providers at the Org level.
// In a production environment, 'encryptedValue' would be encrypted using a 
// master key (KMS/Vault) before insertion.
export const orgVault = pgTable('clv_org_vault', {
  id: text('id').primaryKey(),               // vlt_<uuidv7>
  orgId: text('org_id').notNull(),          // references organizations.id
  provider: text('provider').notNull(),      // openai | anthropic | openrouter | etc.
  encryptedValue: text('encrypted_value').notNull(), 
  createdAt: timestamp('created_at').defaultNow(),
  updatedAt: timestamp('updated_at').defaultNow(),
}, (table) => ({
  // Providers must be unique per organization
  orgProviderIdx: { 
    unique: true, 
    columns: [table.orgId, table.provider] 
  },
}));
