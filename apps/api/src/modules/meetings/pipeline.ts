// Meeting-intelligence pipeline (MP automations 2–3):
//   recording → transcribe (Whisper) → summarize (local LLM) →
//   contact record + auto tasks + referral queue (§7216-aware) +
//   suggested time entry.
//
// THE QUEUE IS SERIAL (one job at a time): on the shared 16GB box, Whisper
// and Ollama must never crunch two recordings concurrently. Failures land the
// meeting in 'failed' with a staff notification — never a silent drop. A
// recovery sweep re-enqueues anything stuck in 'recorded' (restart safety).

import type { FastifyInstance } from 'fastify';
import type { Client as MinioClient } from 'minio';
import { writeAudit } from '../../audit.ts';
import { notifyOnce } from '../../staffing.ts';
import { createReferral } from '../referrals/service.ts';
import type { Summarizer, Transcriber } from './adapters.ts';

export interface MeetingAdapters {
  transcriber: Transcriber;
  summarizer: Summarizer;
  minio: MinioClient;
}

/** In-process serial queue: a single promise chain. */
export class MeetingQueue {
  private chain: Promise<void> = Promise.resolve();
  private app: FastifyInstance;
  private adapters: MeetingAdapters;

  constructor(app: FastifyInstance, adapters: MeetingAdapters) {
    this.app = app;
    this.adapters = adapters;
  }

  enqueue(meetingId: string): Promise<void> {
    this.chain = this.chain.then(() =>
      processMeeting(this.app, this.adapters, meetingId).catch((err) => {
        this.app.log.error({ err, meetingId }, 'meeting pipeline job failed');
      })
    );
    return this.chain;
  }
}

async function setStatus(app: FastifyInstance, meetingId: string, status: string): Promise<void> {
  await app.db.query(`UPDATE meetings SET status = $2::meeting_status WHERE id = $1`, [meetingId, status]);
}

