// Two-lane booking (MP v4.2 module 8) driven by the Cal.com webhook.
//
// EVERY BOOKING IS FREE (Brian, 2026-08-14): "deposits exist ONLY on accepted quotes.
// Discovery and all bookings are free; first client payment is always the quote deposit."
//
// Lane 1 used to collect a service-level deposit here — it created an invoice from
// DEPOSIT_1040 / DEPOSIT_BUSINESS_TAX, opened a Stripe checkout session and emailed the
// link. That was a SECOND deposit path alongside the quote flow, and once price book v4
// put deposits on the service lines it became a double charge waiting to happen: a client
// who booked and then accepted a quote would be asked twice. Retiring it removes the
// double-charge scenario rather than guarding against it.
//
// So Lane 1 now does what Lane 2 always did — create/link the contact, task the team,
// bill nothing — plus a confirmation email that sets the expectation the Cal.com event
// description already sets: the deposit comes with the engagement quote.
//
//   Lane 1 "New Client Discovery"  — contact created/linked, team tasked, FREE.
//   Lane 2 "General Inquiries"     — always free (codified retention asset).
//
// Lane membership lives in app_settings (admin-tunable). Zoom-only on initial
// consultations is enforced by the Cal.com event-type config (M23 setup); the webhook
// flags non-Zoom discovery bookings to staff.

import { timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { writeAudit } from '../../audit.ts';
import { isAutomationEnabled } from '../../automations.ts';
import { notifyOnce, ownerForRole } from '../../staffing.ts';
import { createTask } from '../tasks/service.ts';
import { sendTemplatedEmail } from '../templates/service.ts';

const BookingPayload = z.object({
  triggerEvent: z.string(),
  payload: z.looseObject({
    type: z.string().optional(),              // event-type slug
    uid: z.string().optional(),               // Cal.com's own booking id, when it sends one
    title: z.string().optional(),
    startTime: z.string().optional(),
    attendees: z
      .array(z.looseObject({ email: z.string().optional(), name: z.string().optional(), language: z.string().optional() }))
      .optional(),
    location: z.string().optional(),
    videoCallData: z.looseObject({ type: z.string().optional() }).optional(),
  }),
});

function secretsMatch(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

async function settingJson<T>(app: FastifyInstance, key: string, fallback: T): Promise<T> {
  const { rows } = await app.db.query<{ value: T }>(`SELECT value FROM app_settings WHERE key = $1`, [key]);
  return rows[0]?.value ?? fallback;
}

export function registerBookingRoutes(app: FastifyInstance): void {

  app.post('/webhooks/calcom', async (request, reply) => {
    const secret = request.headers['x-webhook-secret'];
    if (typeof secret !== 'string' || !secretsMatch(secret, app.config.WEBHOOK_SECRET)) {
      return reply.code(401).send({ error: 'unauthorized' });
    }
    const body = BookingPayload.parse(request.body);
    if (body.triggerEvent !== 'BOOKING_CREATED') return { status: 'ignored' };

    const slug = body.payload.type ?? '';
    const attendee = body.payload.attendees?.[0];
    if (!attendee?.email) return { status: 'ignored', reason: 'no_attendee_email' };
    const email = attendee.email;
    const nameParts = (attendee.name ?? 'New Client').split(/\s+/);
    const firstName = nameParts[0] ?? 'New';
    const lastName = nameParts.slice(1).join(' ') || 'Client';
    const language = attendee.language === 'es' ? 'es' : 'en';

    /*
     * Which slugs are discovery. This used to be `booking.deposit_items` — a map of
     * slug → deposit item code — and after the Lane 1 ruling only the KEYS meant
     * anything. A setting named for deposits in a system that takes no deposit at
     * booking reads wrong, so it is retired in favour of a plain list of slugs.
     */
    const discoverySlugs = await settingJson<string[]>(app, 'booking.discovery_events', []);
    const questionSlugs = await settingJson<string[]>(app, 'booking.question_slugs', []);

    // Find-or-create the contact (same dedupe rule as intake: link by email).
    const existing = await app.db.query<{ id: string; first_name: string; language: 'en' | 'es' }>(
      `SELECT id, first_name, language FROM contacts WHERE email = $1 LIMIT 1`,
      [email]
    );
    let contactId: string;
    let contactFirst: string;
    let contactLang: 'en' | 'es';
    if (existing.rows[0]) {
      contactId = existing.rows[0].id;
      contactFirst = existing.rows[0].first_name;
      contactLang = existing.rows[0].language;
    } else {
      const created = await app.db.query<{ id: string }>(
        `INSERT INTO contacts (first_name, last_name, email, language, soto_status, how_heard)
         VALUES ($1, $2, $3, $4, 'lead', 'booking') RETURNING id`,
        [firstName, lastName, email, language]
      );
      contactId = created.rows[0]!.id;
      contactFirst = firstName;
      contactLang = language;
    }

    await writeAudit(app.db, {
      actorType: 'system',
      action: 'booking.created',
      objectType: 'contact',
      objectId: contactId,
      contactId,
      details: { slug, start: body.payload.startTime ?? null },
    });

    /*
     * CHECKLIST STEP 6 — "book your kickoff" completes HERE (finding #34).
     *
     * Brian's standing policy: every channel a client can claim they used must be one
     * the system tracks. So the step is stamped by the booking actually arriving, never
     * by the client ticking a box to say they booked something. A client who books
     * outside Cal.com leaves the step open, which is the honest outcome — the system
     * genuinely does not know about that meeting.
     *
     * `booking.kickoff_slugs` narrows it when Brian wants that; empty means any booking
     * counts except a free question call, which is a different conversation. Defaulting
     * to "any" rather than "none" matters: an unconfigured setting that made the step
     * uncompletable would be worse than one that is slightly generous.
     */
    /*
     * Keep the booking itself (#35). The portal shows a client the meeting they booked,
     * and it can only do that if something stored it — the audit row is a forensic
     * record, not something a client-facing screen can read. ON CONFLICT because Cal.com
     * retries, and a retry must not become a second meeting on their home screen.
     */
    await app.db.query(
      `INSERT INTO client_bookings (contact_id, external_id, event_slug, title, starts_at, location)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (contact_id, external_id) WHERE external_id IS NOT NULL
       DO UPDATE SET starts_at = EXCLUDED.starts_at, title = EXCLUDED.title,
                     location = EXCLUDED.location, cancelled_at = NULL`,
      [
        contactId,
        body.payload.uid ?? null,
        slug,
        body.payload.title ?? null,
        body.payload.startTime ?? null,
        body.payload.location ?? body.payload.videoCallData?.type ?? null,
      ]
    );

    const kickoffSlugs = await settingJson<string[]>(app, 'booking.kickoff_slugs', []);
    const isKickoff = kickoffSlugs.length > 0 ? kickoffSlugs.includes(slug) : !questionSlugs.includes(slug);
    if (isKickoff) {
      await app.db.query(
        `UPDATE portal_onboarding SET step_book_consult_at = COALESCE(step_book_consult_at, now())
          WHERE contact_id = $1 AND step_book_consult_at IS NULL`,
        [contactId]
      );
    }

    // ── Lane 2: questions are ALWAYS free — task the team, bill nothing.
    if (questionSlugs.includes(slug)) {
      const rene = await ownerForRole(app.db, 'comms_billing');
      await app.db.query(
        `INSERT INTO tasks (title, assigned_staff_id, contact_id, priority, source, source_type)
         VALUES ($1, $2, $3, 0, 'automation', 'booking_question')`,
        [`Question call booked: ${contactFirst} (${body.payload.startTime ?? 'time tbd'}) — no charge`, rene, contactId]
      );
      return { status: 'ok', lane: 'questions' };
    }

    // ── Lane 1: discovery — free, like every other booking.
    if (!discoverySlugs.includes(slug)) {
      // Unknown event type: accept, flag for staff so nothing silently slips.
      const rene = await ownerForRole(app.db, 'comms_billing');
      /*
       * THE TASK IS UNCONDITIONAL; only the ALERT is gated (Brian's rule, 2026-08-17).
       *
       * Both sat inside `if (rene)`, so an unfilled role meant the work was never
       * recorded at all. An unassigned task in the queue is visible; a skipped one never
       * existed. A notification still needs a real person — that gate stays.
       */
      await createTask(app, {
        title: `Map Cal.com event type '${slug}' in Admin → Settings (booking.discovery_events)`,
        assignedStaffId: rene,
        contactId,
        source: 'automation',
        sourceType: 'booking_unmapped',
        sourceId: slug,
      });
      if (rene) {
        await notifyOnce(app.db, {
          staffId: rene,
          type: 'booking_unmapped_event',
          severity: 'info',
          title: `Booking on unmapped event type '${slug}' — map it in admin settings`,
          contactId,
          relatedObjectType: 'contact',
          relatedObjectId: contactId,
        });
        // M25: mapping the slug is a work item, deduped per slug.
      }
      return { status: 'ok', lane: 'unmapped' };
    }

    /*
     * The team gets the work item. This is the internal half and is NEVER gated —
     * only the outbound client message is (CLAUDE.md).
     */
    const owner = await ownerForRole(app.db, 'comms_billing');
    await createTask(app, {
      title: `Discovery call booked: ${contactFirst} (${body.payload.startTime ?? 'time tbd'})`,
      ...(owner ? { assignedStaffId: owner } : {}),
      contactId,
      priority: 1,
      source: 'automation',
      sourceType: 'booking_discovery',
      sourceId: contactId,
    });

    /*
     * The confirmation email. Client-acting, so it is registered in `automations` and
     * ships DISABLED — Brian arms it when real clients start booking. Every suppression
     * is counted, because a send that silently does not happen is indistinguishable from
     * a send that failed.
     *
     * The copy carries what the Cal.com event description already says: nothing to pay
     * now, the deposit comes with the engagement quote. That expectation has to be set
     * here precisely BECAUSE the old flow asked for money at this moment — a client who
     * booked last month and books again should not be waiting for a checkout link.
     */
    let confirmationSent = false;
    if (await isAutomationEnabled(app, 'booking_confirmations')) {
      await sendTemplatedEmail(app, {
        to: email,
        templateKey: 'booking_confirmation',
        language: contactLang,
        contactId,
        vars: { first_name: contactFirst },
      });
      confirmationSent = true;
    }

    // Zoom-only rule (MP): flag discovery bookings that aren't on Zoom.
    const location = (body.payload.videoCallData?.type ?? body.payload.location ?? '').toLowerCase();
    if (!location.includes('zoom')) {
      const rene = await ownerForRole(app.db, 'comms_billing');
      /*
       * THE TASK IS UNCONDITIONAL; only the ALERT is gated (Brian's rule, 2026-08-17).
       *
       * Both sat inside `if (rene)`, so an unfilled role meant the work was never
       * recorded at all. An unassigned task in the queue is visible; a skipped one never
       * existed. A notification still needs a real person — that gate stays.
       */
      await createTask(app, {
        title: `Fix non-Zoom discovery booking (${location || 'no location'}) — Zoom-only rule`,
        assignedStaffId: rene,
        contactId,
        priority: 1,
        source: 'automation',
        sourceType: 'booking_not_zoom',
        sourceId: contactId,
      });
      if (rene) {
        await notifyOnce(app.db, {
          staffId: rene,
          type: 'booking_not_zoom',
          severity: 'warning',
          title: `Discovery booking is not on Zoom (${location || 'no location'}) — check the Cal.com event type`,
          contactId,
          // Was the deposit invoice, which no longer exists. The contact IS the subject
          // of this alert anyway — the invoice was only ever the nearest object to hand.
          relatedObjectType: 'contact',
          relatedObjectId: contactId,
        });
      }
    }

    /*
     * On the record that this booking took no money, and whether the client heard
     * anything. `confirmationSuppressed` is the counted suppression: the difference
     * between "the toggle is off" and "the email failed" has to be visible, or the first
     * client to book while it is off looks like a delivery bug.
     */
    await writeAudit(app.db, {
      actorType: 'system',
      actorLabel: 'cal.com booking',
      action: 'booking.discovery_created',
      objectType: 'contact',
      objectId: contactId,
      contactId,
      details: {
        slug,
        charged: false,
        confirmation_sent: confirmationSent,
        confirmation_suppressed: !confirmationSent,
      },
    });

    return { status: 'ok', lane: 'discovery', charged: false, confirmationSent };
  });
}
