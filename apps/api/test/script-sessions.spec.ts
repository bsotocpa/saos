/*
 * A RULING APPLIED BY SCRIPT NAMES THE SCRIPT (2026-09-12 late, Brian's ruling 3).
 *
 * Twelve evening audit rows read as Brian's taps because a script minted his session and called
 * the routes. The convention now lives on the session: a session minted with `appliedBy` carries
 * "<name> (<appliedBy>)" on every audit row written under it, and on the box a session with no
 * browser behind it and no label is refused. Synthetic data only.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/server.ts';
import { createTestConfig, makeContact, makeStaff, type TestStaff } from './helpers.ts';
import type { Config } from '../src/config.ts';
import { createSession } from '../src/modules/auth/service.ts';

let app: FastifyInstance;
let config: Config;
let brian: TestStaff;

before(async () => {
  config = await createTestConfig('script_sessions');
  app = buildServer(config);
  await app.ready();
  brian = await makeStaff(app.db, config, { email: 'brian-scripts@example.test', name: 'Synthetic Brian', role: 'ceo', password: 'ceo-password-123456' });
});
after(async () => { await app.close(); });

test('a session minted for a script labels every audit row it writes; a browser session does not', async () => {
  const c = await makeContact(app.db, { firstName: 'Synthetic', lastName: 'Labelled', email: 'labelled-scripts@example.test' });

  // A person's own tap, from a browser: the bare name.
  const browser = await createSession(app.db, config, brian.id, { ip: null, userAgent: 'Mozilla/5.0 (synthetic)' });
  const me = await app.inject({ method: 'GET', url: `/contacts/${c.id}`, headers: { authorization: `Bearer ${browser}` } });
  assert.equal(me.statusCode, 200, me.body);
  const viewed = await app.db.query<{ actor_label: string }>(`SELECT actor_label FROM audit_log WHERE action = 'contact.viewed' AND object_id = $1 ORDER BY occurred_at DESC LIMIT 1`, [c.id]);
  assert.equal(viewed.rows[0]!.actor_label, 'Synthetic Brian');

  // A script applying a ruling: the name and what it applied, on every row.
  const scripted = await createSession(app.db, config, brian.id, { ip: null, appliedBy: 'ruled 2026-09-12, applied by script' });
  const archived = await app.inject({
    method: 'POST', url: `/contacts/${c.id}/archive`, headers: { authorization: `Bearer ${scripted}` },
    payload: { reason: 'Entered while trying the client record before launch; not a real person' },
  });
  assert.equal(archived.statusCode, 200, archived.body);
  const row = await app.db.query<{ actor_label: string }>(`SELECT actor_label FROM audit_log WHERE action = 'contact.archived' AND object_id = $1`, [c.id]);
  assert.equal(row.rows[0]!.actor_label, 'Synthetic Brian (ruled 2026-09-12, applied by script)');
  const session = await app.db.query<{ user_agent: string }>(`SELECT user_agent FROM staff_sessions WHERE staff_id = $1 ORDER BY created_at DESC LIMIT 1`, [brian.id]);
  assert.equal(session.rows[0]!.user_agent, 'script: ruled 2026-09-12, applied by script');
});

test('on the box, a session with no browser behind it and no label is refused', async () => {
  const production = { ...config, NODE_ENV: 'production' as const };
  await assert.rejects(
    createSession(app.db, production, brian.id, { ip: null, userAgent: null }),
    (e: { code?: string }) => e.code === 'session_unlabelled'
  );
  const labelled = await createSession(app.db, production, brian.id, { ip: null, userAgent: null, appliedBy: 'ruled today, applied by script' });
  assert.ok(labelled.length > 20, 'a labelled script session is minted');
  const withBrowser = await createSession(app.db, production, brian.id, { ip: null, userAgent: 'Mozilla/5.0 (synthetic)' });
  assert.ok(withBrowser.length > 20, 'a browser session needs no label');
});
