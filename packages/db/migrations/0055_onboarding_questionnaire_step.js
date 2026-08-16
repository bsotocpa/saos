/*
 * The onboarding questionnaire becomes a checklist step (Brian, 2026-08-15).
 *
 * #30/#31 ruling: intake SPLITS. The pre-engagement form stays minimal and keeps
 * creating the contact — identity, contact details, language, what they need. The
 * onboarding-voice questions move to a post-engagement questionnaire assembled from
 * the Form 5 A–I modules, and that questionnaire is a step on the portal checklist.
 *
 * Why it had to move: submitting the intake is the call that CREATES the contact and
 * the portal user, so anyone who can see the checklist has already submitted one. An
 * "intake" step would have shown complete for every client who arrived the normal way.
 * The questionnaire is different — it can only be assembled once engagements exist,
 * because `assembleModules` triggers on the client's service lines and industry.
 *
 * `step_questionnaire_at` joins the existing step_* columns rather than replacing any.
 * step_pay_deposit_at and step_book_consult_at hold real dates for real clients and
 * stay: the deposit is now collected at quote acceptance, before the portal journey,
 * so it leaves the DISPLAYED checklist while its history remains readable.
 */

exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE portal_onboarding
      ADD COLUMN IF NOT EXISTS step_questionnaire_at timestamptz;

    COMMENT ON COLUMN portal_onboarding.step_questionnaire_at IS
      'Step 4 of the canonical journey: the assembled service-onboarding questionnaire (Form 5 modules A-I) was submitted. Self-completing — set by the submit route, never tickable by hand, because a client cannot mark a questionnaire done without answering it.';
  `);

  /*
   * Backfill from the source of truth rather than leaving it null: a client who has
   * already submitted a service_onboarding form has done this step, and showing it as
   * outstanding would ask them to redo work they finished. Uses the earliest submission,
   * so the date is when they actually did it.
   */
  pgm.sql(`
    UPDATE portal_onboarding po
       SET step_questionnaire_at = s.first_submitted
      FROM (
        SELECT contact_id, min(submitted_at) AS first_submitted
          FROM form_submissions
         WHERE form_key = 'service_onboarding' AND status = 'submitted' AND contact_id IS NOT NULL
         GROUP BY contact_id
      ) s
     WHERE po.contact_id = s.contact_id AND po.step_questionnaire_at IS NULL;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`ALTER TABLE portal_onboarding DROP COLUMN IF EXISTS step_questionnaire_at;`);
};
