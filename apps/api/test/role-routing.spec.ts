/*
 * UNFILLED ROLES FAIL LOUDLY (2026-09-12, ruling reconciliation). Four alert sites and one
 * variable-role-key site skipped their alert silently when the role had no holder. Now the gap is
 * a recorded fact (staffing.role_unfilled, with the role and the site) and the alert reaches the
 * CEO. The static guard cannot see a role named as data, so this spec also asserts, from the
 * source, that the five sites no longer call the silent resolver. Synthetic data only.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/server.ts';
import { createTestConfig, makeStaff, type TestStaff } from './helpers.ts';
import type { Config } from '../src/config.ts';
import { alertRecipientForRole } from '../src/staffing.ts';

let app: FastifyInstance;
let config: Config;
let ceo: TestStaff;

before(async () => {
  config = await createTestConfig('rolerouting');
  app = buildServer(config);
  await app.ready();
  ceo = await makeStaff(app.db, config, { email: 'ceo-routing@example.test', name: 'Synthetic CEO', role: 'ceo', password: 'ceo-password-12345678' });
});
after(async () => { await app.close(); });

const unfilledRows = async () => (await app.db.query<{ details: { role: string; context: string; fell_back_to: string } }>(
  `SELECT details FROM audit_log WHERE action = 'staffing.role_unfilled' ORDER BY occurred_at`)).rows;

test('an unfilled role reaches the CEO and is recorded with the site that asked; a filled role is quiet', async () => {
  const before = (await unfilledRows()).length;
  const who = await alertRecipientForRole(app.db, 'comms_billing', 'portal_message');
  assert.equal(who, ceo.id, 'the alert falls back to the CEO');
  const rows = await unfilledRows();
  assert.equal(rows.length, before + 1, 'one audit row');
  assert.deepEqual(rows[rows.length - 1]!.details, { role: 'comms_billing', context: 'portal_message', fell_back_to: 'ceo' });

  const rene = await makeStaff(app.db, config, { email: 'rene-routing@example.test', name: 'Synthetic Rene', role: 'comms_billing', password: 'rene-password-12345678' });
  const now = await alertRecipientForRole(app.db, 'comms_billing', 'portal_message');
  assert.equal(now, rene.id, 'the holder, once there is one');
  assert.equal((await unfilledRows()).length, before + 1, 'nothing recorded when the role is filled');
});

test('a variable role key nobody holds is still loud: the role is named in the record', async () => {
  const before = (await unfilledRows()).length;
  const who = await alertRecipientForRole(app.db, 'advisory_manager', 'onboarding_flag:needs_cfo');
  assert.equal(who, ceo.id);
  const rows = await unfilledRows();
  assert.equal(rows[rows.length - 1]!.details.role, 'advisory_manager');
  assert.equal(rows.length, before + 1);
});

test('the five sites route through the loud resolver, not the silent one', () => {
  const sites: Array<[string, string]> = [
    ['../src/modules/documents/routes.ts', 'portal_file_message'],
    ['../src/modules/portal/routes.ts', 'portal_message'],
    ['../src/modules/portal-auth/service.ts', 'portal_access_blocked'],
    ['../src/modules/tasks/service.ts', 'ladder_day14_call'],
    ['../src/modules/forms/service.ts', 'onboarding_flag:'],
  ];
  for (const [file, context] of sites) {
    const src = readFileSync(new URL(file, import.meta.url), 'utf8');
    // The context is a string literal or a template literal, depending on the site.
    assert.match(src, new RegExp(`alertRecipientForRole\\([^)]*[\\x27\\x60]${context.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`), `${file} names its site`);
    assert.doesNotMatch(src, /firstActiveByRole\(app\.db, 'comms_billing'\)/, `${file} no longer asks the silent resolver for the billing role`);
    assert.doesNotMatch(src, /firstActiveByRole\(app\.db, flag\.routeToRole\)/, `${file} no longer asks the silent resolver with a variable key`);
  }
});
