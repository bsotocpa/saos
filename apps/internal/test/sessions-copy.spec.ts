// Audit item 7 (2026-09-09): a session's summary line says it was generated and should be read
// as such — it never names a model to a person who has no reason to know what that means.
// Static on purpose — there is no render harness.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const page = readFileSync(new URL('../app/clients/[id]/page.tsx', import.meta.url), 'utf8');

test('no "summarized by <model>"; the line says the summary was auto-generated', () => {
  assert.doesNotMatch(page, /summarized by \{/, 'a model name is not something a first-day reader needs');
  assert.match(page, /summary auto-generated — review before relying on it/);
});
