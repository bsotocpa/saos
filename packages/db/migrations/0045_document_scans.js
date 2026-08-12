/**
 * FINDING #14 — portal uploads were never virus-scanned.
 *
 * scanBuffer() had exactly one caller: the inbound email/MMS path. Every portal
 * upload — the primary way client documents arrive — went straight to MinIO
 * unscanned, and `documents` had no column in which to record a verdict.
 *
 * Brian's ruling (2026-08-12) is the email-path model with one deliberate change,
 * and the change is the point:
 *
 *   INTAKE NEVER REFUSES. A client upload is always accepted and stored. Refusing
 *   an upload because our scanner is wedged pushes our infrastructure problem onto
 *   the client, on the surface they use most. The file lands in `pending_scan`.
 *
 *   FILING IS FAIL-CLOSED. The document does not satisfy a document request until
 *   its scan comes back clean. That is the gate the email path already enforces
 *   ("a skipped scan is not a pass"), applied at the only place it can be applied
 *   here — the moment the file starts counting as delivered.
 *
 *   A DEAD SCANNER IS A DELAY, NOT A DECISION. `skipped` is re-scanned on a
 *   schedule until it resolves, then the deferred filing happens automatically.
 *
 * So the deferred filing target has to be remembered: pending_request_item_id holds
 * the request item that WOULD have been fulfilled at intake, waiting for a clean
 * verdict. Without it the rescan job could not know what to complete, because
 * document_request_items.document_id is only written on fulfillment.
 *
 * Existing rows default to 'pending_scan' rather than being assumed clean: nothing
 * in production has ever been scanned, so claiming otherwise would be a lie in a
 * compliance column. scripts/backfill-document-scans.mjs resolves them.
 */

exports.up = (pgm) => {
  pgm.sql(`
    CREATE TYPE document_scan_status AS ENUM
      ('pending_scan', 'clean', 'infected', 'skipped', 'not_configured');

    ALTER TABLE documents
      ADD COLUMN scan_status document_scan_status NOT NULL DEFAULT 'pending_scan',
      ADD COLUMN scan_detail text,
      ADD COLUMN scanned_at timestamptz,
      ADD COLUMN scan_attempts integer NOT NULL DEFAULT 0,
      ADD COLUMN pending_request_item_id uuid
        REFERENCES document_request_items(id) ON DELETE SET NULL;

    COMMENT ON COLUMN documents.scan_status IS
      'pending_scan on insert — never assume clean. Intake never refuses an upload; filing (satisfying a document request) requires clean. skipped means the scanner was unreachable and the rescan job will retry, not that the file passed. not_configured means no scanner exists in this deployment at all, which can only happen in dev/test: production refuses to boot without CLAMAV_HOST, and that assertion is what makes it safe for that one state to file.';
    COMMENT ON COLUMN documents.pending_request_item_id IS
      'The document-request item this upload will fulfil once the scan comes back clean. Set only while a verdict is outstanding; cleared on fulfillment. The rescan job needs it because document_request_items.document_id is written at fulfillment, not at upload.';

    -- The rescan job's work queue: oldest outstanding verdict first.
    CREATE INDEX idx_documents_awaiting_scan ON documents (created_at)
      WHERE scan_status IN ('pending_scan', 'skipped');

    -- Infected files are rare and always interesting; make them cheap to list.
    CREATE INDEX idx_documents_infected ON documents (contact_id)
      WHERE scan_status = 'infected';

    /*
     * Dependency reachability, persisted.
     *
     * probeDependencies() already ran every tick and alerted, but nothing REMEMBERED
     * the state, so "ClamAV has been unreachable for thirteen hours" was not a fact
     * the system could state — it was something discovered by reading OOM logs.
     * The "since" column is what turns a boolean into a duration on the dashboard.
     */
    CREATE TABLE dependency_health (
      name            text PRIMARY KEY,
      reachable       boolean NOT NULL,
      since           timestamptz NOT NULL DEFAULT now(),
      last_checked_at timestamptz NOT NULL DEFAULT now(),
      detail          text
    );

    COMMENT ON COLUMN dependency_health.since IS
      'When the CURRENT reachable state began — updated only on transition, so it answers "down for how long?" rather than "checked when?".';
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP TABLE dependency_health;
    DROP INDEX IF EXISTS idx_documents_infected;
    DROP INDEX IF EXISTS idx_documents_awaiting_scan;
    ALTER TABLE documents
      DROP COLUMN pending_request_item_id,
      DROP COLUMN scan_attempts,
      DROP COLUMN scanned_at,
      DROP COLUMN scan_detail,
      DROP COLUMN scan_status;
    DROP TYPE document_scan_status;
  `);
};
