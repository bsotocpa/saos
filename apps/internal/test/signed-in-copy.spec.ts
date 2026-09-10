// Audit item 9 (2026-09-09): the portal-access line beside the grant control says whether the
// client has ever signed in — a date, or "never signed in" — never silence. Static on purpose.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const page = readFileSync(new URL('../app/clients/[id]/page.tsx', import.meta.url), 'utf8');

test('an active portal says "last signed in <date>" or "never signed in", beside the grant control', () => {
  assert.match(page, /last signed in \{dayOf\(c\.portal_last_login_at\)\}/);
  assert.match(page, /never signed in — the link was delivered, but nobody has used it yet/);
  // Both branches hang off the same active-state check, on the Portal access line.
  const line = page.indexOf('never signed in');
  const grant = page.indexOf("const first = c.portal_state === 'not_invited'");
  assert.ok(line > 0 && grant > line && grant - line < 4000, 'the sentence sits with the grant/resend control');
});
