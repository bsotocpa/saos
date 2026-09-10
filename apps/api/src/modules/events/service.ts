// Hilo events (M27) — the Eventbrite replacement.
//
// The registration path is the interesting part. Capacity is held by a partial
// unique index on (event_id, seat_number), so this does NOT count rows and then
// insert: it claims the next free seat and lets the database arbitrate. Two people
// racing for the last seat at a popular workshop is the normal case, not an edge
// case, and a read-then-write would oversell it. The loser of the race becomes a
// waitlist placement rather than an error.
//
// Everything client-facing here is bilingual, and the SMS reminder carries its own
// TCPA opt-in captured at registration — a workshop signup is not consent to be
// texted about anything else.

import type { FastifyInstance } from 'fastify';
import { writeAudit } from '../../audit.ts';
import { AppError, type AuthedStaff } from '../../types.ts';
import { isAutomationEnabled } from '../../automations.ts';
import { ownerForRole } from '../../staffing.ts';
import { createTask } from '../tasks/service.ts';
import { sendSms } from '../comms/send-sms.ts';

export interface EventInput {
  slug: string;
  titleEn: string;
  titleEs: string;
  descriptionEn: string;
  descriptionEs: string;
  startsAt: string;
  endsAt?: string | null | undefined;
  capacity: number;
  location?: string | null | undefined;
  isVirtual?: boolean | undefined;
  program?: string | null | undefined;
}

export async function createEvent(
  app: FastifyInstance,
  input: EventInput,
  actor: AuthedStaff
): Promise<{ id: string; slug: string }> {
  const { rows } = await app.db.query<{ id: string }>(
    `INSERT INTO events (slug, title_en, title_es, description_en, description_es, location, is_virtual,
                         starts_at, ends_at, capacity, program, created_by_staff_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
     ON CONFLICT (slug) DO NOTHING RETURNING id`,
    [
      input.slug, input.titleEn, input.titleEs, input.descriptionEn, input.descriptionEs,
      input.location ?? null, input.isVirtual ?? false, input.startsAt, input.endsAt ?? null,
      input.capacity, input.program ?? null, actor.id,
    ]
  );
  if (!rows[0]) throw new AppError(409, 'slug_taken', `An event with slug '${input.slug}' already exists.`);
  await writeAudit(app.db, {
    actorType: 'staff', actorId: actor.id, actorLabel: actor.fullName,
    action: 'event.created', objectType: 'event', objectId: rows[0].id,
    details: { slug: input.slug, capacity: input.capacity },
  });
  return { id: rows[0].id, slug: input.slug };
}

export async function publishEvent(app: FastifyInstance, slug: string, actor: AuthedStaff): Promise<void> {
  const { rowCount } = await app.db.query(
    `UPDATE events SET status = 'published', published_at = now()
     WHERE slug = $1 AND status = 'draft'`,
    [slug]
  );
  if ((rowCount ?? 0) === 0) throw new AppError(409, 'not_draft', 'Only a draft event can be published.');
  await writeAudit(app.db, {
    actorType: 'staff', actorId: actor.id, actorLabel: actor.fullName,
    action: 'event.published', objectType: 'event', objectId: slug,
  });
}

/** The public event page: bilingual copy plus honest seat availability. */
export async function publicEvent(app: FastifyInstance, slug: string) {
  const { rows } = await app.db.query<{
    id: string; slug: string; title_en: string; title_es: string;
    description_en: string; description_es: string; location: string | null;
    is_virtual: boolean; starts_at: Date; ends_at: Date | null; capacity: number;
    status: string; confirmed: number; waitlisted: number;
  }>(
    `SELECT e.id, e.slug, e.title_en, e.title_es, e.description_en, e.description_es,
            e.location, e.is_virtual, e.starts_at, e.ends_at, e.capacity, e.status::text,
            (SELECT count(*)::int FROM event_registrations r
             WHERE r.event_id = e.id AND r.status IN ('confirmed', 'attended')) AS confirmed,
            (SELECT count(*)::int FROM event_registrations r
             WHERE r.event_id = e.id AND r.status = 'waitlisted') AS waitlisted
     FROM events e WHERE e.slug = $1`,
    [slug]
  );
  const e = rows[0];
  if (!e || e.status === 'draft') throw new AppError(404, 'not_found', 'Event not found.');
  return {
    event: e,
    seatsLeft: Math.max(0, e.capacity - e.confirmed),
    full: e.confirmed >= e.capacity,
    cancelled: e.status === 'cancelled',
  };
}

