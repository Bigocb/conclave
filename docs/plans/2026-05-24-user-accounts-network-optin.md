# Conclave — User Accounts & Network Opt-In: Implementation Plan

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** Add multi-tenant user accounts with authentication, per-user API key management, and an opt-in "Conclave Network" that lets isolated orgs participate in cross-org review if they choose.

**Architecture:** Users sign up (email+password or OAuth). Each user gets an org (or can create/join others). User-owned API keys are encrypted at rest and used by their org's agents for LLM calls. The Conclave Network is a global channel/matching layer — orgs opt in by subscribing to network channels, which routes their tasks to external reviewers (and vice versa). Isolation is the default; network participation is opt-in.

**Tech Stack:** Fastify + Drizzle (existing), bcrypt for passwords, JSON Web Tokens (already have @fastify/jwt), AES-256-GCM for encrypting LLM API keys at rest, Zod for validation (already in use).

---

## Design Decisions

| # | Decision | Choice | Rationale |
|---|----------|--------|-----------|
| 1 | Auth method | **Email+password with JWT sessions** | Simplest to start. Add OAuth (GitHub/Google) later. |
| 2 | Password storage | **bcrypt (12 rounds)** | Industry standard, built-in Node crypto. |
| 3 | API key encryption | **AES-256-GCM with server-side ENCRYPT_KEY** | Keys are stored encrypted, decrypted only at runtime when making LLM calls. ENCRYPT_KEY from env (or auto-generated on first boot). |
| 4 | User ↔ Org relationship | **User owns → creates → joins Orgs** | One user can own multiple orgs (personal org auto-created on signup). |
| 5 | Network opt-in | **Org-level setting + global `conclave-network` channel** | Orgs opt in by (1) toggling `network_enabled` on org, (2) subscribing their principals to network channels. Tasks in network channels are visible to external reviewers. |
| 6 | Identity model | **User → Org → Principals → Agents** (4 layers) | User is the auth boundary. Org is the isolation boundary. Principal is the reputation boundary. Agent is the compute boundary. |
| 7 | API key scope | **Org-level (shared across org's principals)** | LLM keys are expensive. Most users want one key per org, not per principal. Principals inherit from their org unless overridden. |
| 8 | Signup flow | **POST /v1/auth/register → email, password → 201 + JWT** | No email verification MVP. Add email verification later. Auto-creates personal org + `prn_<user>` principal. |
| 9 | Login flow | **POST /v1/auth/login → email, password → 200 + JWT** | JWT contains `{userId, orgId}`. Fresh token on each login. |
| 10 | Auth middleware change | **Local mode unchanged. Self-hosted/cloud: require JWT on all routes except /health and /v1/auth/** | Current "allow anonymous on auth failure" becomes strict. `agt_anon` access removed outside local mode. |

---

## Database Schema Changes

### New table: `users`

| Column | Type | Notes |
|--------|------|-------|
| `id` | text PK | `usr_<uuidv7>` |
| `email` | text UNIQUE NOT NULL | |
| `password_hash` | text NOT NULL | bcrypt hash |
| `display_name` | text | |
| `avatar_url` | text | |
| `role` | text NOT NULL DEFAULT 'user' | `user` \| `admin` |
| `email_verified` | boolean DEFAULT false | For future email verification |
| `last_login_at` | text | ISO timestamp |
| `created_at` | text NOT NULL | |
| `updated_at` | text NOT NULL | |

### New table: `api_keys` (encrypted LLM keys per org)

| Column | Type | Notes |
|--------|------|-------|
| `id` | text PK | `key_<uuidv7>` |
| `org_id` | text FK → organizations.id | |
| `provider` | text NOT NULL | `openai` \| `openrouter` \| `ollama` \| `ollama_cloud` \| `anthropic` \| `groq` \| `together` \| `fireworks` \| `custom` |
| `label` | text | Human-readable name: "My OpenAI key" |
| `encrypted_key` | text NOT NULL | AES-256-GCM encrypted API key |
| `iv` | text NOT NULL | Initialization vector for decryption |
| `is_default` | boolean DEFAULT false | Which key the org uses by default |
| `created_at` | text NOT NULL | |
| `updated_at` | text NOT NULL | |

### Modify existing table: `organizations`

Add columns:

| Column | Type | Notes |
|--------|------|-------|
| `owner_id` | text FK → users.id | User who created/owns the org |
| `network_enabled` | boolean DEFAULT false | Opt-in to Conclave Network |
| `network_scope` | text DEFAULT 'isolated' | `isolated` \| `reviewer` \| `full` |
| `plan` | text DEFAULT 'free' | `free` \| `pro` \| `enterprise` (future billing) |

### New table: `org_members` (multi-user org membership)

| Column | Type | Notes |
|--------|------|-------|
| `id` | text PK | `mb_<uuidv7>` |
| `user_id` | text FK → users.id | |
| `org_id` | text FK → organizations.id | |
| `role` | text NOT NULL DEFAULT 'member' | `owner` \| `admin` \| `member` |
| `invited_at` | text | |
| `accepted_at` | text | |
| `created_at` | text NOT NULL | |

### Network channels (no new table — use existing `channels` with `created_by_org IS NULL`)

Network channels are created by the system (no `created_by_org`). When an org enables `network_enabled`, its principals auto-subscribe to the `conclave-network` channel. The matching layer (a new service) routes tasks from network-enabled orgs to external reviewers.

---

## API Endpoints (New)

### Auth

| Method | Path | Description |
|--------|------|-------------|
| POST | `/v1/auth/register` | Create account (email, password, display_name). Returns user + JWT. Auto-creates personal org + default principal. |
| POST | `/v1/auth/login` | Email + password → JWT |
| POST | `/v1/auth/refresh` | Refresh JWT token |
| GET | `/v1/auth/me` | Get current user profile |
| PATCH | `/v1/auth/me` | Update display_name, avatar_url |

### API Keys

| Method | Path | Description |
|--------|------|-------------|
| GET | `/v1/orgs/:orgId/keys` | List org's API keys (masked: `sk-...4f2a`) |
| POST | `/v1/orgs/:orgId/keys` | Add API key (provider, raw key → encrypted) |
| DELETE | `/v1/orgs/:orgId/keys/:keyId` | Remove API key |
| PATCH | `/v1/orgs/:orgId/keys/:keyId` | Update label, set as default |

### Org Membership

| Method | Path | Description |
|--------|------|-------------|
| GET | `/v1/orgs/:orgId/members` | List org members |
| POST | `/v1/orgs/:orgId/members/invite` | Invite user by email |
| POST | `/v1/orgs/:orgId/members/accept` | Accept invitation |
| DELETE | `/v1/orgs/:orgId/members/:memberId` | Remove member |

### Network

| Method | Path | Description |
|--------|------|-------------|
| GET | `/v1/network/status` | Check if org is network-enabled |
| POST | `/v1/network/opt-in` | Enable network for org (sets `network_enabled=true`) |
| POST | `/v1/network/opt-out` | Disable network (sets `network_enabled=false`) |
| GET | `/v1/network/channels` | List available network channels |
| POST | `/v1/network/channels/:name/subscribe` | Subscribe org's principal to a network channel |

---

## Implementation Phases

### Phase 1: User Accounts & Auth (Core)
Tasks 1-8. Signup, login, JWT middleware, user model. Personal org auto-creation.

### Phase 2: API Key Management
Tasks 9-13. Encrypted storage, CRUD routes, key resolution in LLM calls.

### Phase 3: Org Membership & Network Opt-In
Tasks 14-18. Multi-user orgs, invite flow, network toggle, network channels.

### Phase 4: Dashboard Updates
Tasks 19-21. Login/signup UI, API key management UI, network opt-in UI.

---

## Task Breakdown

### Task 1: Add `users` table to schema

**Objective:** Create the users Drizzle table definition.

**Files:**
- Modify: `src/db/schema.ts`

**Step 1:** Add the `users` table after organizations, before principals:

```typescript
// ─── Users (authentication boundary) ─────────────────────────
export const users = pgTable('users', {
  id: text('id').primaryKey(),                        // usr_<uuidv7>
  email: text('email').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  displayName: text('display_name'),
  avatarUrl: text('avatar_url'),
  role: text('role').notNull().default('user'),       // user | admin
  emailVerified: integer('email_verified').notNull().default(0), // 0 or 1 (PG boolean via int)
  lastLoginAt: text('last_login_at'),
  createdAt: text('created_at').notNull().$defaultFn(() => new Date().toISOString()),
  updatedAt: text('updated_at').notNull().$defaultFn(() => new Date().toISOString()),
});
```

**Step 2:** Add columns to `organizations` table: `ownerId`, `networkEnabled`, `networkScope`, `plan`:

```typescript
// Add to organizations table:
ownerId: text('owner_id').references(() => users.id),
networkEnabled: integer('network_enabled').notNull().default(0), // 0=false, 1=true
networkScope: text('network_scope').notNull().default('isolated'), // isolated | reviewer | full
plan: text('plan').notNull().default('free'),                      // free | pro | enterprise
```

**Step 3:** Run `drizzle-kit push` to create the tables locally.

**Verify:** `curl localhost:3000/v1/health` still returns OK.

### Task 2: Add `api_keys` table to schema

**Objective:** Create the encrypted API key storage table.

**Files:**
- Modify: `src/db/schema.ts`

**Step 1:** Add after organizations (or after users):

```typescript
// ─── API Keys (encrypted LLM keys per org) ──────────────────────
export const apiKeys = pgTable('api_keys', {
  id: text('id').primaryKey(),                       // key_<uuidv7>
  orgId: text('org_id').notNull().references(() => organizations.id),
  provider: text('provider').notNull(),               // openai | openrouter | ollama | ollama_cloud | anthropic | groq | together | fireworks | custom
  label: text('label'),                               // "My OpenAI key"
  encryptedKey: text('encrypted_key').notNull(),       // AES-256-GCM ciphertext (base64)
  iv: text('iv').notNull(),                            // AES initialization vector (base64)
  isDefault: integer('is_default').notNull().default(0), // 0 or 1
  createdAt: text('created_at').notNull().$defaultFn(() => new Date().toISOString()),
  updatedAt: text('updated_at').notNull().$defaultFn(() => new Date().toISOString()),
});
```

**Step 2:** Add `org_members` table:

```typescript
// ─── Org Members (multi-user org membership) ────────────────────
export const orgMembers = pgTable('org_members', {
  id: text('id').primaryKey(),                       // mb_<uuidv7>
  userId: text('user_id').notNull().references(() => users.id),
  orgId: text('org_id').notNull().references(() => organizations.id),
  role: text('role').notNull().default('member'),    // owner | admin | member
  invitedAt: text('invited_at'),
  acceptedAt: text('accepted_at'),
  createdAt: text('created_at').notNull().$defaultFn(() => new Date().toISOString()),
});
```

**Step 3:** Run `drizzle-kit push`.

### Task 3: Auth service — register, login, password hashing

**Objective:** Create `src/services/auth.ts` with signup and login logic.

**Files:**
- Create: `src/services/auth.ts`
- Modify: `src/services/index.ts` (add export)

**Step 1:** Create `src/services/auth.ts`:

```typescript
import bcrypt from 'bcryptjs';
import { eq } from 'drizzle-orm';
import type { ConclaveDb } from '../db/index.js';
import { users, organizations, principals, agents, attentionBudgets } from '../db/schema.js';

const SALT_ROUNDS = 12;
const ID_PREFIX = { user: 'usr_', org: 'org_', principal: 'prn_', agent: 'agt_' };

function generateId(prefix: string): string {
  return prefix + crypto.randomUUID().replace(/-/g, '').slice(0, 24);
}

export class AuthService {
  constructor(private db: ConclaveDb) {}

  /** Register a new user. Auto-creates personal org + default principal + default agent. */
  async register(email: string, password: string, displayName?: string) {
    // Check if email exists
    const existing = await this.db.select().from(users).where(eq(users.email, email));
    if (existing.length > 0) {
      throw new Error('EMAIL_EXISTS');
    }

    // Hash password
    const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);

    // Create user
    const userId = generateId(ID_PREFIX.user);
    await this.db.insert(users).values({
      id: userId,
      email,
      passwordHash,
      displayName: displayName || email.split('@')[0],
    });

    // Auto-create personal org
    const orgId = generateId(ID_PREFIX.org);
    await this.db.insert(organizations).values({
      id: orgId,
      name: `${displayName || email.split('@')[0]}'s Org`,
      slug: `${userId.slice(4)}-org`,  // unique slug from user ID
      ownerId: userId,
    });

    // Auto-create default principal
    const principalId = generateId(ID_PREFIX.principal);
    await this.db.insert(principals).values({
      id: principalId,
      orgId,
      name: `${displayName || 'Default'} Principal`,
      roles: JSON.stringify(['general-reviewer']),
      capabilities: JSON.stringify(['review', 'submit']),
    });

    // Auto-create default agent
    const agentId = generateId(ID_PREFIX.agent);
    await this.db.insert(agents).values({
      id: agentId,
      principalId,
      orgId,
      name: 'Default Agent',
      type: 'llm',
      token: crypto.randomUUID(),
    });

    // Ensure budget
    await this.db.insert(attentionBudgets).values({
      principalId,
      earned: 15,
      spent: 0,
      earnRate: 5,
      lastEarnAt: new Date().toISOString(),
    });

    // Add user as org owner
    // (org_members table will be added in Phase 3)

    return { userId, email, orgId, principalId, agentId };
  }

  /** Login with email + password. Returns user info for JWT. */
  async login(email: string, password: string) {
    const result = await this.db.select().from(users).where(eq(users.email, email));
    if (result.length === 0) {
      throw new Error('INVALID_CREDENTIALS');
    }

    const user = result[0];
    const valid = await bcrypt.compare(password, user.passwordHash);
    if (!valid) {
      throw new Error('INVALID_CREDENTIALS');
    }

    // Update last login
    await this.db.update(users)
      .set({ lastLoginAt: new Date().toISOString() })
      .where(eq(users.id, user.id));

    return { userId: user.id, email: user.email, displayName: user.displayName, role: user.role };
  }

  /** Get user by ID */
  async getUser(userId: string) {
    const result = await this.db.select().from(users).where(eq(users.id, userId));
    return result[0] || null;
  }
}
```

**Step 2:** Install bcryptjs: `npm install bcryptjs && npm install -D @types/bcryptjs`

**Step 3:** Add export to `src/services/index.ts`

**Verify:** Auth service compiles without errors.

### Task 4: Auth routes — register, login, refresh, me

**Objective:** Create `src/routes/auth.ts` with Zod-validated auth endpoints.

**Files:**
- Create: `src/routes/auth.ts`
- Create: `src/schemas/auth.ts` (Zod schemas)
- Modify: `src/server/index.ts` (register auth routes)

**Key routes:**
- `POST /v1/auth/register` — `{email, password, displayName?}` → 201 + JWT
- `POST /v1/auth/login` — `{email, password}` → 200 + JWT
- `POST /v1/auth/refresh` — existing JWT → new JWT
- `GET /v1/auth/me` — JWT → user profile
- `PATCH /v1/auth/me` — JWT + `{displayName?, avatarUrl?}` → updated user

**Zod schemas** (`src/schemas/auth.ts`):
```typescript
import { z } from 'zod';

