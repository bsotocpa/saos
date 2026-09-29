/*
 * FLAG ONE RECORD AS A TEST CLIENT, THROUGH THE EXISTING DOOR (Brian, 2026-09-29, R92 decisions).
 *
 * "Flag <the named record> as a test client through the existing control, with the reason 'Test
 * record from the Dubsado migration.'" The contact's test flag is set by the Archive door
 * (POST /contacts/:id/archive with isTest and its note): the flag and the archive go together, audited,
 * and the door refuses a record that still holds active work. This script applies that door once, in a
 * labelled script session that is logged out at the end. Prints the outcome, never the name.
 *
 *   docker compose ... run --rm --no-deps api node --experimental-strip-types apps/api/scripts/flag-test-contact.ts <contactId> "<reason>"
 */
import { buildServer } from '../src/server.ts';
import { loadConfig } from '../src/config.ts';
import { createSession } from '../src/modules/auth/service.ts';

const [contactId, reason] = process.argv.slice(2);
if (!contactId || !/^[0-9a-f-]{36}$/.test(contactId) || !reason) throw new Error('usage: flag-test-contact.ts <contactId> "<reason>"');
const config = loadConfig(process.env);
const app = buildServer(config);
await app.ready();
try {
  const ceo = await app.db.query<{ id: string }>(
    `SELECT s.id FROM staff s JOIN roles r ON r.id = s.role_id WHERE r.key = 'ceo' AND s.is_active ORDER BY s.created_at LIMIT 1`
  );
  if (!ceo.rows[0]) throw new Error('no active CEO');
  const token = await createSession(app.db, config, ceo.rows[0].id, { appliedBy: 'R92 decisions: flag the named record as a test client', ip: null, userAgent: null });
  const headers = { authorization: `Bearer ${token}` };
  try {
    const res = await app.inject({ method: 'POST', url: `/contacts/${contactId}/archive`, headers, payload: { reason, isTest: true, testNote: reason } });
    console.log(`flag-test-contact: ${res.statusCode} ${res.statusCode === 200 ? 'flagged test and archived' : String(res.json().error ?? '')}`);
  } finally {
    await app.inject({ method: 'POST', url: '/auth/logout', headers });
  }
} finally {
  await app.close();
}
