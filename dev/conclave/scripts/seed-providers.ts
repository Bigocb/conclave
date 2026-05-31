
import { db } from '../src/db/index.js';
import { providers } from '../src/db/schema.js';
import { eq } from 'drizzle-orm';

async function seedProviders() {
  console.log('🌱 Seeding providers...');

  const providerList = [
    { id: 'prov_openai', name: 'OpenAI', baseUrl: 'https://api.openai.com/v1', description: 'Official OpenAI API', isDefault: 0 },
    { id: 'prov_anthropic', name: 'Anthropic', baseUrl: 'https://api.anthropic.com/v1', description: 'Official Anthropic API', isDefault: 0 },
    { id: 'prov_together', name: 'Together AI', baseUrl: 'https://api.together.ai/v1', description: 'Together AI API', isDefault: 0 },
    { id: 'prov_groq', name: 'Groq', baseUrl: 'https://api.groq.com/openai/v1', description: 'Groq LPU Inference', isDefault: 0 },
    { id: 'prov_perplexity', name: 'Perplexity', baseUrl: 'https://api.perplexity.ai', description: 'Perplexity LLM', isDefault: 0 },
    { id: 'prov_ollama', name: 'Local Ollama', baseUrl: 'http://localhost:11434', description: 'Self-hosted Ollama', isDefault: 0 },
    { id: 'prov_ollama_cloud', name: 'Ollama Cloud', baseUrl: 'https://www.ollama.com/v1', description: 'Managed Ollama', isDefault: 1 },
    { id: 'prov_open_code_zen', name: 'Open Code Zen', baseUrl: 'https://api.opencode.ai/zen/v1', description: 'Open Code Zen LLM', isDefault: 0 },
    { id: 'prov_open_code_go', name: 'Open Code Go', baseUrl: 'https://api.opencode.ai/go/v1', description: 'Open Code Go LLM', isDefault: 0 },
  ];

  for (const p of providerList) {
    const existing = await db.select().from(providers).where(eq(providers.id, p.id)).limit(1);
    if (existing.length === 0) {
      await db.insert(providers).values({
        ...p,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
      console.log(`  ✅ Created ${p.name}`);
    } else {
      console.log(`  ⏭ ${p.name} already exists`);
    }
  }

  console.log('🚀 Providers seeded successfully!');
}

seedProviders().catch(console.error);
