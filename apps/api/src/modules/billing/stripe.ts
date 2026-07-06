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

export interface PaymentEvent {
  type: 'payment_completed' | 'ignored';
  invoiceId?: string | undefined;
  checkoutSessionId?: string | undefined;
  paymentIntentId?: string | undefined;
}

export interface StripeAdapter {
  readonly mode: 'stub' | 'live';
  createCheckoutSession(input: CheckoutInput): Promise<{ sessionId: string; url: string }>;
  /** Verify + parse a webhook. `rawBody` is the unparsed request body. */
  parseWebhookEvent(headers: Record<string, string | string[] | undefined>, rawBody: Buffer, sharedSecret: string): PaymentEvent;
}

function stubAdapter(): StripeAdapter {
  return {
    mode: 'stub',
    async createCheckoutSession(input) {
      const sessionId = `cs_stub_${input.invoiceId}`;
      return { sessionId, url: `https://checkout.stripe.example/${sessionId}` };
    },
    parseWebhookEvent(headers, rawBody, sharedSecret) {
      // Stub auth: same shared-secret header convention as our other webhooks.
      const secret = headers['x-webhook-secret'];
      if (secret !== sharedSecret) {
        throw new AppError(401, 'unauthorized', 'Bad webhook secret.');
      }
      const body = JSON.parse(rawBody.toString('utf8')) as {
        type?: string;
        data?: { object?: { id?: string; payment_intent?: string; metadata?: { invoice_id?: string } } };
      };
      if (body.type !== 'checkout.session.completed') return { type: 'ignored' };
      return {
        type: 'payment_completed',
        invoiceId: body.data?.object?.metadata?.invoice_id,
        checkoutSessionId: body.data?.object?.id,
        paymentIntentId: body.data?.object?.payment_intent,
      };
    },
  };
}

function liveAdapter(config: Config): StripeAdapter {
  // No explicit apiVersion: the SDK pins the API version it ships with.
  const stripe = new Stripe(config.STRIPE_SECRET_KEY ?? '');
  return {
    mode: 'live',
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
    parseWebhookEvent(headers, rawBody) {
      const signature = headers['stripe-signature'];
      if (typeof signature !== 'string' || !this.mode) {
        throw new AppError(401, 'unauthorized', 'Missing Stripe signature.');
      }
      let event: Stripe.Event;
      try {
        // THE signature verification (M13 prove-it): rejects forged payloads.
        event = stripe.webhooks.constructEvent(rawBody, signature, config.STRIPE_WEBHOOK_SECRET ?? '');
      } catch {
        throw new AppError(401, 'unauthorized', 'Stripe signature verification failed.');
      }
      if (event.type !== 'checkout.session.completed') return { type: 'ignored' };
      const session = event.data.object as Stripe.Checkout.Session;
      return {
        type: 'payment_completed',
        invoiceId: session.metadata?.invoice_id,
        checkoutSessionId: session.id,
        paymentIntentId: typeof session.payment_intent === 'string' ? session.payment_intent : undefined,
      };
    },
  };
}

export function makeStripeAdapter(config: Config): StripeAdapter {
  return config.STRIPE_MODE === 'live' ? liveAdapter(config) : stubAdapter();
}
