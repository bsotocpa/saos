// Two-lane booking (MP v4.2 module 8) driven by the Cal.com webhook:
//   Lane 1 "New Client Discovery"  — collects the service-level DEPOSIT via
//     Stripe at booking (true-up model): contact created/linked, deposit
//     invoice from the price book, checkout link emailed.
//   Lane 2 "General Inquiries"     — always free (codified retention asset):
//     a task for the team, nothing billed, ever.
// Lane mapping + deposit item codes live in app_settings (admin-tunable).
// Zoom-only on initial consultations is enforced by the Cal.com event-type
// config (M23 setup); the webhook flags non-Zoom discovery bookings to staff.

import { timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { writeAudit } from '../../audit.ts';
import { firstActiveByRole, notifyOnce } from '../../staffing.ts';
import { sendTemplatedEmail } from '../templates/service.ts';
import { createInvoice } from '../billing/service.ts';
import { makeStripeAdapter } from '../billing/stripe.ts';

const BookingPayload = z.object({
  triggerEvent: z.string(),
  payload: z.looseObject({
    type: z.string().optional(),              // event-type slug
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
  const stripe = makeStripeAdapter(app.config);

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

    const depositItems = await settingJson<Record<string, string>>(app, 'booking.deposit_items', {});
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

    // ── Lane 2: questions are ALWAYS free — task the team, bill nothing.
    if (questionSlugs.includes(slug)) {
      const rene = await firstActiveByRole(app.db, 'comms_billing');
      await app.db.query(
        `INSERT INTO tasks (title, assigned_staff_id, contact_id, priority, source, source_type)
         VALUES ($1, $2, $3, 0, 'automation', 'booking_question')`,
        [`Question call booked: ${contactFirst} (${body.payload.startTime ?? 'time tbd'}) — no charge`, rene, contactId]
      );
      return { status: 'ok', lane: 'questions' };
    }

    // ── Lane 1: discovery — deposit from the price book + checkout link.
    const depositCode = depositItems[slug];
    if (!depositCode) {
      // Unknown event type: accept, flag for staff so nothing silently slips.
      const rene = await firstActiveByRole(app.db, 'comms_billing');
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
      }
      return { status: 'ok', lane: 'unmapped' };
    }

    const invoice = await createInvoice(app, { type: 'system', label: 'booking deposit' }, {
      contactId,
      lines: [{ code: depositCode }],
      send: false, // our own deposit email below carries the checkout link
    });
    await app.db.query(`UPDATE invoices SET status = 'sent', sent_at = now() WHERE id = $1`, [invoice.id]);

    const session = await stripe.createCheckoutSession({
      invoiceId: invoice.id,
      invoiceNumber: invoice.invoiceNumber,
      amountCents: invoice.totalCents,
      description: `Soto Accounting — discovery deposit (${invoice.invoiceNumber})`,
      customerEmail: email,
      successUrl: `${app.config.PORTAL_BASE_URL}/invoices?paid=1`,
      cancelUrl: `${app.config.PORTAL_BASE_URL}/invoices`,
    });
    await app.db.query(`UPDATE invoices SET stripe_checkout_session_id = $2 WHERE id = $1`, [invoice.id, session.sessionId]);

    await sendTemplatedEmail(app, {
      to: email,
      templateKey: 'discovery_deposit',
      language: contactLang,
      contactId,
      vars: {
        first_name: contactFirst,
        checkout_link: session.url,
        // Amount rendered from the invoice (price book) at runtime:
        amount: `$${(invoice.totalCents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
      },
    });

    // Zoom-only rule (MP): flag discovery bookings that aren't on Zoom.
    const location = (body.payload.videoCallData?.type ?? body.payload.location ?? '').toLowerCase();
    if (!location.includes('zoom')) {
      const rene = await firstActiveByRole(app.db, 'comms_billing');
      if (rene) {
        await notifyOnce(app.db, {
          staffId: rene,
          type: 'booking_not_zoom',
          severity: 'warning',
          title: `Discovery booking is not on Zoom (${location || 'no location'}) — check the Cal.com event type`,
          contactId,
          relatedObjectType: 'invoice',
          relatedObjectId: invoice.id,
        });
      }
    }

    return { status: 'ok', lane: 'discovery', invoiceNumber: invoice.invoiceNumber };
  });
}
