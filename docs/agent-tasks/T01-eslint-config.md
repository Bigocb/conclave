# T01 — Add the missing eslint flat config

**Mark:** AGENT
**Depends on:** nothing
**Estimated diff:** one new file, plus removing credential literals

## Files you may modify

- `eslint.config.js` (create)
- `scripts/sync_db.ts`
- `scripts/full_sync_db.ts`
- `scripts/migrate-fleet-to-db.ts`
- `scripts/check_tables.ts`
- `scripts/check_cols.ts`
- `scripts/schema_diagnostic.ts`
- `scripts/user_cols_diagnostic.ts`
- `scripts/col_diagnostic.ts`

## Context

`package.json` defines `"lint": "eslint src/"`, but no eslint configuration file
exists. eslint 9 requires a flat config (`eslint.config.js`) and exits with an error
without one, so the lint script has never run. CI (T02) needs this to exist first.

The same task removes hardcoded database credentials from `scripts/`. The password
must already have been rotated by hand — see the README. Removing the literals does
not rotate anything.

## Steps

1. Create `eslint.config.js` at the repo root with exactly this content:

   ```js
   import tseslint from '@typescript-eslint/eslint-plugin';
   import tsparser from '@typescript-eslint/parser';

   export default [
     {
       files: ['src/**/*.ts'],
       languageOptions: {
         parser: tsparser,
         parserOptions: { ecmaVersion: 2022, sourceType: 'module' },
       },
       plugins: { '@typescript-eslint': tseslint },
       rules: {
         'no-unused-vars': 'off',
         '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
         'no-undef': 'off',
       },
     },
   ];
   ```

2. In each of the eight `scripts/*.ts` files listed above, find the hardcoded
   PostgreSQL connection string (it contains `promptoria_db_user`) and replace the
   literal with `process.env.DATABASE_URL`. If the file assigns it to a constant,
   keep the constant name and change only the value. Add this line directly above
   the assignment:

   ```ts
   // Connection string comes from the environment — never commit credentials.
   ```

3. If any of those scripts would now have an undefined connection string at runtime,
   add a guard immediately after the assignment:

   ```ts
   if (!DATABASE_URL) throw new Error('DATABASE_URL is not set');
   ```

   Use whatever variable name the file already uses.

## Verify

```bash
npx eslint src/ --max-warnings 9999
```
Expected: exits 0. Warnings are acceptable; errors are not.

```bash
grep -rn "promptoria_db_user" scripts/ ; echo "exit=$?"
```
Expected: no matches, `exit=1`.

```bash
grep -rln "process.env.DATABASE_URL" scripts/ | wc -l
```
Expected: `8` or higher.

## Stop conditions

- If `npx eslint src/` reports **errors** (not warnings), do not silence them by
  adding rule overrides. Report the error list and stop.
- If any script contains a credential for something other than the database (an API
  key, a token), stop and report it — do not guess at a replacement.

## Commit

```
chore(lint): add eslint flat config and remove credential literals from scripts
```
