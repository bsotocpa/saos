// Stripe adapter (approved vendor — payments only; Stripe sees payment
// tokens, never client documents). Two implementations:
//   stub — dev/test: deterministic checkout sessions; webhooks authenticated
//          by the shared secret header and parsed as plain JSON
//   live — real Stripe SDK; webhooks verified with the STRIPE SIGNATURE
//          (stripe.webhooks.constructEvent) against the raw request body
// Production checkout refuses stub mode at runtime.

import Stripe from 'stripe';
import type { Config } from '../../config.ts';
import { AppError } from '../../types.ts';

export interface CheckoutInput {
  invoiceId: string;
  invoiceNumber: string;
  amountCents: number;
  description: string;
  customerEmail: string;
  successUrl: string;
  cancelUrl: string;
}

export interface PaidEvent {
  type: 'payment_completed';
  eventId: string;
  invoiceId?: string | undefined;
  checkoutSessionId?: string | undefined;
  paymentIntentId?: string | undefined;
}

export interface StripeRefund {
  id: string;
  amountCents: number;
  reason: string | null;
  createdAt: string;
}

/**
 * charge.refunded (2026-09-09). Stripe sends the CHARGE with the cumulative amount
 * refunded; the individual refund objects ride along when the endpoint's API version
 * includes them, and are fetched by id otherwise (listRefunds). Amounts are gross —
 * Stripe's retained fee is a bookkeeping matter, not SAOS's.
 */
/** What Stripe says about a charge today — the source of truth a nightly check compares against. */
/**
 * ITEM 10 (2026-09-09): a signature failure is a mismatch between worlds — a live event at a
 * test endpoint, a test key on a live box, a secret rotated on one side. The refusal names
 * the world the event came from (livemode, from the payload — it is only ever read, never
 * trusted), the event id, the mode this box is configured for, and the endpoint id the
 * installer registered. Without those four the next person reads "401" and guesses.
 */
export interface SignatureFailure {
  livemode: boolean | null;
  eventId: string | null;
  eventType: string | null;
  configuredMode: 'stub' | 'live';
  endpointId: string | null;
  reason: string;
}

export function signatureFailure(
  rawBody: Buffer,
  configuredMode: 'stub' | 'live',
  endpointId: string | null,
  reason: string
): AppError & { webhook: SignatureFailure } {
  let livemode: boolean | null = null;
  let eventId: string | null = null;
  let eventType: string | null = null;
  try {
    const parsed = JSON.parse(rawBody.toString('utf8')) as { livemode?: unknown; id?: unknown; type?: unknown };
    livemode = typeof parsed.livemode === 'boolean' ? parsed.livemode : null;
    eventId = typeof parsed.id === 'string' ? parsed.id : null;
    eventType = typeof parsed.type === 'string' ? parsed.type : null;
  } catch {
    // Not JSON: the failure still says so.
  }
  const err = new AppError(401, 'unauthorized', `Stripe signature verification failed: ${reason}.`);
  return Object.assign(err, { webhook: { livemode, eventId, eventType, configuredMode, endpointId, reason } });
}

export interface StripeChargeState {
  chargeId: string;
  amountCents: number;
  amountRefundedCents: number;
  refunded: boolean;
  disputed: boolean;
  refunds: StripeRefund[];
}

export interface RefundEvent {
  type: 'refund';
  eventId: string;
  chargeId: string;
  paymentIntentId?: string | undefined;
  chargeAmountCents: number;
  amountRefundedCents: number;
  refunds: StripeRefund[];
}

export interface DisputeOpenedEvent {
  type: 'dispute_opened';
  eventId: string;
  disputeId: string;
  chargeId: string;
  paymentIntentId?: string | undefined;
  amountCents: number;
  reason: string | null;
  status: string;
  /** ISO timestamp, from evidence_details.due_by. The task's due date. */
  evidenceDueBy: string | null;
}

