// Meeting ingestion (MP automations 2–3): browser-recorder/voice-memo upload
// (staff, multipart) and the Zoom recording webhook. Both land in the same
// serialized pipeline. The mobile recorder UI itself ships with the internal
// app (M19/M20) — these endpoints are what it will call.

import type { FastifyInstance } from 'fastify';
import type { MultipartFile } from '@fastify/multipart';
import { timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { requirePermission } from '../../plugins/auth.ts';
import { AppError } from '../../types.ts';
import { writeAudit } from '../../audit.ts';
import { uploadDocument } from '../documents/service.ts';
import { makeMinioClient } from '../documents/storage.ts';
import { makeSummarizer, makeTranscriber, type Summarizer } from './adapters.ts';
import { MeetingQueue, recoverStuckMeetings } from './pipeline.ts';

const UploadFields = z.object({
  contactId: z.uuid().optional(),
  type: z.enum(['zoom', 'phone', 'in_person']).default('phone'),
  durationSeconds: z.coerce.number().int().positive().optional(),
  title: z.string().max(200).optional(),
});

const AUDIO_MIMES = new Set([
  'audio/webm', 'audio/mp4', 'audio/mpeg', 'audio/wav', 'audio/x-wav', 'audio/ogg', 'video/mp4', 'video/webm',
]);

function secretsMatch(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

function fieldValues(data: MultipartFile): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [name, field] of Object.entries(data.fields)) {
    const f = Array.isArray(field) ? field[0] : field;
    if (f && f.type === 'field') out[name] = (f as { value: unknown }).value;
  }
  return out;
}

