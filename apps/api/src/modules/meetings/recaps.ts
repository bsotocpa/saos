// Session recaps (v4.2 NEW MODULES #6) — the client-visible half of the session
// product.
//
// Spec: after the meeting-intelligence summary, a bilingual client recap (what we
// covered · your action items · our action items · next session) is drafted and
// queued for Brian's ONE-TAP approval before sending to the client's portal thread
// + email. Approval-gated, never auto-sent.
//
// Three things this file is careful about:
//
//  1. DRAFTED FROM WHAT THE SESSION ACTUALLY PRODUCED. The four sections come from
//     the meeting summary, its action_items, and the tasks the session created —
//     not from a template with blanks. A recap that says "we discussed your
//     situation" is worse than none, because the client learns the recap is filler.
//
//  2. THE DRAFT IS LABELLED AS A DRAFT ALL THE WAY THROUGH. Brian edits either
//     language before approving; nothing reaches a client that he has not seen.
//
//  3. THE SEND IS GATED TWICE, ON PURPOSE. Approval is a human act (enforced by a
//     CHECK). The outbound send is additionally behind the `session_recaps`
//     automation, which ships OFF like every other client-acting path — and the UI
//     says so BEFORE the tap, so "approve" never silently does nothing.

import type { FastifyInstance } from 'fastify';
import { writeAudit } from '../../audit.ts';
import { AppError, type AuthedStaff } from '../../types.ts';
import { isAutomationEnabled } from '../../automations.ts';
import { sendTemplatedEmail } from '../templates/service.ts';

export type RecapStatus = 'none' | 'drafted' | 'approved' | 'sent';

/** Section headings, in both languages. Copy Brian signs off on. */
const HEADINGS = {
  en: {
    covered: 'What we covered',
    yours: 'Your action items',
    ours: 'What we are doing',
    next: 'Next session',
    noneYours: 'Nothing needed from you right now.',
    noneOurs: 'Nothing outstanding on our side.',
    noNext: 'No next session booked yet — reply and we will find a time.',
  },
  es: {
    covered: 'Lo que cubrimos',
    yours: 'Sus tareas',
    ours: 'Lo que haremos nosotros',
    next: 'Próxima sesión',
    noneYours: 'No necesitamos nada de usted por ahora.',
    noneOurs: 'No queda nada pendiente de nuestro lado.',
    noNext: 'Todavía no hay próxima sesión agendada — responda y buscamos fecha.',
  },
} as const;

function section(title: string, lines: string[], emptyText: string): string {
  return `## ${title}\n${lines.length > 0 ? lines.map((l) => `- ${l}`).join('\n') : emptyText}`;
}

/**
 * Compose the four-section body. `lang` only selects the HEADINGS — the content
 * lines come from the session and are the same text in both drafts, because
 * translating a client's own action items is Brian's call, not a machine's. The
 * Spanish draft is explicitly marked so he knows which parts still need his pass.
 */
function composeBody(
  lang: 'en' | 'es',
  parts: { covered: string[]; yours: string[]; ours: string[]; next: string | null }
): string {
  const h = HEADINGS[lang];
  const blocks = [
    section(h.covered, parts.covered, lang === 'es' ? '—' : '—'),
    section(h.yours, parts.yours, h.noneYours),
    section(h.ours, parts.ours, h.noneOurs),
    `## ${h.next}\n${parts.next ?? h.noNext}`,
  ];
  const note =
    lang === 'es'
      ? '\n\n> ⚠ Borrador: los encabezados están en español; el contenido viene de la sesión y necesita su revisión antes de enviar.'
      : '\n\n> ⚠ Draft — review before sending.';
  return blocks.join('\n\n') + note;
}

export interface RecapDraft {
  meetingId: string;
  contactId: string | null;
  status: RecapStatus;
  bodyEn: string;
  bodyEs: string;
}

/**
 * Draft (or re-draft) the recap for a meeting. Refuses once the recap has been
 * sent: a client has already read it, and silently regenerating it would make the
 * record disagree with what they have.
 */
