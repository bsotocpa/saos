/* eslint-disable camelcase */
/**
 * 0139 — WHAT KIND OF WITHDRAWAL IT WAS (Brian, 2026-10-02, R117).
 *
 * A withdrawal of the firm's own record (a duplicate, a migration leftover, an import error) is hidden
 * from the portal entirely; Ops still shows it. The portal shows only withdrawals the client would
 * recognize. Until now the portal's reason was guessed from the staff note's words; the kind is now
 * recorded with the withdrawal, chosen by the person withdrawing:
 *   withdrawal_kind  'client'        the client's work ended (they stopped, filed elsewhere): shown;
 *                    'change_order'  an updated agreement replaced it: shown;
 *                    'firm_record'   the firm's own record (duplicate, migration leftover, import error): hidden.
 * Every withdrawn return carries one (the CHECK); no other return does.
 *
 * Backfill, from the words already recorded with each withdrawal — the return's withdrawal note AND its
 * engagement's close reason, both read: "superseded by change order…" is change_order; a duplicate, a
 * quote accepted twice, a migration, an import or a test record is firm_record; anything else is
 * client, the kind that stays visible. On production (2026-10-02) two returns are withdrawn, both
 * Brian's 2025 1040 duplicates, and both reasons name the duplicate. The counts are printed so the
 * preflight on the production copy shows them before the swap.
 */
exports.up = async (pgm) => {
  await pgm.db.query(`ALTER TABLE tax_engagements ADD COLUMN IF NOT EXISTS withdrawal_kind text`);
  await pgm.db.query(`
    WITH w AS (
      SELECT te.id,
             COALESCE((SELECT h.note FROM engagement_stage_history h
                        WHERE h.tax_engagement_id = te.id AND h.stage = 'withdrawn'
                        ORDER BY h.entered_at DESC LIMIT 1), '') || ' | ' || COALESCE(e.close_reason, '') AS words
        FROM tax_engagements te JOIN engagements e ON e.id = te.engagement_id
       WHERE te.stage = 'withdrawn' AND te.withdrawal_kind IS NULL)
    UPDATE tax_engagements te
       SET withdrawal_kind = CASE
             WHEN w.words ~* 'superseded by change order' THEN 'change_order'
             WHEN w.words ~* '(duplicat|accepted twice|migrat|import|test record)' THEN 'firm_record'
             ELSE 'client' END
      FROM w WHERE w.id = te.id`);
  await pgm.db.query(`
    ALTER TABLE tax_engagements
      ADD CONSTRAINT tax_engagements_withdrawal_kind_valid
        CHECK (withdrawal_kind IN ('client', 'change_order', 'firm_record')),
      ADD CONSTRAINT tax_engagements_withdrawal_kind_with_stage
        CHECK ((stage = 'withdrawn') = (withdrawal_kind IS NOT NULL))`);
  const { rows } = await pgm.db.query(
    `SELECT withdrawal_kind, count(*)::int AS n FROM tax_engagements WHERE stage = 'withdrawn' GROUP BY 1 ORDER BY 1`
  );
  console.log(`0139 withdrawal_kind backfill: ${rows.length ? rows.map((r) => `${r.withdrawal_kind} ${r.n}`).join(', ') : 'no withdrawn returns'}`);
};

exports.down = async (pgm) => {
  await pgm.db.query(`ALTER TABLE tax_engagements DROP CONSTRAINT IF EXISTS tax_engagements_withdrawal_kind_with_stage`);
  await pgm.db.query(`ALTER TABLE tax_engagements DROP CONSTRAINT IF EXISTS tax_engagements_withdrawal_kind_valid`);
  await pgm.db.query(`ALTER TABLE tax_engagements DROP COLUMN IF EXISTS withdrawal_kind`);
};
