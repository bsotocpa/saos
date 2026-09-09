/*
 * THE PAY LINK (2026-09-09, Brian's ruling).
 *
 * The invoice email used to link to the portal's Invoices page, behind a portal login — and
 * a brand-new lead who has just accepted a quote has no portal account. The link is now its
 * own credential: a random token scoped to ONE invoice. No login. Stripe Checkout is the
 * authentication; the page shows the invoice number and the amount and a Pay button, and
 * nothing else.
 *
 *   · Issued when an invoice is first sent; every later reminder carries the SAME link (the
 *     token is stored encrypted so it can be re-read — rotating it would kill the link in
 *     the email the client already has).
 *   · Dies on paid or on void only (Brian's ruling, 2026-09-09 overnight: the 90-day expiry
 *     is gone — an unpaid invoice stays payable from the link the client has). A dead token
 *     gets a plain "no longer payable" page with no invoice data on it.
 *   · The portal invite (a magic link to the client's account) is a separate onboarding event
 *     and is untouched.
 */

import type { FastifyInstance } from 'fastify';
import { writeAudit } from '../../audit.ts';
import { decryptSecret, encryptSecret, generateToken, hashToken } from '../../crypto.ts';
import { AppError } from '../../types.ts';

/** Retired 2026-09-09: the link dies on paid or void only. Kept so old audit rows still read. */
export const PAY_TOKEN_DAYS: number | null = null;

/**
 * The URL to put in an email for this invoice. Reuses the live token; issues a fresh one
 * when there is none, or the old one has expired or been revoked (a re-sent invoice after
 * a long silence gets a working link, not a dead one).
 */
export async function payLinkFor(app: FastifyInstance, invoiceId: string): Promise<string> {
  const { rows } = await app.db.query<{
    pay_token_enc: Buffer | null; pay_token_expires_at: Date | null; pay_token_revoked_at: Date | null;
  }>(
    `SELECT pay_token_enc, pay_token_expires_at, pay_token_revoked_at FROM invoices WHERE id = $1`,
    [invoiceId]
  );
  const inv = rows[0];
  if (!inv) throw new AppError(404, 'not_found', 'Invoice not found.');

  // Live = issued and not revoked. Age is not a reason (dies on paid or void only).
  const live = inv.pay_token_enc !== null && inv.pay_token_revoked_at === null;

  let token: string;
  if (live) {
    token = decryptSecret(inv.pay_token_enc!, app.config.APP_ENCRYPTION_KEY);
  } else {
    const fresh = generateToken();
    token = fresh.token;
    await app.db.query(
      `UPDATE invoices
          SET pay_token_hash = $2, pay_token_enc = $3,
              pay_token_expires_at = NULL, pay_token_revoked_at = NULL
        WHERE id = $1`,
      [invoiceId, fresh.hash, encryptSecret(token, app.config.APP_ENCRYPTION_KEY)]
    );
    await writeAudit(app.db, {
      actorType: 'system',
      actorLabel: 'pay link',
      action: 'invoice.pay_link_issued',
      objectType: 'invoice',
      objectId: invoiceId,
      details: { expires: 'never — dies on paid or void only' },
    });
  }
  return `${app.config.PORTAL_BASE_URL}/pay/${token}`;
}

/** Kill the link: paid, void, or a staff decision. Idempotent. */
export async function revokePayToken(app: FastifyInstance, invoiceId: string): Promise<void> {
  await app.db.query(
    `UPDATE invoices SET pay_token_revoked_at = now() WHERE id = $1 AND pay_token_revoked_at IS NULL`,
    [invoiceId]
  );
}

/** What the pay page is allowed to know. `unavailable` carries nothing at all. */
export type PayView =
  | { state: 'payable'; invoiceNumber: string; amountCents: number; dueDate: string | null; language: 'en' | 'es' }
  | { state: 'paid'; invoiceNumber: string; language: 'en' | 'es' }
  | { state: 'unavailable' };

interface TokenRow {
  id: string; invoice_number: string; status: string; total_cents: number; due_date: string | null;
  contact_id: string; email: string | null; language: 'en' | 'es';
  pay_token_expires_at: Date | null; pay_token_revoked_at: Date | null;
}

/** The invoice behind a token, and whether the token still opens it. Never returns a dead one. */
export async function invoiceByPayToken(
  app: FastifyInstance,
  token: string
): Promise<{ view: PayView; invoice: TokenRow | null }> {
  const { rows } = await app.db.query<TokenRow>(
    `SELECT i.id, i.invoice_number, i.status::text AS status, i.total_cents, to_char(i.due_date, 'YYYY-MM-DD') AS due_date,
            i.contact_id, c.email, c.language, i.pay_token_expires_at, i.pay_token_revoked_at
       FROM invoices i JOIN contacts c ON c.id = i.contact_id
      WHERE i.pay_token_hash = $1`,
    [hashToken(token)]
  );
  const inv = rows[0];
  if (!inv) return { view: { state: 'unavailable' }, invoice: null };

  // Paid is the one dead state the page may name: the client has just paid and is looking
  // at the return page. Everything else — void, refunded, expired, revoked — says nothing.
  if (inv.status === 'paid') return { view: { state: 'paid', invoiceNumber: inv.invoice_number, language: inv.language }, invoice: inv };

  // Revoked (paid or void) is the only death; age is not one (2026-09-09 overnight ruling).
  if (inv.pay_token_revoked_at !== null) return { view: { state: 'unavailable' }, invoice: null };
  if (inv.status !== 'sent' && inv.status !== 'overdue') return { view: { state: 'unavailable' }, invoice: null };

  return {
    view: { state: 'payable', invoiceNumber: inv.invoice_number, amountCents: inv.total_cents, dueDate: inv.due_date, language: inv.language },
    invoice: inv,
  };
}