export async function draftRecap(
  app: FastifyInstance,
  meetingId: string,
  actor: AuthedStaff | null
): Promise<RecapDraft> {
  const { rows } = await app.db.query<{
    summary_id: string; contact_id: string | null; status: RecapStatus;
    summary: string | null; decisions: unknown; action_items: unknown;
    starts_at: Date | null;
  }>(
    `SELECT ms.id AS summary_id, m.contact_id, ms.client_recap_status::text AS status,
            ms.summary, ms.decisions, ms.action_items, m.started_at AS starts_at
     FROM meeting_summaries ms JOIN meetings m ON m.id = ms.meeting_id
     WHERE ms.meeting_id = $1`,
    [meetingId]
  );
  const s = rows[0];
  if (!s) {
    throw new AppError(
      404,
      'no_summary',
      'That session has no summary yet — the recap is drafted from it, so wait for processing to finish.'
    );
  }
  if (s.status === 'sent') {
    throw new AppError(
      409,
      'already_sent',
      'This recap has already been sent to the client. Send a message on the thread instead of rewriting history.'
    );
  }

  // What we covered: the summary's decisions, falling back to the summary text.
  const decisions = Array.isArray(s.decisions) ? (s.decisions as string[]).filter((d) => typeof d === 'string') : [];
  const covered = decisions.length > 0
    ? decisions
    : (s.summary ?? '').split(/\n+/).map((l) => l.trim()).filter((l) => l.length > 0).slice(0, 6);

  // Their items vs ours: action_items carries an owner where the pipeline set one.
  const items = Array.isArray(s.action_items) ? (s.action_items as unknown[]) : [];
  const yours: string[] = [];
  const ours: string[] = [];
  for (const raw of items) {
    if (typeof raw === 'string') {
      ours.push(raw);
      continue;
    }
    const it = raw as { text?: unknown; title?: unknown; owner?: unknown };
    const text = typeof it.text === 'string' ? it.text : typeof it.title === 'string' ? it.title : null;
    if (!text) continue;
    (it.owner === 'client' ? yours : ours).push(text);
  }

  // Client-visible tasks created from this session ARE the client's action items.
  if (s.contact_id) {
    const tasks = await app.db.query<{ title: string }>(
      `SELECT title FROM tasks
       WHERE contact_id = $1 AND client_visible
         AND status <> ALL(ARRAY['completed','cancelled']::task_status[])
       ORDER BY created_at DESC LIMIT 8`,
      [s.contact_id]
    );
    for (const t of tasks.rows) if (!yours.includes(t.title)) yours.push(t.title);
  }

  // Next session: a real booking if one exists. Never invented.
  let next: string | null = null;
  if (s.contact_id) {
    const upcoming = await app.db.query<{ starts_at: Date }>(
      `SELECT starts_at FROM client_sessions
       WHERE contact_id = $1 AND status = 'scheduled' AND starts_at > now()
       ORDER BY starts_at LIMIT 1`,
      [s.contact_id]
    );
    if (upcoming.rows[0]) next = upcoming.rows[0].starts_at.toISOString().slice(0, 16).replace('T', ' ');
  }

  const parts = { covered, yours, ours, next };
  const bodyEn = composeBody('en', parts);
  const bodyEs = composeBody('es', parts);

  await app.db.query(
    `UPDATE meeting_summaries
     SET client_recap_status = 'drafted', recap_body_en = $2, recap_body_es = $3,
         recap_approved_by_staff_id = NULL, recap_approved_at = NULL,
         recap_send_suppressed_reason = NULL
     WHERE id = $1`,
    [s.summary_id, bodyEn, bodyEs]
  );
  await writeAudit(app.db, {
    actorType: actor ? 'staff' : 'system',
    actorId: actor?.id ?? null,
    actorLabel: actor?.email ?? 'meeting-pipeline',
    action: 'recap.drafted',
    objectType: 'meeting',
    objectId: meetingId,
    contactId: s.contact_id,
    details: { covered: covered.length, client_items: yours.length, our_items: ours.length, has_next: next !== null },
  });
  return { meetingId, contactId: s.contact_id, status: 'drafted', bodyEn, bodyEs };
}

