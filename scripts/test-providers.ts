
import { db } from './src/db/index.js';
import { providers, fleetReviewers } from './src/db/schema.js';
import { eq } from 'drizzle-orm';
import { VaultService } from './src/services/vault.js';

async function testProviderResolution() {
  console.log('🧪 Testing Provider Resolution Logic...\n');
  const vault = new VaultService(db);
  const orgId = 'org_dev';
  
  // 1. Setup: Ensure a provider and a reviewer exist
  await db.insert(providers).values({
    id: 'prov_test_custom',
    name: 'Test Provider',
    baseUrl: 'https://api.testprovider.com/v1',
    description: 'Test',
    isDefault: 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }).onConflictDoNothing();

  const reviewer = {
    id: 'rev_test',
    orgId: orgId,
    name: 'Test Reviewer',
    provider: 'test_custom', // This matches 'prov_test_custom' via the logic in the route
    llmUrl: null,
    llmKey: 'test_key_ref',
  };

  await vault.upsertKey(orgId, 'test_key_ref', 'decrypted-secret-123');

  console.log('--- Case 1: Resolve via Provider ID ---');
  let url = null;
  const prov = await db.query.providers.findFirst({
    where: eq(providers.id, `prov_${reviewer.provider}`)
  });
  if (prov) url = prov.baseUrl;
  console.log(`Expected: https://api.testprovider.com/v1, Actual: ${url}`);
  if (url !== 'https://api.testprovider.com/v1') throw new Error('Case 1 Failed');

  console.log('\n--- Case 2: Resolve via Vault Key ---');
  const key = await vault.getKey(orgId, reviewer.llmKey);
  console.log(`Expected: decrypted-secret-123, Actual: ${key}`);
  if (key !== 'decrypted-secret-123') throw new Error('Case 2 Failed');

  console.log('\n--- Case 3: Default Provider Fallback ---');
  const defProv = await db.query.providers.findFirst({
    where: eq(providers.isDefault, 1),
  });
  console.log(`Expected: https://www.ollama.com/v1, Actual: ${defProv?.baseUrl}`);
  if (defProv?.baseUrl !== 'https://www.ollama.com/v1') throw new Error('Case 3 Failed');

  console.log('\n✅ All provider resolution tests passed!');
}

testProviderResolution().catch(err => {
  console.error('❌ Test failed:', err);
  process.exit(1);
});