export interface DisputeClosedEvent {
  type: 'dispute_closed';
  eventId: string;
  disputeId: string;
  chargeId: string;
  paymentIntentId?: string | undefined;
  amountCents: number;
  /** Stripe's terminal status: won | lost | warning_closed | … */
  status: string;
}

export interface IgnoredEvent {
  type: 'ignored';
  eventId?: string | undefined;
  stripeType?: string | undefined;
}

export type PaymentEvent = PaidEvent | RefundEvent | DisputeOpenedEvent | DisputeClosedEvent | IgnoredEvent;

/** The loosest shape of a Stripe event body that the mapping needs. */
interface RawStripeEvent {
  id?: string;
  type?: string;
  data?: { object?: Record<string, unknown> };
}

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const num = (v: unknown): number => (typeof v === 'number' ? v : 0);

/**
 * Stripe event → the event SAOS acts on. Shared by the stub (after its shared-secret
 * check) and the live adapter (after signature verification), so the two paths cannot
 * drift: a fixture the tests replay is parsed by exactly the code production runs.
 */
export function mapStripeEvent(raw: RawStripeEvent): PaymentEvent {
  const eventId = str(raw.id) ?? '';
  const obj = raw.data?.object ?? {};
  switch (raw.type) {
    case 'checkout.session.completed': {
      const metadata = obj.metadata as { invoice_id?: string } | undefined;
      return {
        type: 'payment_completed',
        eventId,
        invoiceId: metadata?.invoice_id,
        checkoutSessionId: str(obj.id),
        paymentIntentId: str(obj.payment_intent),
      };
    }
    case 'charge.refunded': {
      const list = (obj.refunds as { data?: Array<Record<string, unknown>> } | undefined)?.data ?? [];
      return {
        type: 'refund',
        eventId,
        chargeId: str(obj.id) ?? '',
        paymentIntentId: str(obj.payment_intent),
        chargeAmountCents: num(obj.amount),
        amountRefundedCents: num(obj.amount_refunded),
        refunds: list.map((r) => ({
          id: str(r.id) ?? '',
          amountCents: num(r.amount),
          reason: str(r.reason) ?? null,
          createdAt: new Date(num(r.created) * 1000).toISOString(),
        })).filter((r) => r.id !== ''),
      };
    }
    case 'charge.dispute.created':
    case 'charge.dispute.closed': {
      const evidence = obj.evidence_details as { due_by?: number } | undefined;
      const base = {
        eventId,
        disputeId: str(obj.id) ?? '',
        chargeId: str(obj.charge) ?? '',
        paymentIntentId: str(obj.payment_intent),
        amountCents: num(obj.amount),
        status: str(obj.status) ?? 'unknown',
      };
      if (raw.type === 'charge.dispute.created') {
        return {
          type: 'dispute_opened',
          ...base,
          reason: str(obj.reason) ?? null,
          evidenceDueBy: evidence?.due_by ? new Date(evidence.due_by * 1000).toISOString() : null,
        };
      }
      return { type: 'dispute_closed', ...base };
    }
    default:
      return { type: 'ignored', eventId, stripeType: raw.type };
  }
}

