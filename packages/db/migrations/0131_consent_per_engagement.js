/* eslint-disable camelcase */
/**
 * 0131 — THE §7216 CONSENT FOR A NEW ENGAGEMENT (Brian, 2026-09-27, R87).
 *
 * Brian's 1040, accepted 2026-09-27, could not be consented to: the USE consent was keyed on (contact,
 * type) forever, so his 2026-09-20 answer (given while the 1120S was the open engagement) answered for
 * every engagement after it, and nothing was offered. And the two consent_7216 envelopes intake queued
 * on 2026-08-13 were never closed (the R46 closing code arrived after his answer), so Home read
 * "waiting for your signature" and /sign read "being prepared" beside "nothing is needed".
 *
 *   consents.engagement_id   the tax engagement an answer was given for. An answer with none (every
 *                            answer before today) covers the engagements that were open when it was
 *                            given; a tax engagement opened after it is asked again.
 *
 * And the stale intake envelopes are closed once, where the client has answered the USE consent since
 * the envelope was queued: completed when that answer was a yes, declined when it was a no. Counted.
 */
exports.shorthands = undefined;

exports.up = async (pgm) => {
  await pgm.db.query(`ALTER TABLE consents ADD COLUMN IF NOT EXISTS engagement_id uuid REFERENCES engagements(id)`);
  await pgm.db.query(`
    COMMENT ON COLUMN consents.engagement_id IS
      'R87: the tax engagement this §7216 answer was given for. NULL (every answer before 2026-09-27) covers the engagements open when it was given.'
  `);
  const { rows } = await pgm.db.query(`
    UPDATE signature_envelopes se
       SET status = CASE WHEN a.status = 'signed' THEN 'completed' ELSE 'declined' END::envelope_status,
           completed_at = CASE WHEN a.status = 'signed' THEN COALESCE(se.completed_at, a.at) ELSE se.completed_at END,
           declined_at  = CASE WHEN a.status = 'declined' THEN COALESCE(se.declined_at, a.at) ELSE se.declined_at END
      FROM (SELECT DISTINCT ON (contact_id) contact_id, status::text AS status, COALESCE(signed_at, created_at) AS at
              FROM consents WHERE type = '7216_use' AND status IN ('signed', 'declined')
             ORDER BY contact_id, COALESCE(signed_at, created_at) DESC) a
     WHERE se.contact_id = a.contact_id AND se.type = 'consent_7216' AND se.status IN ('draft', 'sent', 'viewed')
       AND a.at >= se.created_at
    RETURNING se.id
  `);
  console.log(`0131: ${rows.length} intake consent envelope(s) closed: the client answered the USE consent after they were queued`);
};

exports.down = async (pgm) => {
  await pgm.db.query(`ALTER TABLE consents DROP COLUMN IF EXISTS engagement_id`);
};
