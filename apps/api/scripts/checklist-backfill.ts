/*
 * THE CHECKLIST BACKFILL ON THE BOX (Brian, 2026-09-29, R91).
 *
 * "Every open return on an engagement accepted before migration 0132 gets a checklist from its quoted
 * lines, through a door, audited as 'Checklist added after the fact from the accepted quote.' Report the
 * production count of open returns without a checklist before and after."
 *
 * Runs in a labelled script session (every audit row names this script) and applies the door
 * (POST /tax-engagements/:id/checklist-backfill) to each open return from an accepted quote that has no
 * checklist; a return opened by hand has no quoted lines and is counted, not touched. Counts only.
 * Nothing is emailed: opening a checklist sends nothing (R83).
 *
 *   docker compose ... run --rm --no-deps api node --experimental-strip-types scripts/checklist-backfill.ts
 */
import { buildServer } from '../src/server.ts';
import { loadConfig } from '../src/config.ts';
import { createSession } from '../src/modules/auth/service.ts';

const config = loadConfig(process.env);
const app = buildServer(config);
await app.ready();
const COUNT = `SELECT count(*)::int AS open_returns,
         count(*) FILTER (WHERE NOT EXISTS (SELECT 1 FROM document_requests dr WHERE dr.tax_engagement_id = te.id AND dr.source = 'checklist'))::int AS without_checklist,
         count(*) FILTER (WHERE NOT EXISTS (SELECT 1 FROM document_requests dr WHERE dr.tax_engagement_id = te.id AND dr.source = 'checklist')
                            AND EXISTS (SELECT 1 FROM engagement_scope_items s WHERE s.engagement_id = te.engagement_id AND s.source_quote_id IS NOT NULL AND (s.tax_year IS NULL OR s.tax_year = te.tax_year)))::int AS without_checklist_from_a_quote
    FROM tax_engagements te WHERE te.stage::text NOT IN ('completed', 'withdrawn')`;
try {
  const before = (await app.db.query(COUNT)).rows[0];
  const eligible = await app.db.query<{ id: string }>(
    `SELECT te.id FROM tax_engagements te
      WHERE te.stage::text NOT IN ('completed', 'withdrawn')
        AND NOT EXISTS (SELECT 1 FROM document_requests dr WHERE dr.tax_engagement_id = te.id AND dr.source = 'checklist')
        AND EXISTS (SELECT 1 FROM engagement_scope_items s WHERE s.engagement_id = te.engagement_id AND s.source_quote_id IS NOT NULL AND (s.tax_year IS NULL OR s.tax_year = te.tax_year))
      ORDER BY te.created_at`
  );
  const ceo = await app.db.query<{ id: string }>(
    `SELECT s.id FROM staff s JOIN roles r ON r.id = s.role_id WHERE r.key = 'ceo' AND s.is_active ORDER BY s.created_at LIMIT 1`
  );
  if (!ceo.rows[0]) throw new Error('no active CEO');
  const token = await createSession(app.db, config, ceo.rows[0].id, { appliedBy: 'R91 checklist backfill (2026-09-29 ruling)', ip: null, userAgent: null });
  const headers = { authorization: `Bearer ${token}` };
  let added = 0;
  let items = 0;
  const refused: Record<string, number> = {};
  try {
    for (const r of eligible.rows) {
      const res = await app.inject({ method: 'POST', url: `/tax-engagements/${r.id}/checklist-backfill`, headers });
      if (res.statusCode === 201) { added++; items += Number(res.json().items ?? 0); }
      else { const code = String(res.json().error ?? res.statusCode); refused[code] = (refused[code] ?? 0) + 1; }
    }
  } finally {
    await app.inject({ method: 'POST', url: '/auth/logout', headers });
  }
  const after = (await app.db.query(COUNT)).rows[0];
  console.log('moment | open returns | without a checklist | without a checklist, from an accepted quote');
  console.log(`before | ${before.open_returns} | ${before.without_checklist} | ${before.without_checklist_from_a_quote}`);
  console.log(`after | ${after.open_returns} | ${after.without_checklist} | ${after.without_checklist_from_a_quote}`);
  console.error(`backfilled ${added} return(s), ${items} checklist item(s); refused ${JSON.stringify(refused)}`);
} finally {
  await app.close();
}