export interface RegistrationInput {
  firstName: string;
  lastName: string;
  email: string;
  phone?: string | null | undefined;
  language?: 'en' | 'es' | undefined;
  smsOptIn?: boolean | undefined;
}

/**
 * Register for an event. Claims the lowest free seat; on a seat collision (two
 * people racing) or a full house, the registrant is WAITLISTED rather than
 * refused. Confirmation email is sent immediately — it is transactional (a reply
 * to something they just did), so it is not behind an automation gate.
 */
export async function registerForEvent(
  app: FastifyInstance,
  slug: string,
  input: RegistrationInput
): Promise<{ status: 'confirmed' | 'waitlisted'; seatNumber: number | null; position: number | null }> {
  const ev = await app.db.query<{ id: string; capacity: number; status: string; title_en: string; title_es: string; starts_at: Date }>(
    `SELECT id, capacity, status::text, title_en, title_es, starts_at FROM events WHERE slug = $1`,
    [slug]
  );
  const e = ev.rows[0];
  if (!e || e.status === 'draft') throw new AppError(404, 'not_found', 'Event not found.');
  if (e.status === 'cancelled') throw new AppError(409, 'event_cancelled', 'This event has been cancelled.');
  if (e.status === 'completed') throw new AppError(409, 'event_over', 'This event has already happened.');

  const existing = await app.db.query<{ status: string; seat_number: number | null }>(
    `SELECT status::text, seat_number FROM event_registrations WHERE event_id = $1 AND email = $2`,
    [e.id, input.email]
  );
  if (existing.rows[0] && existing.rows[0].status !== 'cancelled') {
    throw new AppError(409, 'already_registered', 'You are already registered for this workshop.');
  }

  const language = input.language ?? 'en';
  // Claim the lowest free seat. If the index rejects it, someone took it between
  // our read and our write — that is the race the index exists to catch.
  let status: 'confirmed' | 'waitlisted' = 'waitlisted';
  let seatNumber: number | null = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const seat = await app.db.query<{ next: number | null }>(
      `SELECT min(s) AS next FROM generate_series(1, $2) s
       WHERE NOT EXISTS (
         SELECT 1 FROM event_registrations r
         WHERE r.event_id = $1 AND r.seat_number = s
       )`,
      [e.id, e.capacity]
    );
    const candidate = seat.rows[0]?.next ?? null;
    if (candidate === null) break; // genuinely full → waitlist

    try {
      await app.db.query(
        `INSERT INTO event_registrations
           (event_id, first_name, last_name, email, phone, language, status, seat_number, sms_opt_in)
         VALUES ($1,$2,$3,$4,$5,$6,'confirmed',$7,$8)
         ON CONFLICT (event_id, email) DO UPDATE SET
           status = 'confirmed', seat_number = EXCLUDED.seat_number,
           first_name = EXCLUDED.first_name, last_name = EXCLUDED.last_name,
           phone = EXCLUDED.phone, language = EXCLUDED.language, sms_opt_in = EXCLUDED.sms_opt_in`,
        [
          e.id, input.firstName, input.lastName, input.email, input.phone ?? null,
          language, candidate, input.smsOptIn ?? false,
        ]
      );
      status = 'confirmed';
      seatNumber = candidate;
      break;
    } catch (err) {
      // 23505 = unique violation on the seat index: lost the race, try the next seat.
      if ((err as { code?: string }).code !== '23505') throw err;
    }
  }

  if (status === 'waitlisted') {
    await app.db.query(
      `INSERT INTO event_registrations
         (event_id, first_name, last_name, email, phone, language, status, sms_opt_in)
       VALUES ($1,$2,$3,$4,$5,$6,'waitlisted',$7)
       ON CONFLICT (event_id, email) DO UPDATE SET
         status = 'waitlisted', seat_number = NULL,
         first_name = EXCLUDED.first_name, last_name = EXCLUDED.last_name,
         phone = EXCLUDED.phone, language = EXCLUDED.language, sms_opt_in = EXCLUDED.sms_opt_in`,
      [e.id, input.firstName, input.lastName, input.email, input.phone ?? null, language, input.smsOptIn ?? false]
    );
  }

  const position =
    status === 'waitlisted'
      ? (
          await app.db.query<{ n: number }>(
            `SELECT count(*)::int AS n FROM event_registrations
             WHERE event_id = $1 AND status = 'waitlisted' AND created_at <= (
               SELECT created_at FROM event_registrations WHERE event_id = $1 AND email = $2
             )`,
            [e.id, input.email]
          )
        ).rows[0]!.n
      : null;

  // Confirmation is transactional — they just signed up. Not automation-gated.
  const es = language === 'es';
  const when = e.starts_at.toISOString().slice(0, 16).replace('T', ' ');
  await app.mailer.send({
    to: input.email,
    subject: es
      ? status === 'confirmed' ? `Confirmado: ${e.title_es}` : `Lista de espera: ${e.title_es}`
      : status === 'confirmed' ? `You're registered: ${e.title_en}` : `Waitlisted: ${e.title_en}`,
    text: es
      ? status === 'confirmed'
        ? `Hola ${input.firstName}:\n\nEstá confirmado(a) para ${e.title_es} el ${when}.\n\n` +
          `Si no puede asistir, avísenos y liberamos su lugar para otra persona.\n\n— Hilo`
        : `Hola ${input.firstName}:\n\n${e.title_es} está lleno, pero usted está en la lista de espera ` +
          `(lugar ${position}). Le avisamos si se abre un espacio.\n\n— Hilo`
      : status === 'confirmed'
        ? `Hi ${input.firstName},\n\nYou're confirmed for ${e.title_en} on ${when}.\n\n` +
          `If you can't make it, tell us and we'll free your seat for someone else.\n\n— Hilo`
        : `Hi ${input.firstName},\n\n${e.title_en} is full, but you're on the waitlist ` +
          `(position ${position}). We'll let you know if a seat opens.\n\n— Hilo`,
  });
  await app.db.query(
    `UPDATE event_registrations SET confirmation_sent_at = now() WHERE event_id = $1 AND email = $2`,
    [e.id, input.email]
  );
  await writeAudit(app.db, {
    actorType: 'client', actorLabel: input.email,
    action: status === 'confirmed' ? 'event.registered' : 'event.waitlisted',
    objectType: 'event', objectId: e.id,
    details: { slug, seat_number: seatNumber, waitlist_position: position },
  });
  return { status, seatNumber, position };
}

