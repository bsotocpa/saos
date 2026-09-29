/*
 * THE STEPPER ON A CLIENT'S RETURNS, READ-ONLY (Brian, 2026-09-29, the R50 v3 approval).
 *
 * "Flip OPS_RETURN_STEPPER on ... and a check that the stepper renders on Brian's 1120S and 1040."
 * The production Ops is never signed into from here (standing rule), so this reads exactly what the
 * stepper reads: GET /tax-engagements?contactId= and GET /tax-engagements/:id, through the app's own
 * routes, in a labelled script session that is logged out at the end. It writes nothing else. It
 * prints, per return, the stepper's input (the detail the component builds StepperInput from) as JSON
 * on stdout; scripts/stepper-check-phases.mjs runs the Ops lib's buildSteps/buildPhases over it and
 * prints forms, years and phase states only.
 *
 *   docker compose ... run --rm --no-deps api node --experimental-strip-types scripts/stepper-check.ts <contactId>
 */
import { buildServer } from '../src/server.ts';
import { loadConfig } from '../src/config.ts';
import { createSession } from '../src/modules/auth/service.ts';

const contactId = process.argv[2];
if (!contactId || !/^[0-9a-f-]{36}$/.test(contactId)) throw new Error('usage: stepper-check.ts <contactId>');

const config = loadConfig(process.env);
const app = buildServer(config);
await app.ready();
try {
  const ceo = await app.db.query<{ id: string }>(
    `SELECT s.id FROM staff s JOIN roles r ON r.id = s.role_id WHERE r.key = 'ceo' AND s.is_active ORDER BY s.created_at LIMIT 1`
  );
  if (!ceo.rows[0]) throw new Error('no active CEO');
  const token = await createSession(app.db, config, ceo.rows[0].id, { appliedBy: 'R50 v3 stepper render check (read-only GETs)', ip: null, userAgent: null });
  const headers = { authorization: `Bearer ${token}` };
  try {
    const list = await app.inject({ method: 'GET', url: `/tax-engagements?contactId=${contactId}`, headers });
    if (list.statusCode !== 200) throw new Error(`list answered ${list.statusCode}`);
    const out = [];
    for (const t of list.json().taxEngagements as Array<{ id: string; tax_year: number; return_type: string; stage: string }>) {
      if (t.stage === 'withdrawn') continue;
      const d = await app.inject({ method: 'GET', url: `/tax-engagements/${t.id}`, headers });
      if (d.statusCode !== 200) throw new Error(`detail answered ${d.statusCode}`);
      out.push({ taxYear: t.tax_year, returnType: t.return_type, detail: d.json() });
    }
    console.log(JSON.stringify({ switches: app.switches, returns: out }));
  } finally {
    await app.inject({ method: 'POST', url: '/auth/logout', headers });
  }
} finally {
  await app.close();
}