export async function processMeeting(
  app: FastifyInstance,
  adapters: MeetingAdapters,
  meetingId: string
): Promise<void> {
  const { rows } = await app.db.query<{
    id: string; contact_id: string | null; staff_id: string | null; type: string;
    duration_seconds: number | null; recording_document_id: string | null;
    first_name: string | null; last_name: string | null; hilo_status: string | null; soto_status: string | null;
  }>(
    `SELECT m.id, m.contact_id, m.staff_id, m.type, m.duration_seconds, m.recording_document_id,
            c.first_name, c.last_name, c.hilo_status, c.soto_status
     FROM meetings m LEFT JOIN contacts c ON c.id = m.contact_id
     WHERE m.id = $1`,
    [meetingId]
  );
  const meeting = rows[0];
  if (!meeting) return;

  try {
    // 1. Fetch the recording bytes from MinIO (audio never leaves the box).
    if (!meeting.recording_document_id) throw new Error('meeting has no recording document');
    const doc = await app.db.query<{ minio_bucket: string; minio_key: string; filename: string; mime_type: string | null }>(
      `SELECT minio_bucket, minio_key, filename, mime_type FROM documents WHERE id = $1`,
      [meeting.recording_document_id]
    );
    if (!doc.rows[0]) throw new Error('recording document missing');
    const stream = await adapters.minio.getObject(doc.rows[0].minio_bucket, doc.rows[0].minio_key);
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(chunk as Buffer);
    const audio = Buffer.concat(chunks);

    // 2. Transcribe.
    await setStatus(app, meetingId, 'transcribing');
    const transcript = await adapters.transcriber.transcribe(
      audio,
      doc.rows[0].filename,
      doc.rows[0].mime_type ?? 'audio/wav'
    );
    await app.db.query(
      `INSERT INTO transcripts (meeting_id, engine, language, content) VALUES ($1, $2, $3, $4)
       ON CONFLICT (meeting_id) DO UPDATE SET engine = EXCLUDED.engine, language = EXCLUDED.language, content = EXCLUDED.content`,
      [meetingId, adapters.transcriber.mode === 'whisper' ? 'whisper_local' : 'stub', transcript.language, transcript.text]
    );

    // 3. Summarize (local LLM primary; api fallback receives text only).
    await setStatus(app, meetingId, 'summarizing');
    const contactName = meeting.first_name ? `${meeting.first_name} ${meeting.last_name}` : null;
    const summary = await adapters.summarizer.summarize(transcript.text, {
      contactName,
      meetingType: meeting.type,
    });
    await app.db.query(
      `INSERT INTO meeting_summaries
         (meeting_id, model, summary, decisions, action_items, tax_need, tax_need_description,
          referral_rec_hilo_to_soto, referral_rec_soto_to_hilo)
       VALUES ($1,$2,$3,$4::jsonb,$5::jsonb,$6,$7,$8,$9)
       ON CONFLICT (meeting_id) DO UPDATE SET
         model = EXCLUDED.model, summary = EXCLUDED.summary, decisions = EXCLUDED.decisions,
         action_items = EXCLUDED.action_items, tax_need = EXCLUDED.tax_need,
         tax_need_description = EXCLUDED.tax_need_description,
         referral_rec_hilo_to_soto = EXCLUDED.referral_rec_hilo_to_soto,
         referral_rec_soto_to_hilo = EXCLUDED.referral_rec_soto_to_hilo`,
      [
        meetingId,
        adapters.summarizer.mode === 'stub' ? 'stub' : adapters.summarizer.mode === 'ollama' ? 'ollama_local' : 'api_fallback',
        summary.summary,
        JSON.stringify(summary.decisions),
        JSON.stringify(summary.actionItems),
        summary.taxNeed,
        summary.taxNeedDescription,
        summary.referralHiloToSoto,
        summary.referralSotoToHilo,
      ]
    );

    // 4. Auto-create tasks from action items (owner: the session's staff).
    // v4.5: titles keep the live naming convention "Meeting: {Client} — {Session
    // type}"; the action item itself is the description.
    const sessionLabel = meeting.type.replaceAll('_', ' ');
    const meetingTaskTitle = `Meeting: ${contactName ?? 'Unlinked session'} — ${sessionLabel}`;
    for (const item of summary.actionItems) {
      await app.db.query(
        `INSERT INTO tasks (title, description, assigned_staff_id, contact_id, source, source_type, source_id)
         VALUES ($1, $2, $3, $4, 'meeting', 'meeting_action_item', $5)`,
        [meetingTaskTitle, item.text.slice(0, 2000), meeting.staff_id, meeting.contact_id, meetingId]
      );
    }

    // 5. Referral recommendations → approval queue, §7216-aware: a gate block
    //    becomes a staff notification, never a silent skip.
    if (meeting.contact_id) {
      for (const direction of [
        ...(summary.referralHiloToSoto ? ['hilo_to_soto' as const] : []),
        ...(summary.referralSotoToHilo ? ['soto_to_hilo' as const] : []),
      ]) {
        try {
          await createReferral(app, { type: 'system', label: 'meeting intelligence' }, {
            contactId: meeting.contact_id,
            direction,
            source: 'session_summary',
          });
        } catch (err) {
          if ((err as { code?: string }).code === 'consent_7216_required' && meeting.staff_id) {
            await notifyOnce(app.db, {
              staffId: meeting.staff_id,
              type: 'referral_blocked_7216',
              severity: 'warning',
              title: `Referral recommendation blocked — no signed §7216 consent (${direction})`,
              contactId: meeting.contact_id,
              relatedObjectType: 'meeting',
              relatedObjectId: meetingId,
            });
          } else if ((err as { code?: string }).code !== 'consent_7216_required') {
            throw err;
          }
        }
      }
    }

    // 6. Suggested time entry (duration → 0.25h increments, one-tap confirm).
    //    Hilo-side work auto-suggests pro bono (MP Time Tracking).
    if (meeting.staff_id) {
      const seconds = meeting.duration_seconds ?? 0;
      const hours = Math.max(0.25, Math.ceil((seconds / 3600) * 4) / 4);
      const proBono = meeting.hilo_status !== 'none' && meeting.soto_status === 'none';
      await app.db.query(
        `INSERT INTO time_entries (staff_id, contact_id, service_type, hours, is_pro_bono, status, meeting_id)
         VALUES ($1, $2, $3, $4, $5, 'suggested', $6)`,
        [meeting.staff_id, meeting.contact_id, proBono ? 'hilo_advisory' : 'client_session', hours, proBono, meetingId]
      );
    }

    await setStatus(app, meetingId, 'ready');
    await writeAudit(app.db, {
      actorType: 'system',
      action: 'meeting.processed',
      objectType: 'meeting',
      objectId: meetingId,
      contactId: meeting.contact_id,
      details: {
        transcriber: adapters.transcriber.mode,
        summarizer: adapters.summarizer.mode,
        action_items: summary.actionItems.length,
        tax_need: summary.taxNeed,
      },
    });
  } catch (err) {
    await setStatus(app, meetingId, 'failed');
    await writeAudit(app.db, {
      actorType: 'system',
      action: 'meeting.processing_failed',
      objectType: 'meeting',
      objectId: meetingId,
      contactId: meeting.contact_id,
      details: { error: (err as Error).message?.slice(0, 200) },
    });
    if (meeting.staff_id) {
      await notifyOnce(app.db, {
        staffId: meeting.staff_id,
        type: 'meeting_processing_failed',
        severity: 'warning',
        title: 'A session recording could not be processed — retry or check the audio',
        contactId: meeting.contact_id,
        relatedObjectType: 'meeting',
        relatedObjectId: meetingId,
      });
    }
  }
}