/**
 * Cancel a registration and promote the first waitlisted person into the seat.
 * A freed seat that nobody gets is the failure mode of a manual waitlist.
 */
export async function cancelRegistration(
  app: FastifyInstance,
  slug: string,
  email: string
): Promise<{ cancelled: boolean; promotedEmail: string | null }> {
  const ev = await app.db.query<{ id: string; title_en: string; title_es: string }>(
    `SELECT id, title_en, title_es FROM events WHERE slug = $1`,
    [slug]
  );
  const e = ev.rows[0];
  if (!e) throw new AppError(404, 'not_found', 'Event not found.');

  // Read the seat BEFORE clearing it. RETURNING hands back the updated row, so
  // asking it for seat_number after setting it to NULL returns NULL — which
  // silently skipped the promotion entirely.
  const freed = await app.db.query<{ id: string; seat_number: number | null }>(
    `SELECT id, seat_number FROM event_registrations
     WHERE event_id = $1 AND email = $2 AND status IN ('confirmed', 'waitlisted')`,
    [e.id, email]
  );
  if (freed.rows.length === 0) return { cancelled: false, promotedEmail: null };
  const seat = freed.rows[0]!.seat_number;

  await app.db.query(
    `UPDATE event_registrations SET status = 'cancelled', seat_number = NULL WHERE id = $1`,
    [freed.rows[0]!.id]
  );
  let promotedEmail: string | null = null;
  if (seat !== null) {
    const promoted = await app.db.query<{ email: string; first_name: string; language: 'en' | 'es' }>(
      `UPDATE event_registrations SET status = 'confirmed', seat_number = $2
       WHERE id = (
         SELECT id FROM event_registrations
         WHERE event_id = $1 AND status = 'waitlisted'
         ORDER BY created_at LIMIT 1
       )
       RETURNING email, first_name, language`,
      [e.id, seat]
    );
    if (promoted.rows[0]) {
      const p = promoted.rows[0];
      promotedEmail = p.email;
      const es = p.language === 'es';
      await app.mailer.send({
        to: p.email,
        subject: es ? `Se abrió un lugar: ${e.title_es}` : `A seat opened: ${e.title_en}`,
        text: es
          ? `Hola ${p.first_name}:\n\nSe abrió un lugar en ${e.title_es} y es suyo. Ya está confirmado(a).\n\n— Hilo`
          : `Hi ${p.first_name},\n\nA seat opened at ${e.title_en} and it's yours — you're confirmed.\n\n— Hilo`,
      });
    }
  }
  await writeAudit(app.db, {
    actorType: 'client', actorLabel: email,
    action: 'event.registration_cancelled', objectType: 'event', objectId: e.id,
    details: { slug, freed_seat: seat, promoted: promotedEmail },
  });
  return { cancelled: true, promotedEmail };
}