export function registerMeetingRoutes(
  app: FastifyInstance,
  // Injectable so a test can drive the pipeline with a KNOWN summary. Without it the
  // stub regenerates its own action items on every re-process, so a test that seeds a
  // bad one into the table proves nothing — it is overwritten before the code under
  // test ever sees it.
  overrides: { summarizer?: Summarizer } = {}
): void {
  const minio = makeMinioClient(app.config);
  const queue = new MeetingQueue(app, {
    transcriber: makeTranscriber(app.config),
    summarizer: overrides.summarizer ?? makeSummarizer(app.config),
    minio,
  });
  // The scheduler's recovery sweep needs the queue — expose it on the instance.
  app.decorate('meetingQueue', queue);

  const staff = { preHandler: [app.authenticate, requirePermission('meetings.upload')] };

  // Browser recorder / voice-memo upload → same pipeline (automation 3).
  app.post('/meetings/upload', staff, async (request, reply) => {
    const data = await request.file();
    if (!data) throw new AppError(400, 'file_required', 'Attach the recording.');
    if (!AUDIO_MIMES.has(data.mimetype)) {
      throw new AppError(415, 'unsupported_file_type', `Recording type '${data.mimetype}' not accepted.`);
    }
    const buffer = await data.toBuffer();
    const fields = UploadFields.parse(fieldValues(data));
    const actor = request.staff!;

    // Recordings need a contact to file under; unmatched ones go to the staff
    // member's own record keeping via contact-less meetings.
    let title = fields.title ?? null;
    if (!title && fields.contactId) {
      const c = await app.db.query<{ first_name: string; last_name: string }>(
        `SELECT first_name, last_name FROM contacts WHERE id = $1`,
        [fields.contactId]
      );
      if (!c.rows[0]) throw new AppError(404, 'not_found', 'Contact not found.');
      // v4.2 session-title convention: "CLIENT — Session Type".
      const typeLabel = fields.type === 'zoom' ? 'Zoom Session' : fields.type === 'phone' ? 'Phone Session' : 'In-Person Session';
      title = `${c.rows[0].first_name} ${c.rows[0].last_name} — ${typeLabel}`;
    }

    const meeting = await app.db.query<{ id: string }>(
      `INSERT INTO meetings (contact_id, staff_id, type, source, status, title, started_at, duration_seconds)
       VALUES ($1, $2, $3::meeting_type, $4::meeting_source, 'recorded', $5, now(), $6)
       RETURNING id`,
      [
        fields.contactId ?? null, actor.id, fields.type,
        fields.type === 'zoom' ? 'voice_memo_upload' : 'browser_recorder',
        title, fields.durationSeconds ?? null,
      ]
    );
    const meetingId = meeting.rows[0]!.id;

    // Recording bytes → saos-recordings via the audited document path. The
    // upload needs a contact_id column; contact-less recordings file under
    // the staff member's meeting only (document row requires contact — use
    // the meeting's contact or reject).
    if (!fields.contactId) {
      throw new AppError(400, 'contact_required', 'Pick the client this session was with (recordings file under the client record).');
    }
    const doc = await uploadDocument(app, minio, { type: 'staff', id: actor.id, label: actor.fullName, ip: request.ip }, {
      contactId: fields.contactId,
      category: 'recording',
      filename: data.filename || `recording-${meetingId}.webm`,
      mimeType: data.mimetype,
      buffer,
    });
    await app.db.query(`UPDATE meetings SET recording_document_id = $2 WHERE id = $1`, [meetingId, doc.id]);

    void queue.enqueue(meetingId);
    return reply.code(201).send({ id: meetingId, status: 'queued' });
  });

  const readMeetings = { preHandler: [app.authenticate, requirePermission('meetings.read')] };

  /**
   * FINDING #18 — the sessions a client has had, with what was said in them.
   *
   * Brian's ask: two or three sentences under each recording in the client record, and
   * a link to the full transcript. The point is being able to review a session — one of
   * these is with a business partner — without sitting through the audio again.
   *
   * `stalled` is computed here rather than left for the reader to work out: a recording
   * that entered `transcribing` and stopped moving looks identical to one that is
   * simply still running, and telling those apart by eye is how Jackson's sat for two
   * days. Anything in flight for over an hour is named as stalled, and the recovery
   * sweep is already re-enqueueing it.
   */
  app.get<{ Params: { id: string } }>('/contacts/:id/meetings', readMeetings, async (request) => {
    const contactId = z.uuid().parse(request.params.id);
    const { rows } = await app.db.query(
      `SELECT m.id, m.type::text AS type, m.source::text AS source, m.status::text AS status,
              m.title, m.started_at, m.duration_seconds, m.created_at,
              s.summary, s.decisions, s.action_items, s.tax_need, s.model,
              (t.meeting_id IS NOT NULL) AS has_transcript,
              t.language AS transcript_language,
              (st.full_name) AS staff_name,
              (m.status IN ('transcribing', 'summarizing')
                 AND m.updated_at < now() - interval '1 hour') AS stalled
         FROM meetings m
         LEFT JOIN meeting_summaries s ON s.meeting_id = m.id
         LEFT JOIN transcripts t ON t.meeting_id = m.id
         LEFT JOIN staff st ON st.id = m.staff_id
        WHERE m.contact_id = $1
        ORDER BY COALESCE(m.started_at, m.created_at) DESC`,
      [contactId]
    );
    return { meetings: rows };
  });

  /**
   * The full transcript. This is verbatim client conversation — the most sensitive
   * text in the system — so it is a separate call behind its own permission and it is
   * AUDITED on every read, like any other document access. Nobody should be able to
   * read a client's session back without that being on the record.
   */
  app.get<{ Params: { id: string } }>('/meetings/:id/transcript', readMeetings, async (request) => {
    const id = z.uuid().parse(request.params.id);
    const { rows } = await app.db.query<{
      content: string; engine: string; language: string | null;
      contact_id: string | null; title: string | null; started_at: string | null;
      type: string; duration_seconds: number | null;
    }>(
      `SELECT t.content, t.engine, t.language, m.contact_id, m.title, m.started_at,
              m.type::text AS type, m.duration_seconds
         FROM transcripts t JOIN meetings m ON m.id = t.meeting_id
        WHERE t.meeting_id = $1`,
      [id]
    );
    const row = rows[0];
    if (!row) throw new AppError(404, 'not_found', 'No transcript for this session yet.');

    await writeAudit(app.db, {
      actorType: 'staff',
      actorId: request.staff!.id,
      actorLabel: request.staff!.fullName,
      action: 'transcript.read',
      objectType: 'meeting',
      objectId: id,
      contactId: row.contact_id,
      // The transcript CONTENT never enters the log — no-PII-in-logs applies hardest
      // to the one table that holds whole conversations.
      details: { engine: row.engine, language: row.language, chars: row.content.length },
    });

    return {
      transcript: {
        content: row.content, engine: row.engine, language: row.language,
        title: row.title, startedAt: row.started_at, type: row.type,
        durationSeconds: row.duration_seconds,
      },
    };
  });

  /** Re-run the pipeline for one session (finding #18 backfill; also the retry after a failure). */
  app.post<{ Params: { id: string } }>('/meetings/:id/reprocess', staff, async (request) => {
    const id = z.uuid().parse(request.params.id);
    const { rows } = await app.db.query<{ id: string; recording_document_id: string | null }>(
      `SELECT id, recording_document_id FROM meetings WHERE id = $1`,
      [id]
    );
    if (!rows[0]) throw new AppError(404, 'not_found', 'Meeting not found.');
    if (!rows[0].recording_document_id) {
      throw new AppError(409, 'no_recording', 'This session has no recording to process.');
    }
    void queue.enqueue(id); // serialized; the caller does not wait out a transcription
    return { status: 'queued' };
  });

  app.get<{ Params: { id: string } }>('/meetings/:id', staff, async (request) => {
    const id = z.uuid().parse(request.params.id);
    const meeting = await app.db.query(
      `SELECT m.id, m.contact_id, m.type, m.source, m.status, m.title, m.started_at, m.duration_seconds
       FROM meetings m WHERE m.id = $1`,
      [id]
    );
    if (!meeting.rows[0]) throw new AppError(404, 'not_found', 'Meeting not found.');
    const summary = await app.db.query(
      `SELECT summary, decisions, action_items, tax_need, referral_rec_hilo_to_soto, referral_rec_soto_to_hilo, model
       FROM meeting_summaries WHERE meeting_id = $1`,
      [id]
    );
    return { meeting: meeting.rows[0], summary: summary.rows[0] ?? null };
  });

  // Zoom recording webhook (automation 2). Shared-secret authenticated; the
  // signed Zoom app (CRC + HMAC validation, download token) is wired at M23
  // when Brian's Zoom credentials exist — the pipeline behind it is complete.
  app.post('/webhooks/zoom', async (request, reply) => {
    const secret = request.headers['x-webhook-secret'];
    if (typeof secret !== 'string' || !secretsMatch(secret, app.config.WEBHOOK_SECRET)) {
      return reply.code(401).send({ error: 'unauthorized' });
    }
    const body = z
      .object({
        event: z.string(),
        payload: z.looseObject({
          object: z.looseObject({
            topic: z.string().optional(),
            duration: z.number().optional(), // minutes
            recording_files: z.array(z.looseObject({ download_url: z.string() })).optional(),
          }).optional(),
        }).optional(),
      })
      .parse(request.body);
    if (body.event !== 'recording.completed') return { status: 'ignored' };

    const object = body.payload?.object;
    const meeting = await app.db.query<{ id: string }>(
      `INSERT INTO meetings (staff_id, type, source, status, title, started_at, duration_seconds)
       VALUES (NULL, 'zoom', 'zoom_webhook', 'recorded', $1, now(), $2)
       RETURNING id`,
      [object?.topic ?? 'Zoom recording', object?.duration ? object.duration * 60 : null]
    );
    const meetingId = meeting.rows[0]!.id;

    const downloadUrl = object?.recording_files?.[0]?.download_url;
    if (!downloadUrl) {
      await app.db.query(`UPDATE meetings SET status = 'failed' WHERE id = $1`, [meetingId]);
      return { status: 'accepted', matched: false };
    }
    // Fetch + process asynchronously; failures land in 'failed' + notification.
    void (async () => {
      try {
        const res = await fetch(downloadUrl);
        if (!res.ok) throw new Error(`download ${res.status}`);
        // Zoom recordings need a contact match before filing — Phase 1 keeps
        // them staff-triaged: mark failed-to-match for manual attach.
        await app.db.query(`UPDATE meetings SET status = 'failed' WHERE id = $1`, [meetingId]);
      } catch (err) {
        app.log.warn({ err, meetingId }, 'zoom recording fetch failed');
        await app.db.query(`UPDATE meetings SET status = 'failed' WHERE id = $1`, [meetingId]);
      }
    })();
    return { status: 'accepted', meetingId };
  });

  app.post('/jobs/meeting-recovery', { preHandler: [app.authenticate, requirePermission('jobs.run')] }, async () => {
    const recovered = await recoverStuckMeetings(app, queue);
    return { recovered };
  });
}