export const RegisterSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8).max(128),
  displayName: z.string().min(1).max(100).optional(),
});

export const LoginSchema = z.object({
  email: z.string().email(),
  password: z.string(),
});

export const UpdateProfileSchema = z.object({
  displayName: z.string().min(1).max(100).optional(),
  avatarUrl: z.string().url().optional(),
});
```

**JWT payload:** `{ userId, email, role }` — signed with CONCLAVE_JWT_SECRET.

**Auth middleware update:** In `server/index.ts`, change the preHandler hook:
- Local mode: unchanged (X-Agent-Id header)
- Self-hosted/cloud: Require valid JWT on all routes except `/health`, `/v1/health`, `/v1/auth/register`, `/v1/auth/login`
- Remove `agt_anon` fallback — unauthenticated requests in non-local mode should get 401

### Task 5: API key encryption utility

**Objective:** Create `src/services/crypto.ts` for AES-256-GCM encryption/decryption of API keys.

**Files:**
- Create: `src/services/crypto.ts`

```typescript
import crypto from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const KEY_LENGTH = 32; // 256 bits
const IV_LENGTH = 16;

function getEncryptKey(): Buffer {
  const key = process.env.ENCRYPT_KEY;
  if (!key) {
    throw new Error('ENCRYPT_KEY environment variable is required for API key encryption');
  }
  // Key must be 32 bytes. If hex-encoded, decode it. If base64, decode it. If raw string, hash it.
  if (key.length === 64) {
    // Hex-encoded 32-byte key
    return Buffer.from(key, 'hex');
  }
  if (key.length === 44) {
    // Base64-encoded 32-byte key
    return Buffer.from(key, 'base64');
  }
  // Raw string — derive key via SHA-256
  return crypto.createHash('sha256').update(key).digest();
}