/** The check-in list: who is expected, who arrived. */
export async function checkInList(app: FastifyInstance, slug: string) {
  const { rows } = await app.db.query(
    `SELECT r.id, r.first_name, r.last_name, r.email, r.phone, r.language,
            r.status::text AS status, r.seat_number, r.checked_in_at,
            r.contact_id IS NOT NULL AS in_crm
     FROM event_registrations r JOIN events e ON e.id = r.event_id
     WHERE e.slug = $1 AND r.status <> 'cancelled'
     ORDER BY r.status, r.seat_number NULLS LAST, r.last_name`,
    [slug]
  );
  return { registrations: rows };
}

export async function checkIn(app: FastifyInstance, registrationId: string, actor: AuthedStaff): Promise<void> {
  const { rowCount } = await app.db.query(
    `UPDATE event_registrations
     SET checked_in_at = now(), status = 'attended'
     WHERE id = $1 AND seat_number IS NOT NULL AND status IN ('confirmed', 'attended')`,
    [registrationId]
  );
  if ((rowCount ?? 0) === 0) {
    throw new AppError(
      409,
      'cannot_check_in',
      'Only a confirmed registration with a seat can be checked in — promote them off the waitlist first.'
    );
  }
  await writeAudit(app.db, {
    actorType: 'staff', actorId: actor.id, actorLabel: actor.fullName,
    action: 'event.checked_in', objectType: 'event_registration', objectId: registrationId,
  });
}

/**
 * Close the event: mark no-shows, send the out-survey the same evening, and raise
 * ONE follow-up task for Jackson covering the attendees who are not yet in the
 * Hilo CRM. Linking them (and any Soto referral) stays a human decision — a
 * workshop attendee is a member of the public, and referrals are §7216-gated.
 */
