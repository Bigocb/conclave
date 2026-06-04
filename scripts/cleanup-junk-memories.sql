-- Cleanup Junk Review Memories
-- Removes old-format memories produced by the previous keyword-grep extraction
-- approach (pre-Slice 2). These are noise now that MemoryExtractor stores
-- actionable conventions with proper context fields.
--
-- Deletes:
--   review:score:*       — raw score numbers with no context (e.g. "9")
--   review:topic:*       — keyword-grep comment fragments (e.g. review:topic:naming)
--   review:last:approved  — boolean flag that overwrites every time
--   review:suggestions:count — a count with no content
--
-- Safe to run multiple times (idempotent — rows already deleted won't
-- match on subsequent runs).

BEGIN;

DELETE FROM clv_principal_memory
WHERE key LIKE 'review:score:%'
   OR key LIKE 'review:topic:%'
   OR key = 'review:last:approved'
   OR key = 'review:suggestions:count';

COMMIT;