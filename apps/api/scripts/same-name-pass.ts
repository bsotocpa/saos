/*
 * THE SAME-NAME PASS ON THE BOX (Brian, 2026-09-29, R97).
 *
 * Applies POST /contacts/same-name/resolve in a labelled CEO script session (logged out at the end):
 * without --apply it counts what the pass would do and writes nothing; with it, the empty records are
 * archived with their redirect and every other name-only pair becomes a banner on both client pages.
 * The protected names are never read. Prints counts only.
 *
 *   docker compose ... run --rm --no-deps api node --experimental-strip-types apps/api/scripts/same-name-pass.ts [--apply]
 */
import { buildServer } from '../src/server.ts';
import { loadConfig } from '../src/config.ts';
import { createSession } from '../src/modules/auth/service.ts';

const apply = process.argv.includes('--apply');
const config = loadConfig(process.env);
const app = buildServer(config);
await app.ready();
try {
  const ceo = await app.db.query<{ id: string }>(
    `SELECT s.id FROM staff s JOIN roles r ON r.id = s.role_id WHERE r.key = 'ceo' AND s.is_active ORDER BY s.created_at LIMIT 1`
  );
  if (!ceo.rows[0]) throw new Error('no active CEO');
  const token = await createSession(app.db, config, ceo.rows[0].id, { appliedBy: `R97 same-name pass (${apply ? 'apply' : 'count only'})`, ip: null, userAgent: null });
  const headers = { authorization: `Bearer ${token}` };
  try {
    const res = await app.inject({ method: 'POST', url: '/contacts/same-name/resolve', headers, payload: { apply } });
    if (res.statusCode !== 200) throw new Error(`the pass answered ${res.statusCode} ${String(res.json().error ?? '')}`);
    console.log(`measure | ${apply ? 'applied' : 'would apply (count only)'}`);
    for (const [k, v] of Object.entries(res.json() as Record<string, number>)) console.log(`${k.replaceAll('_', ' ')} | ${v}`);
  } finally {
    await app.inject({ method: 'POST', url: '/auth/logout', headers });
  }
} finally {
  await app.close();
}