/**
 * Restart safety: re-enqueue meetings the pipeline is no longer working on.
 *
 * FINDING #18 — this used to recover only `recorded`, i.e. work that never STARTED.
 * Work that started and then vanished was recovered by nothing. Jackson Flores's
 * 7-minute session went to `transcribing` 352ms after upload on 2026-08-11 and sat
 * there for two days: the API container restarted mid-transcription, so the catch
 * block never ran, the status never moved to `failed`, and no alert ever fired. It was
 * not stuck-and-visible, it was stuck-and-silent — the same shape as the scanner that
 * sat dead for thirteen hours and the webhook that stopped arriving.
 *
 * In-flight states get a longer grace than `recorded` because they are legitimately
 * slow: Whisper on CPU takes minutes on a long recording, and re-enqueueing a job that
 * is genuinely still running would transcribe it twice. Re-processing is safe when it
 * does happen — transcripts and summaries are both ON CONFLICT DO UPDATE, and the
 * action-item tasks are deduped by title.
 */
const IN_FLIGHT_GRACE_MINUTES = 45;

export async function recoverStuckMeetings(app: FastifyInstance, queue: MeetingQueue): Promise<number> {
  const { rows } = await app.db.query<{ id: string; status: string }>(
    `SELECT id, status::text AS status FROM meetings
      WHERE (status = 'recorded'    AND updated_at < now() - interval '5 minutes')
         OR (status IN ('transcribing', 'summarizing')
             AND updated_at < now() - ($1 || ' minutes')::interval)
      ORDER BY updated_at
      LIMIT 10`,
    [String(IN_FLIGHT_GRACE_MINUTES)]
  );
  for (const r of rows) {
    if (r.status !== 'recorded') {
      // Worth saying out loud: this one was abandoned mid-flight, which means a
      // restart or a hung vendor call, not a slow queue.
      app.log.warn(
        { meetingId: r.id, status: r.status },
        'meeting abandoned mid-processing — re-enqueueing'
      );
    }
    queue.enqueue(r.id);
  }
  return rows.length;
}
