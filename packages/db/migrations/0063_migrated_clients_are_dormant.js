/*
 * THE MIGRATED BOOK IS NOT A PILE OF LEADS (#42 follow-up, 2026-08-16).
 *
 * 0062 backfilled the lifecycle by asking what SAOS can see: a signed Master, an open
 * engagement, an accepted quote. For the 426 clients imported from Dubsado the answer to
 * all three is no — their Masters and their history live in the old system — so they
 * landed on `lead`.
 *
 * That is the letter of the rule and the opposite of its point. #42 exists because a
 * signed paying client displaying as a lead misleads triage; recomputing 426 established
 * clients INTO "lead" reproduces exactly that, at scale, pointing the other way.
 *
 * And the information was already there. Before 0062, those 426 were the only contacts
 * with soto_status = 'active', while the 436 imported from Zoho were 'lead' — the import
 * had encoded the distinction correctly, because Dubsado held paying clients and Zoho held
 * prospects. 0062 threw that away by only counting evidence SAOS itself generated. The
 * migration IS an existing event.
 *
 * `dormant` is the honest state, by Brian's own definition: "no open engagements,
 * relationship intact — work concluded, may return". That is precisely a client whose
 * history is in the old system and who has no current work here. They climb to `active`
 * the moment they accept a quote and sign, through the ordinary ladder.
 *
 * The Zoho contacts stay `lead`, which is what they were.
 */

exports.up = (pgm) => {
  pgm.sql(`
    UPDATE contacts
       SET contact_status = 'dormant',
           contact_status_at = now(),
           soto_status = 'inactive'
     WHERE contact_status = 'lead'
       AND source = 'dubsado'
       AND NOT is_archived;
  `);
};

exports.down = () => {
  /*
   * Not reversible. The previous value was a wrong answer produced by a backfill that
   * could not see the old system, and restoring it would only recreate the defect.
   */
};
