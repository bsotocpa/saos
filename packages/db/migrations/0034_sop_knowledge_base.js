/**
 * SOP knowledge base (M27) — the runs-without-Brian layer.
 *
 * Spec: internal wiki per role and process, versioned and searchable; task types
 * link to their SOP so new hires execute from tasks rather than tribal
 * knowledge; Whisper-transcribed handoff sessions can seed drafts, with approval
 * before publish.
 *
 * Design notes:
 *
 *  · SOPs are INTERNAL, so they are English-only. Every client-facing surface in
 *    this system ships EN+ES; these are Rene's phone flows and Marian's close
 *    checklist. Adding a Spanish column nobody fills would be worse than not
 *    having one — flag it if that changes.
 *
 *  · VERSIONED means every published edit snapshots the previous body. An SOP
 *    that silently changes under a new hire mid-task is how you get two people
 *    doing a process two ways and no record of when it diverged.
 *
 *  · DRAFTS ARE NOT DISCOVERABLE. A Whisper-seeded draft is an unreviewed
 *    transcript of someone talking; surfacing it in search next to approved
 *    procedure would make the KB untrustworthy. Search returns published only.
 *
 *  · sop_task_types is the registry behind CLAUDE.md's rule that a
 *    task-generating feature without its SOP hook is incomplete. Every task
 *    source_type must appear here — either pointing at an SOP or explicitly
 *    recorded as not needing one, WITH a reason. "Not yet written" is a valid
 *    answer; silence is not.
 */

exports.up = (pgm) => {
  pgm.sql(`
    CREATE TYPE sop_status AS ENUM ('draft', 'published', 'archived');

    CREATE TABLE sops (
      id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      slug           text NOT NULL UNIQUE,
      title          text NOT NULL,
      -- Whose procedure this is (roles.key), and which process it covers.
      role_key       text,
      process        text,
      body_md        text NOT NULL,
      status         sop_status NOT NULL DEFAULT 'draft',
      version        integer NOT NULL DEFAULT 1 CHECK (version >= 1),
      -- Provenance: a transcript-seeded draft is labelled as such forever, so a
      -- reader knows whether they are looking at written procedure or a
      -- recording of someone improvising.
      seeded_from_meeting_id uuid REFERENCES meetings(id),
      published_at   timestamptz,
      published_by_staff_id  uuid REFERENCES staff(id),
      created_by_staff_id    uuid REFERENCES staff(id),
      created_at     timestamptz NOT NULL DEFAULT now(),
      updated_at     timestamptz NOT NULL DEFAULT now(),
      -- Published must carry a publication TIME. The approver is nullable on
      -- purpose: the seeded skeletons are machine-written from what the code
      -- enforces and have no human behind them yet. Attributing them to Brian at
      -- seed time — which is what an approver-required CHECK forces you to do —
      -- would put his name on procedure he never wrote. A NULL approver is the
      -- honest state and the KB surfaces it as "not yet reviewed by a person".
      CONSTRAINT sops_published_has_timestamp CHECK (
        status <> 'published' OR published_at IS NOT NULL
      )
    );
    CREATE TRIGGER trg_sops_updated_at BEFORE UPDATE ON sops
      FOR EACH ROW EXECUTE FUNCTION set_updated_at();

    -- Full-text search over title + body, generated so it can never drift from
    -- the content it indexes.
    ALTER TABLE sops ADD COLUMN search tsvector
      GENERATED ALWAYS AS (
        setweight(to_tsvector('english', coalesce(title, '')), 'A') ||
        setweight(to_tsvector('english', coalesce(process, '')), 'B') ||
        setweight(to_tsvector('english', coalesce(body_md, '')), 'C')
      ) STORED;
    CREATE INDEX idx_sops_search ON sops USING GIN (search);
    CREATE INDEX idx_sops_role ON sops (role_key, status);

    CREATE TABLE sop_versions (
      id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      sop_id        uuid NOT NULL REFERENCES sops(id) ON DELETE CASCADE,
      version       integer NOT NULL,
      title         text NOT NULL,
      body_md       text NOT NULL,
      note          text,
      changed_by_staff_id uuid REFERENCES staff(id),
      created_at    timestamptz NOT NULL DEFAULT now(),
      UNIQUE (sop_id, version)
    );
    COMMENT ON TABLE sop_versions IS
      'Snapshot of every published edit. Answers "what did this SOP say when that task was done".';

    CREATE TABLE sop_task_types (
      task_type     text PRIMARY KEY,
      sop_id        uuid REFERENCES sops(id) ON DELETE SET NULL,
      -- Required when there is no SOP: an explicit reason beats silence.
      no_sop_reason text,
      created_at    timestamptz NOT NULL DEFAULT now(),
      updated_at    timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT sop_task_types_mapped_or_explained CHECK (
        sop_id IS NOT NULL OR (no_sop_reason IS NOT NULL AND length(btrim(no_sop_reason)) >= 10)
      )
    );
    CREATE TRIGGER trg_sop_task_types_updated_at BEFORE UPDATE ON sop_task_types
      FOR EACH ROW EXECUTE FUNCTION set_updated_at();
    COMMENT ON TABLE sop_task_types IS
      'CLAUDE.md: task types carry a "how to do this" link. Every task source_type must be registered here — mapped to an SOP, or explicitly recorded as not needing one with a reason.';
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP TABLE sop_task_types;
    DROP TABLE sop_versions;
    DROP TABLE sops;
    DROP TYPE sop_status;
  `);
};
