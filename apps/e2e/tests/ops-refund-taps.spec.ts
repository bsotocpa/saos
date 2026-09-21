/*
 * THE REFUND DOOR, TAPPED (Brian, ruling R29, 2026-09-20) — path D step D3, at 390 × 844 and 1280 × 800.
 *
 * Every refund Soto has ever made was made in the Stripe dashboard, and SAOS found out afterwards —
 * from a webhook if it was listening, from a nightly drift check if it was not. R29 puts the control
 * where the money is: on a paid invoice in Ops, under billing.manage.
 *
 * WHAT THIS TAP PROVES THAT THE API SPEC CANNOT. The api spec proves the door: bounds, actor, gate,
 * reconciliation, 403. This proves a person can reach it and read the result — the control is on the
 * paid row, the modal opens on the refundable balance so the common case is one tap, the reason is
 * required before the button will fire, and the ROW AFTERWARDS SAYS WHAT HAPPENED: partly refunded,
 * the amount, the reason, and the person. A refund that does not say who made it is how a firm
 * discovers, months later, that it has no refund policy.
 *
 * THEN STRIPE CATCHES UP. The charge.refunded event for the SAME refund id is posted the way Stripe
 * posts it (shared secret, /webhooks/stripe — an API call, annotated as one, never a tap), and the
 * assertion is that nothing doubles: one refund row, one receipt, the webhook answering "reconciled,
 * and this one was ours".
 *
 * Each viewport issues and pays its own invoice: the two projects run sequentially against ONE
 * harness database, so a shared subject would be consumed by the phone and missing on the desk.
 *
 * NOTHING PAYABLE IS LEFT BEHIND. Both invoices this spec issues are PAID by the event it posts
 * (and one is then partly refunded), and neither a paid nor a partly refunded invoice offers the
 * client a Pay button — so the portal walk still finds exactly the payable invoices it expects.
 *
 * ROLE PROOF: the bookkeeper holds no billing.manage. The Invoices card does not load for her at
 * all, so there is no Refund to tap, and POST /invoices/:id/refund answers 403.
 *
 * THE SWITCH (2026-09-20, step D3b). The control is OFF in production until the adapter's real
 * refund call is proven against Stripe's test-mode API. The harness boots with it ON (the taps
 * above) and this spec flips it OFF through the harness's own /harness/refund-control for one test:
 * the paid row then reads exactly one sentence where the button was, the button is nowhere on the
 * page, and the route refuses with the same sentence from the page's own session. The flip goes
 * back in a finally, so every spec after this one finds the door open again.
 */
import { expect, test, type Page } from '@playwright/test';
import * as OTPAuth from 'otpauth';
import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..', '..', '..');
interface Persona { email: string; password: string; totpSecret: string }
const fixtures = JSON.parse(readFileSync(resolve(here, '..', '.artifacts', 'fixtures.json'), 'utf8')) as {
  port: number;
  contactId: string;
  staff: Persona;
  scorp: { invoiceItemCode: string; webhookSecret: string };
  wall: { bookkeeper: Persona };
};
const API = `http://localhost:${fixtures.port}`;
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago' }).format(new Date());

const REFUND_CONTROL =
  '/clients/:id Invoices card, paid row, button "Refund…" → ask() modal (amount in dollars prefilled with the refundable balance, required reason), button "Refund"';
const REFUND_ROLES = 'ceo, comms_billing (billing.manage)';

interface InvoiceRow {
  id: string;
  invoice_number: string;
  status: string;
  amount_paid_cents: number;
  amount_refunded_cents: number;
  refundable_cents: number;
  refund_stripe_id: string | null;
  refund_reason: string | null;
  refunded_by: string | null;
  notices: Array<{ kind: string; state: string }>;
}