export interface StripeAdapter {
  readonly mode: 'stub' | 'live';
  /**
   * Which Stripe WORLD the key opens: 'test' (sk_test_/rk_test_) or 'live'. Null for the
   * stub, which has no key. Stripe test and live are two separate accounts' worth of
   * objects — a checkout session minted under one does not exist under the other.
   * Reconcile uses this to recognise a stale session before asking Stripe about it
   * (2026-09-09: the every-tick sweep asked the live key about two test sessions and
   * logged a 404 as an error every fifteen minutes).
   */
  readonly keyMode: 'test' | 'live' | null;
  createCheckoutSession(input: CheckoutInput): Promise<{ sessionId: string; url: string }>;
  /**
   * Ask Stripe the state of a checkout session (finding #24).
   *
   * A webhook is a notification; this is the source of truth, and it can be asked at
   * any time. Exists so a lost webhook costs a round trip instead of leaving a client
   * who paid marked unpaid indefinitely.
   */
  retrieveCheckoutSession(sessionId: string): Promise<{
    status: string | null;
    paymentStatus: string | null;
    paymentIntentId?: string | undefined;
  }>;
  /** Verify + parse a webhook. `rawBody` is the unparsed request body. */
  parseWebhookEvent(headers: Record<string, string | string[] | undefined>, rawBody: Buffer, sharedSecret: string): PaymentEvent;
  /**
   * The refunds on a charge, by Stripe's ids. Used when charge.refunded arrives without
   * its refund objects (newer API versions omit them). The stub answers from what a test
   * has told it, and nothing otherwise.
   */
  listRefunds(chargeId: string): Promise<StripeRefund[]>;
  /**
   * Expire an OPEN Checkout session so the link in a client's inbox stops working at
   * Stripe's end (a voided invoice, 2026-09-09). Already-complete or expired sessions are
   * left alone — Stripe refuses to expire those, and there is nothing to protect.
   */
  expireCheckoutSession(sessionId: string): Promise<void>;
  /**
   * The charge behind a payment intent, as Stripe holds it now (2026-09-09). A Checkout
   * Session's payment_status stays "paid" after a refund — the CHARGE is what knows about
   * refunds and disputes. Null when Stripe has no charge for it (or in the stub).
   */
  retrieveCharge(paymentIntentId: string): Promise<StripeChargeState | null>;
}

function stubAdapter(endpointId: string | null): StripeAdapter {
  return {
    mode: 'stub',
    keyMode: null,
    async createCheckoutSession(input) {
      const sessionId = `cs_stub_${input.invoiceId}`;
      return { sessionId, url: `https://checkout.stripe.example/${sessionId}` };
    },
    // The stub NEVER reports a payment. A test double that answered 'paid' would make
    // the reconcile path pass everywhere while settling nothing in production — the
    // exact shape of a test that proves the opposite of what it claims.
    async retrieveCheckoutSession() {
      return { status: 'open', paymentStatus: 'unpaid' };
    },
    parseWebhookEvent(headers, rawBody, sharedSecret) {
      // Stub auth: same shared-secret header convention as our other webhooks.
      const secret = headers['x-webhook-secret'];
      if (secret !== sharedSecret) {
        throw signatureFailure(rawBody, 'stub', endpointId, 'bad webhook secret');
      }
      return mapStripeEvent(JSON.parse(rawBody.toString('utf8')) as RawStripeEvent);
    },
    async listRefunds() {
      return [];
    },
    async expireCheckoutSession() {
      // Nothing to expire: the stub never minted a session Stripe knows about.
    },
    async retrieveCharge() {
      return null; // the stub holds no charges; tests inject what Stripe "says"
    },
  };
}

