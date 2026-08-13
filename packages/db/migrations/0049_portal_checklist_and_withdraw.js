/**
 * Portal home redesign (Brian, 2026-08-13, from the rehearsal) + document withdraw.
 *
 * THE CHECKLIST becomes deposit-first, because services do not start before the deposit
 * is paid, and loses "Book your consultation" — a client only reaches a quote after the
 * discovery meeting, so asking them to book one asks for something already done.
 *
 *   1. Sign your documents        (existing column)
 *   2. Pay deposit                (NEW — completes ITSELF when the invoice is paid)
 *   3. Confirm your information   (existing column)
 *   4. Upload your documents      (renamed: clients send more than last year's return)
 *   5. Track your services        (NEW — links to the engagement stages)
 *
 * step_book_consult_at is RETIRED, NOT DROPPED. It records real actions real clients
 * took; deleting the column would erase them to save nothing. It simply stops being
 * read. The rename of step_upload_prior_return_at is a RENAME rather than a new column
 * for the same reason — the completion dates already in it are true.
 *
 * DOCUMENT WITHDRAW (Brian's ruling: withdraw, not delete). A client who uploads the
 * wrong file needs an undo, but client documents are audit-logged, virus-scanned and
 * filed against document requests, and the WISP rule is that every access and change is
 * recorded. So withdrawing:
 *   · hides it from the client's active list and from staff filing surfaces
 *   · un-fulfils whatever document request it was satisfying, so the chase RESUMES
 *   · keeps the row, the object, and who withdrew it and when
 * A hard delete would satisfy the UI and violate the retention rule.
 */

exports.up = (pgm) => {
  pgm.sql(`
    -- ── Checklist ────────────────────────────────────────────────────────────
    ALTER TABLE portal_onboarding
      RENAME COLUMN step_upload_prior_return_at TO step_upload_documents_at;

    ALTER TABLE portal_onboarding
      ADD COLUMN step_pay_deposit_at    timestamptz,
      ADD COLUMN step_track_services_at timestamptz;

    COMMENT ON COLUMN portal_onboarding.step_upload_documents_at IS
      'Renamed from step_upload_prior_return_at (2026-08-13). Same data: clients send more than last year''s return, and the old label made them think that was all we wanted.';
    COMMENT ON COLUMN portal_onboarding.step_pay_deposit_at IS
      'Set by the system when the deposit invoice is paid, not by the client ticking it. Asking someone to confirm something we can already see is how a checklist starts lying.';
    COMMENT ON COLUMN portal_onboarding.step_book_consult_at IS
      'RETIRED 2026-08-13 and no longer shown: a client only reaches a quote after the discovery meeting. Kept because the timestamps in it record real client actions. "Schedule a Call/Meeting" now lives in Quick actions instead.';

    -- ── Document withdraw ────────────────────────────────────────────────────
    ALTER TABLE documents
      ADD COLUMN withdrawn_at        timestamptz,
      ADD COLUMN withdrawn_by_type   uploader_type,
      ADD COLUMN withdrawn_by_id     uuid,
      ADD COLUMN withdrawn_reason    text;

    COMMENT ON COLUMN documents.withdrawn_at IS
      'Set when a client (or staff) withdraws a file uploaded in error. The row and the stored object SURVIVE — withdrawing is not deleting. A withdrawn document is hidden from active lists, cannot satisfy a document request, and cannot be filed.';

    -- A withdrawal must say who did it, the same way an override must carry a reason.
    ALTER TABLE documents
      ADD CONSTRAINT documents_withdrawn_has_actor CHECK (
        withdrawn_at IS NULL OR withdrawn_by_type IS NOT NULL
      );

    -- Active documents are the common read; keep that index tight.
    CREATE INDEX idx_documents_active ON documents (contact_id, created_at DESC)
      WHERE archived_at IS NULL AND withdrawn_at IS NULL;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP INDEX IF EXISTS idx_documents_active;
    ALTER TABLE documents
      DROP CONSTRAINT IF EXISTS documents_withdrawn_has_actor,
      DROP COLUMN withdrawn_reason,
      DROP COLUMN withdrawn_by_id,
      DROP COLUMN withdrawn_by_type,
      DROP COLUMN withdrawn_at;
    ALTER TABLE portal_onboarding
      DROP COLUMN step_track_services_at,
      DROP COLUMN step_pay_deposit_at;
    ALTER TABLE portal_onboarding
      RENAME COLUMN step_upload_documents_at TO step_upload_prior_return_at;
  `);
};
