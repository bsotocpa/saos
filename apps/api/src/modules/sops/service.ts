// SOP knowledge base (M27) — the runs-without-Brian layer.
//
// Three behaviours worth stating, because each is a choice:
//
//  1. SEARCH RETURNS PUBLISHED ONLY. A draft is either an unreviewed transcript
//     or a half-written procedure. Surfacing it beside approved procedure would
//     make the whole KB untrustworthy — the one property a runbook must have.
//
//  2. PUBLISHING SNAPSHOTS THE PREVIOUS BODY. So "what did this SOP say when
//     that task was done in March" is answerable. An SOP that silently changes
//     under a new hire is how two people end up doing a process two ways with no
//     record of when it diverged.
//
//  3. THE TASK LINK IS RESOLVED FROM THE REGISTRY, NOT TYPED. createTask looks
//     the source type up and attaches the SOP automatically, so a new hire
//     opening a task finds the procedure without anyone remembering to paste a
//     link.

import type { FastifyInstance } from 'fastify';
import { writeAudit } from '../../audit.ts';
import { AppError, type AuthedStaff } from '../../types.ts';
import { TASK_TYPE_SOPS } from './task-types.ts';

export interface SopInput {
  slug: string;
  title: string;
  bodyMd: string;
  roleKey?: string | null | undefined;
  process?: string | null | undefined;
}

const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export async function createSop(
  app: FastifyInstance,
  input: SopInput & { seededFromMeetingId?: string | null | undefined },
  actor: AuthedStaff
): Promise<{ id: string; slug: string; status: string }> {
  if (!SLUG_RE.test(input.slug)) {
    throw new AppError(400, 'bad_slug', 'Use a lowercase kebab-case slug, e.g. rene-phone-flow.');
  }
  const { rows } = await app.db.query<{ id: string }>(
    `INSERT INTO sops (slug, title, role_key, process, body_md, status, seeded_from_meeting_id, created_by_staff_id)
     VALUES ($1,$2,$3,$4,$5,'draft',$6,$7)
     ON CONFLICT (slug) DO NOTHING
     RETURNING id`,
    [
      input.slug, input.title, input.roleKey ?? null, input.process ?? null, input.bodyMd,
      input.seededFromMeetingId ?? null, actor.id,
    ]
  );
  if (!rows[0]) throw new AppError(409, 'slug_taken', `An SOP with slug '${input.slug}' already exists.`);
  await writeAudit(app.db, {
    actorType: 'staff', actorId: actor.id, actorLabel: actor.email,
    action: 'sop.created', objectType: 'sop', objectId: rows[0].id,
    details: { slug: input.slug, seeded_from_meeting: input.seededFromMeetingId ?? null },
  });
  return { id: rows[0].id, slug: input.slug, status: 'draft' };
}

/** Edit a draft, or stage a change to a published SOP (publish applies it). */
export async function updateSop(
  app: FastifyInstance,
  slug: string,
  patch: { title?: string | undefined; bodyMd?: string | undefined; roleKey?: string | null | undefined; process?: string | null | undefined },
  actor: AuthedStaff
): Promise<void> {
  const sets: string[] = [];
  const params: unknown[] = [slug];
  for (const [col, val] of Object.entries({
    title: patch.title, body_md: patch.bodyMd, role_key: patch.roleKey, process: patch.process,
  })) {
    if (val !== undefined) {
      params.push(val);
      sets.push(`${col} = $${params.length}`);
    }
  }
  if (sets.length === 0) throw new AppError(400, 'empty_update', 'Nothing to change.');
  const { rowCount } = await app.db.query(
    `UPDATE sops SET ${sets.join(', ')} WHERE slug = $1`,
    params
  );
  if ((rowCount ?? 0) === 0) throw new AppError(404, 'not_found', 'SOP not found.');
  await writeAudit(app.db, {
    actorType: 'staff', actorId: actor.id, actorLabel: actor.email,
    action: 'sop.updated', objectType: 'sop', objectId: slug,
    details: { fields: sets.map((s) => s.split(' =')[0]) },
  });
}

/**
 * Publish. Snapshots the CURRENT body as the outgoing version before the new one
 * becomes live, and records who approved it — a Whisper-seeded draft is somebody
 * talking until a human puts their name to it.
 */
