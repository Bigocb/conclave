import { defineConfig } from 'vitest/config';
import { readFileSync } from 'fs';

// Manual .env loading (no dotenv dependency)
try {
  const envFile = readFileSync('.env', 'utf-8');
  for (const line of envFile.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const value = trimmed.slice(eqIdx + 1).trim();
    if (!process.env[key]) {
      process.env[key] = value;
    }
  }
} catch {}

export default defineConfig({
  test: {
    testTimeout: 60000,
    hookTimeout: 60000,
  },
});