export function encrypt(plaintext: string): { encrypted: string; iv: string } {
  const key = getEncryptKey();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  let encrypted = cipher.update(plaintext, 'utf8', 'base64');
  encrypted += cipher.final('base64');
  const authTag = cipher.getAuthTag().toString('base64');
  // Prepend auth tag to ciphertext
  return {
    encrypted: authTag + ':' + encrypted,
    iv: iv.toString('base64'),
  };
}

export function decrypt(encrypted: string, iv: string): string {
  const key = getEncryptKey();
  const ivBuf = Buffer.from(iv, 'base64');
  // Split auth tag from ciphertext
  const [authTagB64, ciphertext] = encrypted.split(':');
  const authTag = Buffer.from(authTagB64, 'base64');
  const decipher = crypto.createDecipheriv(ALGORITHM, key, ivBuf);
  decipher.setAuthTag(authTag);
  let decrypted = decipher.update(ciphertext, 'base64', 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
}

/** Generate a new ENCRYPT_KEY for .env */
export function generateEncryptKey(): string {
  return crypto.randomBytes(32).toString('base64');
}
```

### Task 6: API Key service — CRUD with encryption

**Objective:** Create `src/services/api-keys.ts` for managing encrypted LLM API keys.

**Files:**
- Create: `src/services/api-keys.ts`

**Key methods:**
- `create(orgId, provider, rawKey, label?, isDefault?)` — encrypt + store
- `list(orgId)` — return keys with masked values (`sk-...4f2a`)
- `getDecrypted(keyId)` — for LLM calls (internal only, never exposed via API)
- `delete(keyId)` — remove key
- `setDefault(orgId, keyId)` — mark as default
- `getDefaultKey(orgId, provider?)` — resolve which key to use for an LLM call

**Masking:** Last 4 chars of decrypted key visible, rest replaced with `••••••`. E.g., `sk-proj-abc1234f2a` → `•••••••••••••4f2a`.

### Task 7: API Key routes

**Objective:** Create `src/routes/keys.ts` with CRUD endpoints for API key management.

**Files:**
- Create: `src/routes/keys.ts`
- Create: `src/schemas/keys.ts` (Zod schemas)
- Modify: `src/server/index.ts` (register key routes)

**Endpoints:**
- `GET /v1/orgs/:orgId/keys` → list keys (masked)
- `POST /v1/orgs/:orgId/keys` → add key `{provider, key, label?, isDefault?}`
- `DELETE /v1/orgs/:orgId/keys/:keyId` → remove key
- `PATCH /v1/orgs/:orgId/keys/:keyId` → update label, set default

**Auth:** All key routes require JWT. User must be member of the org.

### Task 8: Wire API key resolution into fleet/reviewer

**Objective:** When a reviewer makes an LLM call, resolve the API key from the org's stored keys instead of requiring it in fleet.yaml.

**Files:**
- Modify: `src/fleet/manager.ts` or `src/fleet/backends.ts`

**Flow:**
1. Reviewer starts → checks fleet.yaml for `llm_key` (env var or literal)
2. If not found → query `api_keys` table for org's default key for that provider
3. Decrypt at runtime → use in Authorization header
4. If no key found → skip review with clear error message

This makes API key management optional in fleet.yaml but enables the dashboard to manage keys.

---

## Phase 3 Tasks (brief — design after Phase 1-2 ship)

### Task 9-13: Org membership, invitations, network opt-in toggle, network channel subscription, org settings API

### Task 14-18: Dashboard login/signup page, key management UI, network settings UI, org member management, profile page

---

## Auth Middleware Changes (Critical)

Current behavior (local mode):
```
if local → use X-Agent-Id header or default to agt_dev
if auth fails → fall back to agt_anon
```

New behavior:
```
if local → USE X-Agent-Id header or default to agt_dev (unchanged)
if self-hosted/cloud:
  if route is public (/health, /v1/auth/*) → allow
  else → require valid JWT
  JWT payload: {userId, email, role}
  look up user's default org + principal → set agentId, principalId
  no anon fallback
```

This means all non-local API calls need a valid JWT. The MCP server and fleet manager will need to handle auth tokens.

---

## Environment Variables (New)

| Variable | Required | Description |
|----------|----------|-------------|
| `ENCRYPT_KEY` | Yes (self-hosted/cloud) | 32-byte key for AES-256-GCM encryption of API keys. Generate with `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"` |
| `CONCLAVE_JWT_SECRET` | Yes (self-hosted/cloud) | JWT signing key (already exists, now always required in non-local mode) |

**ENCRYPT_KEY generation:** Add to `.env.example` and generate automatically on first `conclave init` or server startup if missing (env mode only, not in local mode where keys aren't encrypted).

---

## Open Questions

1. **Password reset flow** — MVP: no password reset. Add email-based reset in Phase 3.
2. **OAuth providers** — GitHub + Google OAuth for signup/login. Add after email+password works.
3. **Stripe/billing** — `plan` column is a placeholder. Add Stripe in Phase 4.
4. **Network matching algorithm** — How to route tasks to the best external reviewers? Reputation-weighted? Random? Channel-subscription-based? (Phase 3)
5. **Rate limiting per plan** — Free orgs get 100 reviews/month, Pro get unlimited, etc. (Phase 4)
6. **Key rotation** — Auto-rotate ENCRYPT_KEY? Or manual re-encrypt? (Start manual, add rotation endpoint later)