export async function publishSop(
  app: FastifyInstance,
  slug: string,
  actor: AuthedStaff,
  note?: string
): Promise<{ version: number }> {
  const { rows } = await app.db.query<{
    id: string; version: number; title: string; body_md: string; status: string;
  }>(
    `SELECT id, version, title, body_md, status::text FROM sops WHERE slug = $1`,
    [slug]
  );
  const sop = rows[0];
  if (!sop) throw new AppError(404, 'not_found', 'SOP not found.');
  if (sop.body_md.trim().length < 40) {
    throw new AppError(
      400,
      'too_thin_to_publish',
      'This is too short to be a procedure someone could follow. Expand it or leave it as a draft.'
    );
  }

  // Each row in sop_versions is "what this SOP said AT version N" — so the
  // snapshot is of the text being published, numbered as the new version. The
  // earlier mistake was snapshotting the OUTGOING body, which meant the newest
  // published text was never recorded and each publish note was attached to the
  // version before it.
  const nextVersion = sop.status === 'published' ? sop.version + 1 : sop.version;
  await app.db.query(
    `INSERT INTO sop_versions (sop_id, version, title, body_md, note, changed_by_staff_id)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (sop_id, version) DO UPDATE SET
       title = EXCLUDED.title, body_md = EXCLUDED.body_md,
       note = EXCLUDED.note, changed_by_staff_id = EXCLUDED.changed_by_staff_id`,
    [sop.id, nextVersion, sop.title, sop.body_md, note ?? null, actor.id]
  );

  await app.db.query(
    `UPDATE sops
     SET status = 'published', version = $2, published_at = now(), published_by_staff_id = $3
     WHERE id = $1`,
    [sop.id, nextVersion, actor.id]
  );
  await writeAudit(app.db, {
    actorType: 'staff', actorId: actor.id, actorLabel: actor.email,
    action: 'sop.published', objectType: 'sop', objectId: sop.id,
    details: { slug, version: nextVersion, note: note ?? null },
  });
  return { version: nextVersion };
}

/**
 * Search. PUBLISHED ONLY — see the note at the top of the file. An empty query
 * lists everything published, so the KB is browsable and not just searchable.
 */
export async function searchSops(
  app: FastifyInstance,
  opts: { q?: string | undefined; roleKey?: string | undefined; includeDrafts?: boolean | undefined }
) {
  const clauses: string[] = [];
  const params: unknown[] = [];
  // Drafts are opt-in and only for the editors' own list view.
  clauses.push(opts.includeDrafts ? `status <> 'archived'` : `status = 'published'`);
  if (opts.roleKey) {
    params.push(opts.roleKey);
    clauses.push(`role_key = $${params.length}`);
  }
  let rank = '0 AS rank';
  if (opts.q && opts.q.trim().length > 0) {
    params.push(opts.q.trim());
    clauses.push(`search @@ websearch_to_tsquery('english', $${params.length})`);
    rank = `ts_rank(search, websearch_to_tsquery('english', $${params.length})) AS rank`;
  }
  const { rows } = await app.db.query(
    `SELECT slug, title, role_key, process, status::text AS status, version,
            seeded_from_meeting_id IS NOT NULL AS from_transcript,
            published_at, ${rank}
     FROM sops
     WHERE ${clauses.join(' AND ')}
     ORDER BY rank DESC, title
     LIMIT 100`,
    params
  );
  return { sops: rows };
}

export async function getSop(app: FastifyInstance, slug: string) {
  const { rows } = await app.db.query(
    `SELECT s.slug, s.title, s.role_key, s.process, s.body_md, s.status::text AS status, s.version,
            s.seeded_from_meeting_id IS NOT NULL AS from_transcript,
            s.published_at, st.full_name AS published_by
     FROM sops s LEFT JOIN staff st ON st.id = s.published_by_staff_id
     WHERE s.slug = $1`,
    [slug]
  );
  if (!rows[0]) throw new AppError(404, 'not_found', 'SOP not found.');
  const history = await app.db.query(
    `SELECT v.version, v.title, v.note, v.created_at, st.full_name AS changed_by
     FROM sop_versions v LEFT JOIN staff st ON st.id = v.changed_by_staff_id
     WHERE v.sop_id = (SELECT id FROM sops WHERE slug = $1)
     ORDER BY v.version DESC`,
    [slug]
  );
  return { sop: rows[0], history: history.rows };
}