export async function completeEvent(
  app: FastifyInstance,
  slug: string,
  actor: AuthedStaff
): Promise<{ attended: number; noShows: number; surveysSent: number; surveysSuppressed: number }> {
  const ev = await app.db.query<{ id: string; title_en: string; title_es: string; status: string }>(
    `SELECT id, title_en, title_es, status::text FROM events WHERE slug = $1`,
    [slug]
  );
  const e = ev.rows[0];
  if (!e) throw new AppError(404, 'not_found', 'Event not found.');
  if (e.status === 'completed') throw new AppError(409, 'already_completed', 'This event is already closed out.');

  // Anyone with a seat who never checked in is a no-show — recorded, because
  // attendance rate is a funder-report number.
  const noShow = await app.db.query(
    `UPDATE event_registrations SET status = 'no_show'
     WHERE event_id = $1 AND status = 'confirmed' AND checked_in_at IS NULL`,
    [e.id]
  );

  const attendees = await app.db.query<{ id: string; email: string; first_name: string; language: 'en' | 'es' }>(
    `SELECT id, email, first_name, language FROM event_registrations
     WHERE event_id = $1 AND status = 'attended'`,
    [e.id]
  );

  // The out-survey reaches clients, so it respects the announcement opt-out and
  // is counted when suppressed — same discipline as every other outbound.
  let surveysSent = 0;
  let surveysSuppressed = 0;
  for (const a of attendees.rows) {
    const suppressed = await app.db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM contacts
       WHERE email = $1 AND broadcast_opt_out_at IS NOT NULL`,
      [a.email]
    );
    if ((suppressed.rows[0]?.n ?? 0) > 0) {
      surveysSuppressed += 1;
      continue;
    }
    const es = a.language === 'es';
    await app.mailer.send({
      to: a.email,
      subject: es ? `¿Cómo le fue? ${e.title_es}` : `How was it? ${e.title_en}`,
      text: es
        ? `Hola ${a.first_name}:\n\nGracias por venir a ${e.title_es}. Tres preguntas rápidas:\n\n` +
          `1. ¿Qué tan satisfecho(a) quedó? (1–5)\n2. ¿Qué aprendió que va a usar?\n3. ¿Qué le ayudaría después?\n\n` +
          `Responda a este correo — lo leemos nosotros, no un robot.\n\n— Hilo`
        : `Hi ${a.first_name},\n\nThanks for coming to ${e.title_en}. Three quick questions:\n\n` +
          `1. How satisfied were you? (1–5)\n2. What did you learn that you'll actually use?\n3. What would help next?\n\n` +
          `Just reply to this email — a person reads these, not a robot.\n\n— Hilo`,
    });
    await app.db.query(`UPDATE event_registrations SET survey_sent_at = now() WHERE id = $1`, [a.id]);
    surveysSent += 1;
  }

  await app.db.query(
    `UPDATE events SET status = 'completed', completed_at = now() WHERE id = $1`,
    [e.id]
  );

  // ONE follow-up task, not one per attendee — the work item is the follow-up
  // pass, and CLAUDE.md forbids module-local to-do lists.
  const unlinked = attendees.rows.length;
  const jackson = await ownerForRole(app.db, 'ed_coo');
  /*
   * THE OWNER GATE GOES; THE BUSINESS CONDITION STAYS (Brian's rule, 2026-08-17).
   *
   * This was `if (jackson && unlinked > 0)` — two conditions doing different jobs. The owner
   * half was the #17 defect: an unfilled `ed_coo` meant the follow-up work was never recorded.
   * The `unlinked > 0` half is real: an event nobody attended has no attendees to link, and a
   * task reading "0 attendees" is noise that teaches people to ignore the queue.
   *
   * Worth stating because a script I wrote to do this sweep hoisted BOTH out and I caught it
   * in review. "Create the task unconditionally" means unconditional on WHO OWNS IT, never on
   * whether there is anything to do.
   */
  if (unlinked > 0) {
    await createTask(app, {
      title: `Post-event follow-up: ${e.title_en} (${unlinked} attendees)`,
      description:
        `The workshop is closed out and the out-survey has gone to attendees. Work the follow-up:\n` +
        `· link attendees who want ongoing help into the Hilo CRM (they are members of the public until you do)\n` +
        `· any Soto referral stays §7216-gated and needs the disclosure on record\n` +
        `· survey answers feed the funder report as they come in`,
      assignedStaffId: jackson,
      priority: 1,
      source: 'automation',
      sourceType: 'event_followup',
      sourceId: e.id,
    });
  }

  await writeAudit(app.db, {
    actorType: 'staff', actorId: actor.id, actorLabel: actor.fullName,
    action: 'event.completed', objectType: 'event', objectId: e.id,
    details: {
      slug, attended: attendees.rows.length, no_shows: noShow.rowCount ?? 0,
      surveys_sent: surveysSent, surveys_suppressed: surveysSuppressed,
    },
  });
  return {
    attended: attendees.rows.length,
    noShows: noShow.rowCount ?? 0,
    surveysSent,
    surveysSuppressed,
  };
}

/** Record a survey response (staff enter replies; there is no public form yet). */
export async function recordSurvey(
  app: FastifyInstance,
  registrationId: string,
  answers: { satisfaction?: number | undefined; nps?: number | undefined; learned?: string | undefined; next?: string | undefined },
  actor: AuthedStaff
): Promise<void> {
  const { rowCount } = await app.db.query(
    `UPDATE event_registrations
     SET survey_answered_at = now(), survey_satisfaction = $2, survey_nps = $3,
         survey_learned = $4, survey_next = $5
     WHERE id = $1`,
    [
      registrationId, answers.satisfaction ?? null, answers.nps ?? null,
      answers.learned ?? null, answers.next ?? null,
    ]
  );
  if ((rowCount ?? 0) === 0) throw new AppError(404, 'not_found', 'Registration not found.');
  await writeAudit(app.db, {
    actorType: 'staff', actorId: actor.id, actorLabel: actor.fullName,
    action: 'event.survey_recorded', objectType: 'event_registration', objectId: registrationId,
  });
}

/**
 * Daily, date-guarded: T-1 reminders for tomorrow's published events. Email is
 * transactional; the SMS half additionally needs the registrant's own opt-in AND
 * the standing TCPA consent gate inside sendSms.
 */