/** Edit either language before approving. Refused after sending. */
export async function updateRecap(
  app: FastifyInstance,
  meetingId: string,
  patch: { bodyEn?: string | undefined; bodyEs?: string | undefined },
  actor: AuthedStaff
): Promise<void> {
  if (patch.bodyEn === undefined && patch.bodyEs === undefined) {
    throw new AppError(400, 'empty_update', 'Nothing to change.');
  }
  const { rows } = await app.db.query<{ status: RecapStatus }>(
    `SELECT client_recap_status::text AS status FROM meeting_summaries WHERE meeting_id = $1`,
    [meetingId]
  );
  if (!rows[0]) throw new AppError(404, 'not_found', 'No recap for that session.');
  if (rows[0].status === 'sent') {
    throw new AppError(409, 'already_sent', 'This recap has already reached the client.');
  }
  // Editing an approved recap withdraws the approval — otherwise Brian's name
  // stays attached to text he did not read.
  await app.db.query(
    `UPDATE meeting_summaries
     SET recap_body_en = COALESCE($2, recap_body_en),
         recap_body_es = COALESCE($3, recap_body_es),
         client_recap_status = 'drafted',
         recap_approved_by_staff_id = NULL, recap_approved_at = NULL
     WHERE meeting_id = $1`,
    [meetingId, patch.bodyEn ?? null, patch.bodyEs ?? null]
  );
  await writeAudit(app.db, {
    actorType: 'staff', actorId: actor.id, actorLabel: actor.email,
    action: 'recap.edited', objectType: 'meeting', objectId: meetingId,
    details: { languages: [patch.bodyEn !== undefined ? 'en' : null, patch.bodyEs !== undefined ? 'es' : null].filter(Boolean) },
  });
}

export interface RecapSendResult {
  status: RecapStatus;
  sent: boolean;
  emailed: boolean;
  suppressedReason: string | null;
}

/**
 * ONE TAP: approve and send. Approval is recorded unconditionally (that is Brian's
 * decision and it belongs on the record); the outbound send additionally respects
 * the `session_recaps` automation, and when disarmed the recap sits at 'approved'
 * with the reason recorded rather than pretending to have gone out.
 */