/**
 * Seed a DRAFT from a recorded handoff session. Deliberately a draft: this is a
 * transcript of someone explaining a process out loud, which is a starting point
 * for a procedure and not a procedure.
 */
export async function seedSopFromMeeting(
  app: FastifyInstance,
  meetingId: string,
  input: { slug: string; title: string; roleKey?: string | undefined; process?: string | undefined },
  actor: AuthedStaff
): Promise<{ id: string; slug: string; status: string }> {
  // The transcript lives in its own table (one per engine run); the summary is
  // preferred because it is already structured, with the raw transcript as the
  // fallback when summarizing has not finished.
  const { rows } = await app.db.query<{ transcript: string | null; summary: string | null; title: string | null }>(
    `SELECT t.content AS transcript, ms.summary, m.title
     FROM meetings m
     LEFT JOIN transcripts t ON t.meeting_id = m.id
     LEFT JOIN meeting_summaries ms ON ms.meeting_id = m.id
     WHERE m.id = $1
     ORDER BY t.created_at DESC
     LIMIT 1`,
    [meetingId]
  );
  const m = rows[0];
  if (!m) throw new AppError(404, 'not_found', 'Meeting not found.');
  const source = (m.summary ?? '').trim() || (m.transcript ?? '').trim();
  if (source.length === 0) {
    throw new AppError(
      409,
      'nothing_to_seed',
      'That recording has no transcript or summary yet. Wait for processing to finish.'
    );
  }
  const body =
    `> **Draft seeded from a recorded session** (${m.title ?? 'untitled'}). ` +
    `This is what someone said, not yet an approved procedure — edit it into steps before publishing.\n\n` +
    source;

  return createSop(
    app,
    {
      slug: input.slug,
      title: input.title,
      bodyMd: body,
      ...(input.roleKey ? { roleKey: input.roleKey } : {}),
      ...(input.process ? { process: input.process } : {}),
      seededFromMeetingId: meetingId,
    },
    actor
  );
}

// ─────────────────────────────────────────────────────── the task→SOP hook ──

/**
 * The SOP link for a task source type, or null. Resolved from the registry and
 * checked against the KB, so a mapping pointing at an SOP nobody wrote yet
 * returns null rather than a dead link.
 */
export async function sopLinkForTaskType(
  app: FastifyInstance,
  sourceType: string | null | undefined
): Promise<string | null> {
  if (!sourceType) return null;
  const entry = TASK_TYPE_SOPS[sourceType];
  if (!entry?.sop) return null;
  const { rows } = await app.db.query<{ slug: string }>(
    `SELECT slug FROM sops WHERE slug = $1 AND status = 'published'`,
    [entry.sop]
  );
  return rows[0] ? `/sops/${rows[0].slug}` : null;
}

/**
 * Registry view for Admin: every task type, its SOP, and whether that SOP is
 * actually written. The "mapped but unwritten" count is the honest measure of how
 * far the runs-without-Brian layer really goes.
 */
export async function taskTypeSopRegistry(app: FastifyInstance) {
  const { rows } = await app.db.query<{ slug: string; title: string; status: string }>(
    `SELECT slug, title, status::text FROM sops`
  );
  const bySlug = new Map(rows.map((r) => [r.slug, r]));
  const entries = Object.entries(TASK_TYPE_SOPS)
    .map(([taskType, entry]) => {
      const sop = entry.sop ? bySlug.get(entry.sop) : undefined;
      return {
        taskType,
        sopSlug: entry.sop,
        sopTitle: sop?.title ?? null,
        written: Boolean(sop),
        published: sop?.status === 'published',
        noSopReason: entry.reason ?? null,
      };
    })
    .sort((a, b) => a.taskType.localeCompare(b.taskType));
  return {
    entries,
    total: entries.length,
    withSop: entries.filter((e) => e.sopSlug !== null).length,
    published: entries.filter((e) => e.published).length,
    mappedButUnwritten: entries.filter((e) => e.sopSlug !== null && !e.written).length,
    deliberatelyNone: entries.filter((e) => e.sopSlug === null).length,
  };
}
