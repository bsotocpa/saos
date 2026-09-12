// Admin → Staff, three defects (Brian, 2026-09-12), static on purpose like meetings-card.spec:
// a role is chosen, never defaulted; the table shows the role name; the last active CEO is not
// offered Deactivate or a role change.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const page = readFileSync(new URL('../app/admin/staff/page.tsx', import.meta.url), 'utf8');

test('Add staff has no default role: the form starts empty, offers "Select a role", and cannot submit without one', () => {
  assert.doesNotMatch(page, /roleKey: '[a-z_]+'/, 'no role key is preselected anywhere');
  assert.match(page, /<option value="">Select a role<\/option>/);
  assert.match(page, /disabled=\{!form\.email \|\| !form\.legalName \|\| !form\.roleKey\}/);
});

test('the Role column shows the role name, and changing it is a separate control with a placeholder', () => {
  assert.match(page, /data-testid="role-name">\{roleName\(s\.role\)\}/);
  assert.match(page, /<option value="">Change role…<\/option>/);
});

test('the last active CEO gets neither Deactivate nor a role change', () => {
  assert.match(page, /const isLastActiveCeo = \(s: Staff\) => s\.role === 'ceo' && s\.is_active && activeCeos <= 1;/);
  assert.match(page, /\{isLastActiveCeo\(s\) \? null : \(\s*<button/);
  assert.match(page, /the only active CEO/);
});