async function signIn(page: Page, who: Persona): Promise<void> {
  const code = new OTPAuth.TOTP({ algorithm: 'SHA1', digits: 6, period: 30, secret: OTPAuth.Secret.fromBase32(who.totpSecret) }).generate();
  await page.goto('/login');
  const status = await page.evaluate(async ({ email, password, totp }) => {
    const r = await fetch('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password, totp }) });
    sessionStorage.setItem('saos_staff_authed', '1');
    return r.status;
  }, { email: who.email, password: who.password, totp: code });
  expect(status, `${who.email} signs in`).toBe(200);
}

/** A staff bearer token straight from the harness API, for the setup this spec does not tap. */
async function staffToken(who: Persona = fixtures.staff): Promise<string> {
  const totp = new OTPAuth.TOTP({ algorithm: 'SHA1', digits: 6, period: 30, secret: OTPAuth.Secret.fromBase32(who.totpSecret) }).generate();
  const r = await fetch(`${API}/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: who.email, password: who.password, totp: totp }),
  });
  expect(r.status, `${who.email} signs in on the harness API`).toBe(200);
  return ((await r.json()) as { token: string }).token;
}
async function asStaff<T>(token: string, path: string, init: RequestInit = {}): Promise<T> {
  const r = await fetch(`${API}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, ...(init.headers ?? {}) },
  });
  const body = (await r.json().catch(() => ({}))) as T;
  expect(r.status, `${init.method ?? 'GET'} ${path}: ${JSON.stringify(body)}`).toBeLessThan(300);
  return body;
}
/** The invoice as the client page reads it — the same GET /invoices the card renders from. */
async function invoiceRow(token: string, invoiceId: string): Promise<InvoiceRow> {
  const { invoices } = await asStaff<{ invoices: InvoiceRow[] }>(token, `/invoices?contactId=${fixtures.contactId}`);
  const row = invoices.find((i) => i.id === invoiceId);
  expect(row, 'the invoice is in the list the card renders from').toBeTruthy();
  return row!;
}
/** Stripe's call, exactly as Stripe makes it: the shared secret and the raw event body. */
async function postEvent(event: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  const r = await fetch(`${API}/webhooks/stripe`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-webhook-secret': fixtures.scorp.webhookSecret },
    body: JSON.stringify(event),
  });
  return { status: r.status, body: (await r.json().catch(() => ({}))) as Record<string, unknown> };
}
/** An issued invoice for the harness client, priced from the price book by item code, then PAID. */
async function paidInvoice(token: string, viewport: string, tag: string) {
  const issued = await asStaff<{ id: string; invoiceNumber: string; totalCents: number }>(token, '/invoices', {
    method: 'POST',
    body: JSON.stringify({ contactId: fixtures.contactId, lines: [{ code: fixtures.scorp.invoiceItemCode }], send: true }),
  });
  expect(issued.totalCents, 'the price book gave the line an amount').toBeGreaterThan(0);
  const paid = await postEvent({
    id: `evt_harness_refund_${tag}_paid_${viewport}`,
    type: 'checkout.session.completed',
    data: { object: { id: `cs_stub_${issued.id}`, payment_intent: `pi_harness_refund_${tag}_${viewport}`, metadata: { invoice_id: issued.id } } },
  });
  expect(paid.status, 'the payment event').toBeLessThan(300);
  return issued;
}
function keepScreenshot(name: string, passed: boolean, file: string): string {
  const dir = passed ? resolve(here, '..', '.artifacts', today) : resolve(root, 'tasks', 'walks', today);
  mkdirSync(dir, { recursive: true });
  const target = resolve(dir, `${name}.png`);
  if (existsSync(file)) copyFileSync(file, target);
  return target;
}
const money = (cents: number) => `$${(cents / 100).toFixed(2)}`;

