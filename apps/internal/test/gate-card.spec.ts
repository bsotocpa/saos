// Audit item 5 (2026-09-09): one gate card explains a blocked state, with the reason and the
// single action that clears it. The packet card no longer says the same thing in other words.
// Static on purpose — there is no render harness.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const page = readFileSync(new URL('../app/clients/[id]/page.tsx', import.meta.url), 'utf8');

test('the blocked state is explained once, with the action that clears it', () => {
  assert.doesNotMatch(page, /Nothing is papered yet/, 'the packet card no longer explains the gate in its own words');
  const explanations = page.match(/What clears it:/g) ?? [];
  assert.equal(explanations.length, 1, 'exactly one gate explanation');
  assert.match(page, /send the engagement packet for signature/, 'and it names the one action');
});