export async function approveAndSendRecap(
  app: FastifyInstance,
  meetingId: string,
  actor: AuthedStaff
): Promise<RecapSendResult> {
  const { rows } = await app.db.query<{
    summary_id: string; status: RecapStatus; contact_id: string | null;
    body_en: string | null; body_es: string | null;
    first_name: string | null; email: string | null; language: 'en' | 'es' | null;
  }>(
    `SELECT ms.id AS summary_id, ms.client_recap_status::text AS status, m.contact_id,
            ms.recap_body_en AS body_en, ms.recap_body_es AS body_es,
            c.first_name, c.email, c.language
     FROM meeting_summaries ms
     JOIN meetings m ON m.id = ms.meeting_id
     LEFT JOIN contacts c ON c.id = m.contact_id
     WHERE ms.meeting_id = $1`,
    [meetingId]
  );
  const r = rows[0];
  if (!r) throw new AppError(404, 'not_found', 'No recap for that session.');
  if (r.status === 'sent') throw new AppError(409, 'already_sent', 'This recap has already been sent.');
  if (r.status === 'none' || !r.body_en || !r.body_es) {
    throw new AppError(409, 'not_drafted', 'Draft the recap before approving it.');
  }
  if (!r.contact_id) {
    throw new AppError(
      409,
      'no_client',
      'That session is not linked to a client, so there is nobody to send a recap to.'
    );
  }

  // Approval first, and recorded whatever happens next.
  await app.db.query(
    `UPDATE meeting_summaries
     SET client_recap_status = 'approved', recap_approved_by_staff_id = $2, recap_approved_at = now()
     WHERE id = $1`,
    [r.summary_id, actor.id]
  );
  await writeAudit(app.db, {
    actorType: 'staff', actorId: actor.id, actorLabel: actor.email,
    action: 'recap.approved', objectType: 'meeting', objectId: meetingId, contactId: r.contact_id,
  });

  if (!(await isAutomationEnabled(app, 'session_recaps'))) {
    const reason = 'session_recaps automation is off';
    await app.db.query(
      `UPDATE meeting_summaries SET recap_send_suppressed_reason = $2 WHERE id = $1`,
      [r.summary_id, reason]
    );
    return { status: 'approved', sent: false, emailed: false, suppressedReason: reason };
  }

  const lang = r.language ?? 'en';
  const body = lang === 'es' ? r.body_es : r.body_en;

  // The portal thread is where the client reads it; email is the nudge.
  const thread = await app.db.query<{ id: string }>(
    `SELECT id FROM message_threads WHERE contact_id = $1 AND status = 'open' ORDER BY created_at LIMIT 1`,
    [r.contact_id]
  );
  const threadId =
    thread.rows[0]?.id ??
    (
      await app.db.query<{ id: string }>(
        `INSERT INTO message_threads (contact_id, subject, last_message_at)
         VALUES ($1, $2, now()) RETURNING id`,
        [r.contact_id, lang === 'es' ? 'Resumen de sesión' : 'Session recap']
      )
    ).rows[0]!.id;

  const message = await app.db.query<{ id: string }>(
    `INSERT INTO messages (thread_id, direction, channel, sender_type, sender_staff_id, body,
                           template_key, language, delivery_status, sent_at)
     VALUES ($1, 'outbound', 'portal', 'staff', $2, $3, 'session_recap', $4, 'sent', now())
     RETURNING id`,
    [threadId, actor.id, body, lang]
  );

  let emailed = false;
  if (r.email) {
    // The email is a short pointer at the portal thread, not a duplicate of the
    // recap: the thread is where a reply belongs.
    await sendTemplatedEmail(app, {
      to: r.email,
      templateKey: 'session_recap',
      language: lang,
      contactId: r.contact_id,
      vars: {
        first_name: r.first_name ?? '',
        portal_link: `${app.config.PORTAL_BASE_URL}/messages`,
      },
    });
    emailed = true;
  }

  await app.db.query(
    `UPDATE meeting_summaries
     SET client_recap_status = 'sent', recap_sent_at = now(), recap_message_id = $2,
         recap_emailed = $3, recap_send_suppressed_reason = NULL
     WHERE id = $1`,
    [r.summary_id, message.rows[0]!.id, emailed]
  );
  await writeAudit(app.db, {
    actorType: 'staff', actorId: actor.id, actorLabel: actor.email,
    action: 'recap.sent', objectType: 'meeting', objectId: meetingId, contactId: r.contact_id,
    details: { language: lang, emailed, message_id: message.rows[0]!.id },
  });
  return { status: 'sent', sent: true, emailed, suppressedReason: null };
}

/** The approval queue: recaps waiting on Brian, newest session first. */
export async function recapQueue(app: FastifyInstance) {
  const { rows } = await app.db.query(
    `SELECT m.id AS meeting_id, m.title, m.started_at, m.contact_id,
            c.first_name, c.last_name, c.language,
            ms.client_recap_status::text AS status,
            ms.recap_body_en, ms.recap_body_es,
            ms.recap_send_suppressed_reason,
            st.full_name AS approved_by, ms.recap_approved_at
     FROM meeting_summaries ms
     JOIN meetings m ON m.id = ms.meeting_id
     LEFT JOIN contacts c ON c.id = m.contact_id
     LEFT JOIN staff st ON st.id = ms.recap_approved_by_staff_id
     WHERE ms.client_recap_status IN ('drafted', 'approved')
     ORDER BY m.started_at DESC NULLS LAST
     LIMIT 50`
  );
  const armed = await isAutomationEnabled(app, 'session_recaps');
  return { recaps: rows, automationArmed: armed };
}