test.describe('Ops → the refund door', () => {
  test('D3: the CEO refunds part of a paid invoice, the row says how much and why and who, and Stripe reconciles to it', async ({ page }, testInfo) => {
    const viewport = testInfo.project.name;
    const shot = testInfo.outputPath(`refund-invoice-${viewport}.png`);
    const reason = `harness walk ${viewport}: the client was billed for a month of bookkeeping that never started`;
    let passed = false;
    try {
      const token = await staffToken();
      const issued = await paidInvoice(token, viewport, 'tap');
      const before = await invoiceRow(token, issued.id);
      expect(before.status, 'the subject is paid before anyone refunds it').toBe('paid');
      expect(before.refundable_cents, 'and all of it is refundable').toBe(issued.totalCents);
      const me = await asStaff<{ fullName: string }>(token, '/auth/me');
      // A partial refund: a quarter of it, rounded to whole cents, so the row must read "X of Y".
      const partCents = Math.max(1, Math.round(issued.totalCents / 4));

      await signIn(page, fixtures.staff);
      await page.goto(`/clients/${fixtures.contactId}`);
      await expect(page.getByRole('heading', { name: /Invoices \(/ })).toBeVisible();

      // Scoped to the Invoices card's own rows: the number appears in a send-log line too.
      const invoicesCard = page.locator('section.card', { has: page.getByRole('heading', { name: /Invoices \(/ }) });
      const row = invoicesCard.locator('ul.list > li', { hasText: issued.invoiceNumber });
      await expect(row, 'the paid invoice is on the client page').toBeVisible();
      await expect(row.locator('.badge').first(), 'and it reads Paid').toHaveText('Paid');

      // A real tap: scrolled into view, hit-tested, refused if anything covers it.
      await row.getByRole('button', { name: 'Refund…' }).click();
      const modal = page.locator('[role=dialog]');
      await expect(modal).toBeVisible();
      await expect(modal.getByRole('heading', { name: `Refund ${issued.invoiceNumber}?` })).toBeVisible();
      // The amount opens on the whole refundable balance: the common case is one tap.
      const amount = modal.getByTestId(`refund-amount-${issued.id}`);
      await expect(amount, 'the amount is prefilled with what is still refundable').toHaveValue((issued.totalCents / 100).toFixed(2));
      // The reason is the record: the action is unreachable until it is written.
      await expect(modal.getByRole('button', { name: 'Refund' })).toBeDisabled();
      await amount.fill((partCents / 100).toFixed(2));
      await modal.locator('textarea').fill(reason);
      await modal.getByRole('button', { name: 'Refund' }).click();
      await expect(modal).toHaveCount(0);

      await expect(page.getByText(`${money(partCents)} refunded on ${issued.invoiceNumber}`), 'the page says what moved').toBeVisible();

      /*
       * THE ROW, re-read after the reload the handler triggers: the amount of what, then the reason,
       * then the person, then the day (lib/invoice-display.ts) — the same shape a void row has.
       */
      const refunded = invoicesCard.locator('ul.list > li', { hasText: issued.invoiceNumber });
      await expect(refunded.locator('.badge').first(), 'the badge reads the word, not the enum').toHaveText('Partly refunded');
      const line = refunded.locator('.invoice-meta .muted.small').first();
      await expect(line, 'the line says how much of what').toContainText(`partially refunded ${money(partCents)} of ${money(issued.totalCents)}`);
      await expect(line, 'and carries the reason').toContainText(reason);
      await expect(line, 'and the actor, as a name').toContainText(me.fullName);
      await expect(line, 'never an email address').not.toContainText('@');

      const afterTap = await invoiceRow(token, issued.id);
      expect(afterTap.status, 'the server agrees with the row').toBe('partially_refunded');
      expect(afterTap.amount_refunded_cents, 'and with the amount').toBe(partCents);
      expect(afterTap.refundable_cents, 'the rest is still refundable').toBe(issued.totalCents - partCents);
      expect(afterTap.refunded_by, 'the refund carries the person who made it').toBe(me.fullName);
      expect(afterTap.refund_stripe_id, 'and Stripe\'s own refund id').toBeTruthy();
      const receiptsAfterTap = afterTap.notices.filter((n) => n.kind === 'refund_receipt');
      expect(receiptsAfterTap.length, 'exactly one refund receipt was raised').toBe(1);

      /*
       * STRIPE CATCHES UP. charge.refunded for the SAME refund id, cumulative amount as Stripe
       * reports it. Nothing may double: no second row, no second receipt, and the webhook says so.
       */
      const refundId = afterTap.refund_stripe_id!;
      const event = await postEvent({
        id: `evt_harness_refund_tap_charge_${viewport}`,
        type: 'charge.refunded',
        data: {
          object: {
            id: `ch_harness_refund_${viewport}`,
            object: 'charge',
            payment_intent: `pi_harness_refund_tap_${viewport}`,
            amount: issued.totalCents,
            amount_refunded: partCents,
            refunded: false,
            disputed: false,
            refunds: { object: 'list', data: [{ id: refundId, object: 'refund', amount: partCents, charge: `ch_harness_refund_${viewport}`, created: Math.floor(Date.now() / 1000), reason: 'requested_by_customer', status: 'succeeded' }] },
          },
        },
      });
      expect(event.status, 'Stripe\'s event is accepted').toBeLessThan(300);
      expect(event.body.status, 'the invoice still reads partly refunded').toBe('partially_refunded');
      expect(event.body.recorded, 'no new refund row: the door already made this one').toBe(0);
      expect(event.body.reconciled, 'the existing row was updated in place').toBe(1);
      expect(event.body.reconciledToTheDoor, 'and the webhook knows the refund was ours').toBe(true);

      const afterEvent = await invoiceRow(token, issued.id);
      expect(afterEvent.amount_refunded_cents, 'the amount did not double').toBe(partCents);
      expect(afterEvent.refunded_by, 'and the refund still belongs to the person who pressed it').toBe(me.fullName);
      expect(afterEvent.notices.filter((n) => n.kind === 'refund_receipt').length, 'still exactly one receipt').toBe(1);
      /*
       * The send log a person opens under the invoice: one refund receipt, whatever state it is in.
       * The log is outbox rows PLUS delivery audit rows (invoice.refund_receipt_sent), and the harness
       * sweeps the outbox every two seconds — so the receipt is one outbox row, and its delivery row is
       * there or not depending on whether the sweep has ticked (2026-09-20: the desk viewport read two
       * matches for one receipt because the sweep had delivered it; the phone read one because it had
       * not). Counted by source, the assertion is about the receipt, not the clock.
       */
      const log = await asStaff<{ rows: Array<{ source: string; what: string }> }>(token, `/invoices/${issued.id}/sends`);
      expect(log.rows.filter((r) => r.source === 'outbox' && r.what.startsWith('invoice.refund_receipt')).length, 'one receipt on the send log').toBe(1);
      expect(log.rows.filter((r) => r.source === 'audit' && r.what === 'invoice.refund_receipt_sent').length, 'delivered at most once').toBeLessThanOrEqual(1);

      await page.screenshot({ path: shot, fullPage: true });
      passed = true;
    } finally {
      if (!existsSync(shot)) await page.screenshot({ path: shot, fullPage: true }).catch(() => undefined);
      testInfo.annotations.push({ type: passed ? 'artifact' : 'failure-screenshot', description: keepScreenshot(`refund-invoice-${viewport}`, passed, shot) });
      testInfo.annotations.push({ type: 'walk-step', description: `D3|${REFUND_CONTROL}|${REFUND_ROLES}|tap` });
      testInfo.annotations.push({ type: 'walk-step', description: `D3|the charge.refunded event posted to /webhooks/stripe for the refund the door made (Stripe's call, not a tap)|Stripe|api` });
    }
  });

  test('D3b: with the Refund control off, the paid row reads one sentence, offers no Refund button, and the route refuses', async ({ page }, testInfo) => {
    const viewport = testInfo.project.name;
    const shot = testInfo.outputPath(`refund-off-${viewport}.png`);
    const SENTENCE = 'Refunds are made in Stripe and recorded here.';
    let passed = false;
    const token = await staffToken();
    // A PAID invoice, so the sentence is about the switch and not about the state.
    const paid = await paidInvoice(token, viewport, 'off');
    expect((await invoiceRow(token, paid.id)).status, 'the subject is refundable').toBe('paid');
    // The harness's own flip: one API process, both states.
    const flip = async (state: 'on' | 'off'): Promise<string> => {
      const r = await fetch(`${API}/harness/refund-control`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ state }) });
      const body = (await r.json().catch(() => ({}))) as { opsRefundControl?: string };
      if (r.status !== 200) throw new Error(`the harness flip answered ${r.status}: ${JSON.stringify(body)}`);
      return body.opsRefundControl ?? '';
    };
    expect(await flip('off'), 'the switch is off for this test').toBe('off');
    try {
      const me = await asStaff<{ switches?: { opsRefundControl?: string } }>(token, '/auth/me');
      expect(me.switches?.opsRefundControl, 'the session reports the state the page decides from').toBe('off');

      await signIn(page, fixtures.staff);
      await page.goto(`/clients/${fixtures.contactId}`);
      await expect(page.getByRole('heading', { name: /Invoices \(/ })).toBeVisible();
      const invoicesCard = page.locator('section.card', { has: page.getByRole('heading', { name: /Invoices \(/ }) });
      const row = invoicesCard.locator('ul.list > li', { hasText: paid.invoiceNumber });
      await expect(row, 'the paid invoice is on the client page').toBeVisible();
      await expect(row.locator('.badge').first(), 'and it reads Paid').toHaveText('Paid');

      // The one sentence, where the button would be — and nothing else that says refund on the row.
      await expect(row.getByTestId(`refund-off-${paid.id}`), 'the row says where refunds are made').toHaveText(SENTENCE);
      await expect(row.getByText(SENTENCE), 'exactly one sentence').toHaveCount(1);
      await expect(row.getByRole('button', { name: 'Refund…' }), 'no Refund button on the row').toHaveCount(0);
      await expect(page.getByRole('button', { name: 'Refund…' }), 'and none anywhere on the page').toHaveCount(0);
      await expect(page.getByTestId(`refund-invoice-${paid.id}`)).toHaveCount(0);

      // The route, from the page's own session: the same sentence, and nothing moves.
      const refused = await page.evaluate(async (invoiceId) => {
        const r = await fetch(`/api/invoices/${invoiceId}/refund`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ amountCents: 100, reason: 'A switch proof: this refund must be refused while the control is off.' }),
        });
        return { status: r.status, body: (await r.json().catch(() => ({}))) as { error?: string; message?: string } };
      }, paid.id);
      expect(refused.status, 'the door is closed').toBe(409);
      expect(refused.body.error).toBe('refund_control_off');
      expect(refused.body.message, 'with the sentence the row shows').toBe(SENTENCE);
      const after = await invoiceRow(token, paid.id);
      expect(after.status, 'nothing moved').toBe('paid');
      expect(after.amount_refunded_cents, 'and no money went back').toBe(0);

      await page.screenshot({ path: shot, fullPage: true });
      passed = true;
    } finally {
      // Back on, whatever happened above: every spec after this one finds the door open.
      const back = await flip('on');
      if (!existsSync(shot)) await page.screenshot({ path: shot, fullPage: true }).catch(() => undefined);
      testInfo.annotations.push({ type: passed ? 'artifact' : 'failure-screenshot', description: keepScreenshot(`refund-off-${viewport}`, passed, shot) });
      testInfo.annotations.push({
        type: 'walk-step',
        description: `D3b|/clients/:id Invoices card, paid row: the sentence "${SENTENCE}" (data-testid refund-off-<id>) where the button was, no "Refund…" button on the page; POST /invoices/:id/refund 409 with the same sentence; switch flipped back to ${back}|${REFUND_ROLES}|tap`,
      });
    }
  });

  test('role proof: the bookkeeper has no Refund control and the route refuses her', async ({ page }, testInfo) => {
    const viewport = testInfo.project.name;
    const token = await staffToken();
    // A PAID invoice, so the absence of the control is about her role and not about the state.
    const paid = await paidInvoice(token, viewport, 'wall');
    expect((await invoiceRow(token, paid.id)).status, 'the subject is refundable').toBe('paid');

    await signIn(page, fixtures.wall.bookkeeper);
    await page.goto(`/clients/${fixtures.contactId}`);
    await expect(page.getByRole('heading', { name: /Invoices \(/ })).toBeVisible();
    await expect(page.getByText(paid.invoiceNumber), 'the invoice is not on her page').toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Refund…' }), 'and no Refund control anywhere on it').toHaveCount(0);

    const refused = await page.evaluate(async (invoiceId) => {
      const r = await fetch(`/api/invoices/${invoiceId}/refund`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ amountCents: 100, reason: 'A role proof: this refund must be refused.' }),
      });
      return r.status;
    }, paid.id);
    expect(refused, 'the refund door refuses a role without billing.manage').toBe(403);
    // It stayed paid: her refusal moved nothing, and a paid invoice offers the client no Pay button,
    // so the portal walk is left exactly the payable invoices it expects.
    const after = await invoiceRow(token, paid.id);
    expect(after.status, 'nothing moved').toBe('paid');
    expect(after.amount_refunded_cents, 'and no money went back').toBe(0);

    testInfo.annotations.push({
      type: 'walk-step',
      description: `D3|role proof: bookkeeper sees no invoice and no Refund control, POST /invoices/:id/refund refused 403|${REFUND_ROLES}|tap`,
    });
  });
});