export async function runEventReminderJob(
  app: FastifyInstance,
  today: string
): Promise<{ skipped: boolean; emailed: number; texted: number; suppressed: number }> {
  const ACTION = 'job.event_reminders';
  const already = await app.db.query(
    `SELECT 1 FROM audit_log WHERE action = $1 AND details->>'run_date' = $2 LIMIT 1`,
    [ACTION, today]
  );
  if (already.rows.length > 0) return { skipped: true, emailed: 0, texted: 0, suppressed: 0 };

  const { rows } = await app.db.query<{
    id: string; email: string; first_name: string; language: 'en' | 'es';
    sms_opt_in: boolean; contact_id: string | null; title_en: string; title_es: string;
    location: string | null; starts_at: Date;
  }>(
    `SELECT r.id, r.email, r.first_name, r.language, r.sms_opt_in, r.contact_id,
            e.title_en, e.title_es, e.location, e.starts_at
     FROM event_registrations r JOIN events e ON e.id = r.event_id
     WHERE e.status = 'published'
       AND r.status = 'confirmed'
       AND r.reminder_sent_at IS NULL
       AND e.starts_at >= $1::date + 1
       AND e.starts_at <  $1::date + 2`,
    [today]
  );

  const armed = await isAutomationEnabled(app, 'event_reminders');
  let emailed = 0;
  let texted = 0;
  let suppressed = 0;
  for (const r of rows) {
    if (!armed) {
      suppressed += 1;
      continue;
    }
    const es = r.language === 'es';
    const when = r.starts_at.toISOString().slice(0, 16).replace('T', ' ');
    await app.mailer.send({
      to: r.email,
      subject: es ? `Mañana: ${r.title_es}` : `Tomorrow: ${r.title_en}`,
      text: es
        ? `Hola ${r.first_name}:\n\nRecordatorio — ${r.title_es} es mañana, ${when}` +
          `${r.location ? ` en ${r.location}` : ''}.\n\nSi ya no puede venir, avísenos y liberamos su lugar.\n\n— Hilo`
        : `Hi ${r.first_name},\n\nReminder — ${r.title_en} is tomorrow, ${when}` +
          `${r.location ? ` at ${r.location}` : ''}.\n\nIf you can't make it, tell us and we'll free your seat.\n\n— Hilo`,
    });
    emailed += 1;

    // SMS needs BOTH the event opt-in and a contact record carrying standing
    // consent. A workshop signup is not consent to be texted generally.
    if (r.sms_opt_in && r.contact_id) {
      const sent = await sendSms(app, {
        contactId: r.contact_id,
        templateKey: 'event_reminder',
        language: r.language,
        vars: { first_name: r.first_name },
        bodyOverride: es
          ? `Hilo: ${r.title_es} es mañana, ${when}.`
          : `Hilo: ${r.title_en} is tomorrow, ${when}.`,
      });
      if (sent.sent) texted += 1;
    }
    await app.db.query(`UPDATE event_registrations SET reminder_sent_at = now() WHERE id = $1`, [r.id]);
  }

  await writeAudit(app.db, {
    actorType: 'system', actorLabel: 'daily-jobs',
    action: ACTION,
    details: { run_date: today, emailed, texted, suppressed, armed },
  });
  return { skipped: false, emailed, texted, suppressed };
}

/** Funder-report numbers per event: registered, attended, no-shows, survey stats. */
export async function eventImpact(app: FastifyInstance, slug: string) {
  const { rows } = await app.db.query(
    `SELECT e.slug, e.title_en, e.program, e.capacity, e.starts_at, e.status::text,
            count(r.id) FILTER (WHERE r.status <> 'cancelled')::int AS registered,
            count(r.id) FILTER (WHERE r.status = 'attended')::int AS attended,
            count(r.id) FILTER (WHERE r.status = 'no_show')::int AS no_shows,
            count(r.id) FILTER (WHERE r.status = 'waitlisted')::int AS waitlisted,
            count(r.id) FILTER (WHERE r.survey_answered_at IS NOT NULL)::int AS surveys_answered,
            to_char(avg(r.survey_satisfaction), 'FM990.0') AS avg_satisfaction,
            to_char(avg(r.survey_nps), 'FM990.0') AS avg_nps
     FROM events e LEFT JOIN event_registrations r ON r.event_id = e.id
     WHERE e.slug = $1
     GROUP BY e.id, e.slug, e.title_en, e.program, e.capacity, e.starts_at, e.status`,
    [slug]
  );
  if (!rows[0]) throw new AppError(404, 'not_found', 'Event not found.');
  return rows[0];
}
