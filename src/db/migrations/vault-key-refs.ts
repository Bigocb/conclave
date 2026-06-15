import crypto from 'crypto';

/**
 * Fix vault key references for fleet reviewers.
 *
 * Before this migration:
 * - Fleet reviewer `llm_key` fields contained raw API keys (e.g. "a25be7302c...")
 *   or mismatched vault references (e.g. "org_ollama_cloud_upd...", "org_Ollama 2")
 * - Vault had entries under wrong provider names ("Ollama 2", "ollama_cloud_update")
 *
 * After this migration:
 * - All ollama_cloud reviewers reference `org_ollama_cloud`
 * - All custom reviewers reference `org_custom`
 * - Vault entries are consolidated under canonical provider names
 */
export async function migrateVaultKeyReferences(dbClient: any) {
  console.log('[Migration] Fixing vault key references for fleet reviewers...');

  try {
    await dbClient.begin(async (sql: any) => {
      // 1. Fix fleet reviewer llm_key fields
      // Replace raw ollama_cloud keys with org_ollama_cloud vault reference
      const orgId = 'org_019e6027-580a-767a-8f13-cf40de5363a9';

      // Update all reviewers with ollama_cloud provider to use org_ollama_cloud
      await sql`UPDATE clv_fleet_reviewers
        SET llm_key = 'org_ollama_cloud'
        WHERE org_id = ${orgId}
          AND provider = 'ollama_cloud'
          AND (llm_key IS NULL OR llm_key NOT LIKE 'org_%')`;

      // Update reviewers with 'custom' provider that have ollama_cloud-style keys
      await sql`UPDATE clv_fleet_reviewers
        SET llm_key = 'org_custom'
        WHERE org_id = ${orgId}
          AND provider = 'custom'
          AND llm_key IS NOT NULL
          AND llm_key NOT LIKE 'org_%'`;

      // Fix broken vault references
      await sql`UPDATE clv_fleet_reviewers
        SET llm_key = 'org_ollama_cloud'
        WHERE org_id = ${orgId}
          AND llm_key IN ('org_ollama_cloud_update', 'org_Ollama 2', 'org_ollama_cloud_upd')`;

      // Fix null llm_key for ollama_cloud reviewers
      await sql`UPDATE clv_fleet_reviewers
        SET llm_key = 'org_ollama_cloud'
        WHERE org_id = ${orgId}
          AND provider = 'ollama_cloud'
          AND llm_key IS NULL`;

      // 2. Consolidate vault entries
      // Ensure "ollama_cloud" has the correct key (use the most recently updated entry)
      // Delete old wrong-name entries after copying

      // First, find the most recent ollama-related vault entry
      const recentVault = await sql`
        SELECT provider, encrypted_value, updated_at
        FROM clv_org_vault
        WHERE org_id = ${orgId}
          AND provider IN ('ollama_cloud', 'Ollama 2', 'ollama_cloud_update', 'Ollama 2_unknown')
        ORDER BY updated_at DESC
        LIMIT 1`;

      if (recentVault.length > 0) {
        const latestKey = recentVault[0];

        // Upsert the correct canonical entry
        const vaultId = 'vlt_' + crypto.randomUUID();
        await sql`
          INSERT INTO clv_org_vault (id, org_id, provider, encrypted_value, created_at, updated_at)
          VALUES (${vaultId}, ${orgId}, 'ollama_cloud', ${latestKey.encrypted_value}, NOW(), NOW())
          ON CONFLICT (org_id, provider) DO UPDATE
          SET encrypted_value = ${latestKey.encrypted_value}, updated_at = NOW()`;

        // Delete the wrongly-named entries
        await sql`
          DELETE FROM clv_org_vault
          WHERE org_id = ${orgId}
            AND provider IN ('Ollama 2', 'ollama_cloud_update', 'Ollama 2_unknown')`;
      }

      // Handle 'custom' provider vault entry (if any reviewers use it)
      const customVaultEntries = await sql`
        SELECT provider, encrypted_value, updated_at
        FROM clv_org_vault
        WHERE org_id = ${orgId}
          AND provider LIKE '%custom%'
        ORDER BY updated_at DESC
        LIMIT 1`;

      // If there's no 'custom' entry but there are ollama ones, we don't create one
      // (custom reviewers that used the same key should use org_ollama_cloud)
    });

    console.log('[Migration] ✅ Vault key references fixed successfully');
  } catch (err: any) {
    console.error('[Migration] ❌ Vault key reference migration failed:', err.message);
    throw err;
  }
}