function liveAdapter(config: Config): StripeAdapter {
  // No explicit apiVersion: the SDK pins the API version it ships with.
  const stripe = new Stripe(config.STRIPE_SECRET_KEY ?? '');
  const key = config.STRIPE_SECRET_KEY ?? '';
  const keyMode: 'test' | 'live' | null =
    key.startsWith('sk_test_') || key.startsWith('rk_test_') ? 'test'
    : key.startsWith('sk_live_') || key.startsWith('rk_live_') ? 'live'
    : null;
  return {
    mode: 'live',
    keyMode,
    async createCheckoutSession(input) {
      const session = await stripe.checkout.sessions.create({
        mode: 'payment',
        customer_email: input.customerEmail,
        line_items: [
          {
            quantity: 1,
            price_data: {
              currency: 'usd',
              unit_amount: input.amountCents, // runtime data from the invoice — not a literal
              product_data: { name: input.description },
            },
          },
        ],
        metadata: { invoice_id: input.invoiceId, invoice_number: input.invoiceNumber },
        success_url: input.successUrl,
        cancel_url: input.cancelUrl,
      });
      if (!session.url) throw new AppError(502, 'stripe_error', 'Stripe returned no checkout URL.');
      return { sessionId: session.id, url: session.url };
    },
    async retrieveCheckoutSession(sessionId) {
      const session = await stripe.checkout.sessions.retrieve(sessionId);
      return {
        status: session.status ?? null,
        paymentStatus: session.payment_status ?? null,
        ...(typeof session.payment_intent === 'string'
          ? { paymentIntentId: session.payment_intent }
          : session.payment_intent
            ? { paymentIntentId: session.payment_intent.id }
            : {}),
      };
    },
    parseWebhookEvent(headers, rawBody) {
      const signature = headers['stripe-signature'];
      const endpointId = config.STRIPE_WEBHOOK_ENDPOINT_ID ?? null;
      if (typeof signature !== 'string' || !this.mode) {
        throw signatureFailure(rawBody, 'live', endpointId, 'missing Stripe-Signature header');
      }
      let event: Stripe.Event;
      try {
        // THE signature verification (M13 prove-it): rejects forged payloads.
        event = stripe.webhooks.constructEvent(rawBody, signature, config.STRIPE_WEBHOOK_SECRET ?? '');
      } catch (err) {
        throw signatureFailure(rawBody, 'live', endpointId, err instanceof Error ? err.message : 'constructEvent failed');
      }
      return mapStripeEvent(event as unknown as RawStripeEvent);
    },
    async expireCheckoutSession(sessionId) {
      const session = await stripe.checkout.sessions.retrieve(sessionId);
      if (session.status !== 'open') return;
      await stripe.checkout.sessions.expire(sessionId);
    },
    async retrieveCharge(paymentIntentId) {
      const intent = await stripe.paymentIntents.retrieve(paymentIntentId, { expand: ['latest_charge'] });
      const charge = typeof intent.latest_charge === 'string'
        ? await stripe.charges.retrieve(intent.latest_charge)
        : intent.latest_charge;
      if (!charge) return null;
      const refunds = await this.listRefunds(charge.id);
      return {
        chargeId: charge.id,
        amountCents: charge.amount,
        amountRefundedCents: charge.amount_refunded,
        refunded: charge.refunded,
        disputed: charge.disputed,
        refunds,
      };
    },
    async listRefunds(chargeId) {
      const page = await stripe.refunds.list({ charge: chargeId, limit: 100 });
      return page.data.map((r) => ({
        id: r.id,
        amountCents: r.amount,
        reason: r.reason ?? null,
        createdAt: new Date(r.created * 1000).toISOString(),
      }));
    },
  };
}

/**
 * DECISION 4 (2026-09-10, Brian's ruling). The stub takes money from nobody and confirms every
 * checkout; it is a test double. It loads under NODE_ENV=test and nowhere else, and never on a
 * box that holds a live key. The reason is returned as a sentence so a boot failure says what
 * was wrong instead of "adapter error".
 */
export function stubRefusalReason(config: Pick<Config, 'STRIPE_MODE' | 'NODE_ENV' | 'STRIPE_SECRET_KEY'>): string | null {
  if (config.STRIPE_MODE !== 'stub') return null;
  if (/^[rs]k_live_/.test(config.STRIPE_SECRET_KEY ?? '')) {
    return 'refusing to load the STUB Stripe adapter: a LIVE Stripe key is present (STRIPE_SECRET_KEY starts with sk_live_). Set STRIPE_MODE=live, or remove the key.';
  }
  if (config.NODE_ENV !== 'test') {
    return `refusing to load the STUB Stripe adapter under NODE_ENV=${config.NODE_ENV}: the stub confirms every checkout without charging anyone and is allowed only under NODE_ENV=test. Set STRIPE_MODE=live with a real key, or run as test.`;
  }
  return null;
}

export function makeStripeAdapter(config: Config): StripeAdapter {
  const refusal = stubRefusalReason(config);
  if (refusal) throw new Error(refusal);
  return config.STRIPE_MODE === 'live' ? liveAdapter(config) : stubAdapter(config.STRIPE_WEBHOOK_ENDPOINT_ID ?? null);
}
