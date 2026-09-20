/*
 * THE PAY CONTROL, AND WHAT TWO CHECKOUTS MUST NOT DO (Brian, 2026-09-19 evening, BUILD 2).
 *
 * A10 in the dry run proves the tap once, on the final-fee invoice. This proves the thing that
 * actually goes wrong with a payment control: a client opens Checkout, changes their mind, comes
 * back and opens it again. Two sessions now exist for one invoice. The invoice must still be
 * payable after both taps — nothing is owed twice and nothing is marked paid on a tap — and when
 * the money finally arrives it must be recorded ONCE, whichever session it arrives under.
 *
 *   tap Pay        → the API mints a Checkout session and the page navigates to it. The harness
 *                    intercepts that navigation and fulfils it itself, so no external host is ever
 *                    loaded; it asserts the URL the API returned.
 *   leave, tap Pay → a second session for the same invoice. Still status sent, still nothing paid,
 *                    on the page and through the client's own GET.
 *   the event       → checkout.session.completed, posted with the harness webhook secret, is what
 *                    moves the money. Exactly one payment: the invoice paid in full, one payment
 *                    receipt on its send log.
 *   the other event→ a completed event for the OTHER session, afterwards, records nothing further.
 *                    The guard is on the invoice, not on the session id, which is what makes a
 *                    Stripe redelivery and a second session equally harmless.
 *
 * STRIPE_MODE is stub here, so the host is checkout.stripe.example and the stub mints one session
 * id per invoice (`cs_stub_<invoice>`) — both taps legitimately return the same one. The second
 * event therefore carries a session id of its own, which is what a live second session would look
 * like and is the stronger assertion: the second payment is refused because the INVOICE is paid.
 * Under a live test key the host and both ids would be Stripe's; the control and every assertion
 * below are unchanged.
 *
 * The invoice is made for this spec through the staff route, from the price book (no literal
 * amount anywhere), so nothing else's state is spent paying it.
 */
import { expect, test, type Page } from '@playwright/test';
import * as OTPAuth from 'otpauth';
import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..', '..', '..');
interface Persona { email: string; password: string; totpSecret: string }
interface ScorpOwner {
  contactId: string; ownerEmail: string; portalMagicTokens: string[];
  invoiceItemCode: string; webhookSecret: string; apiPort: number;
}
const fixtures = JSON.parse(readFileSync(resolve(here, '..', '.artifacts', 'fixtures.json'), 'utf8')) as {
  staff: Persona;
  portalPort?: number;
  scorp: ScorpOwner; scorpDesk: ScorpOwner;
};
const ownerFor = (project: string): ScorpOwner => (project === 'desk' ? fixtures.scorpDesk : fixtures.scorp);
const API = `http://127.0.0.1:${fixtures.scorp.apiPort ?? 3101}`;
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago' }).format(new Date());
const CHECKOUT_HOST = 'https://checkout.stripe.example';

test.use({ baseURL: `http://localhost:${fixtures.portalPort ?? 3106}` });

/** A staff session on the harness API, for the two things only staff may do here: issue the invoice and read its send log. */
async function staffToken(): Promise<string> {
  const totp = new OTPAuth.TOTP({ algorithm: 'SHA1', digits: 6, period: 30, secret: OTPAuth.Secret.fromBase32(fixtures.staff.totpSecret) }).generate();
  const r = await fetch(`${API}/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: fixtures.staff.email, password: fixtures.staff.password, totp }),
  });
  expect(r.status, 'the staff login on the harness API').toBe(200);
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
async function signIn(page: Page, token: string): Promise<void> {
  await page.goto('/login');
  const status = await page.evaluate(async (t) => {
    const r = await fetch('/api/portal/auth/magic/verify', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: t }) });
    localStorage.setItem('saos_portal_authed', '1');
    return r.status;
  }, token);
  expect(status, 'redeeming the sign-in link the client was emailed').toBe(200);
}
/** The client's own view of their invoices — the same read the page makes, from the same session. */
async function clientInvoice(page: Page, id: string): Promise<{ status: string; amount_paid_cents: number; total_cents: number; paid_at: string | null }> {
  const list = await page.evaluate(async () => (await fetch('/api/portal/invoices')).json());
  const found = (list as { invoices: Array<{ id: string; status: string; amount_paid_cents: number; total_cents: number; paid_at: string | null }> })
    .invoices.find((i) => i.id === id);
  expect(found, 'the invoice is in the client\'s own list').toBeTruthy();
  return found!;
}
/** The completed event Stripe posts when a card clears, authenticated the way the stub adapter authenticates it. */
async function postCompleted(owner: ScorpOwner, invoiceId: string, sessionId: string, eventId: string): Promise<{ status: number; body: { alreadyPaid?: boolean } }> {
  const r = await fetch(`${API}/webhooks/stripe`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-webhook-secret': owner.webhookSecret },
    body: JSON.stringify({
      id: eventId, type: 'checkout.session.completed',
      data: { object: { id: sessionId, payment_intent: `pi_${eventId}`, metadata: { invoice_id: invoiceId } } },
    }),
  });
  return { status: r.status, body: (await r.json().catch(() => ({}))) as { alreadyPaid?: boolean } };
}
function keepScreenshot(name: string, passed: boolean, file: string): string {
  const dir = passed ? resolve(here, '..', '.artifacts', today) : resolve(root, 'tasks', 'walks', today);
  mkdirSync(dir, { recursive: true });
  const target = resolve(dir, `${name}.png`);
  if (existsSync(file)) copyFileSync(file, target);
  return target;
}
const receiptCount = (log: Array<{ what: string }>): number => log.filter((r) => r.what === 'invoice.payment_receipt_sent').length;

test.describe('portal → Pay now', () => {
  test('two checkouts, one payment: the invoice stays payable until the event, and the second event records nothing', async ({ page }, testInfo) => {
    const viewport = testInfo.project.name;
    const owner = ownerFor(viewport);
    test.setTimeout(240_000);
    const shot = testInfo.outputPath(`portal-checkout-${viewport}.png`);
    let passed = false;
    try {
      // The invoice this spec pays: issued through the staff route, priced from the book by item code.
      const token = await staffToken();
      const issued = await asStaff<{ id: string; invoiceNumber: string; totalCents: number }>(token, '/invoices', {
        method: 'POST',
        body: JSON.stringify({ contactId: owner.contactId, lines: [{ code: owner.invoiceItemCode }], send: true }),
      });
      expect(issued.totalCents, 'the price book gave the line an amount').toBeGreaterThan(0);

      // [2]: the dry run took [0] and My Returns took [1]. Three per owner is the throttle's whole budget.
      await signIn(page, owner.portalMagicTokens[2]!);

      // Nothing leaves this machine: the navigation to Checkout is fulfilled by the harness itself.
      const opened: string[] = [];
      await page.route(`${CHECKOUT_HOST}/**`, async (route) => {
        opened.push(route.request().url());
        await route.fulfill({ status: 200, contentType: 'text/html', body: '<html><body>harness: Stripe Checkout is never loaded</body></html>' });
      });

      await page.goto('/invoices');
      const row = page.locator('li', { hasText: issued.invoiceNumber });
      await expect(row, 'the issued invoice is on the client\'s page').toBeVisible();
      await expect(row.getByText('Open'), 'and it reads open').toBeVisible();

      // ── FIRST CHECKOUT.
      await row.getByRole('button', { name: 'Pay now' }).click();
      await page.waitForURL(new RegExp('checkout\\.stripe\\.example'), { timeout: 30_000 });
      expect(opened[0], 'the first tap navigated to the session the API minted for this invoice').toBe(`${CHECKOUT_HOST}/cs_stub_${issued.id}`);

      // ── LEAVING WITHOUT PAYING, then a SECOND CHECKOUT.
      await page.goto('/invoices');
      const again = page.locator('li', { hasText: issued.invoiceNumber });
      await expect(again.getByRole('button', { name: 'Pay now' }), 'the control is still there: a tap is not a payment').toBeVisible();
      await again.getByRole('button', { name: 'Pay now' }).click();
      await page.waitForURL(new RegExp('checkout\\.stripe\\.example'), { timeout: 30_000 });
      expect(opened.length, 'a second checkout was opened').toBe(2);
      expect(opened[1], 'for the same invoice').toBe(`${CHECKOUT_HOST}/cs_stub_${issued.id}`);

      // ── STILL PAYABLE, on the page and through the client's own read.
      await page.goto('/invoices');
      const stillOpen = page.locator('li', { hasText: issued.invoiceNumber });
      await expect(stillOpen.getByText('Open'), 'the page still says open after two checkouts').toBeVisible();
      await expect(stillOpen.getByText('Paid'), 'and does not say paid').toHaveCount(0);
      await expect(stillOpen.getByRole('button', { name: 'Pay now' })).toBeVisible();
      const before = await clientInvoice(page, issued.id);
      expect(before.status, 'sent — issued and unpaid').toBe('sent');
      expect(before.amount_paid_cents, 'nothing has been paid').toBe(0);
      expect(before.paid_at, 'and nothing is dated paid').toBeNull();

      // ── THE EVENT that actually moves the money, for the session the taps opened.
      const first = await postCompleted(owner, issued.id, `cs_stub_${issued.id}`, `evt_harness_checkout_${viewport}_1`);
      expect(first.status, 'the completed event is accepted').toBeLessThan(300);
      expect(first.body.alreadyPaid, 'this is the payment, not a redelivery').toBe(false);

      const paid = await clientInvoice(page, issued.id);
      expect(paid.status, 'paid').toBe('paid');
      expect(paid.amount_paid_cents, 'in full, and not a cent more').toBe(issued.totalCents);
      expect(paid.total_cents, 'the total did not move').toBe(issued.totalCents);
      const log = await asStaff<{ rows: Array<{ what: string }> }>(token, `/invoices/${issued.id}/sends`);
      expect(receiptCount(log.rows), 'one payment receipt on the send log').toBe(1);
      const staffView = await asStaff<{ invoices: Array<{ id: string; notices: Array<{ kind: string; state: string }> }> }>(token, `/invoices?contactId=${owner.contactId}`);
      const notices = staffView.invoices.find((i) => i.id === issued.id)!.notices.filter((n) => n.kind === 'payment_receipt');
      expect(notices.length, 'one receipt, in one state').toBe(1);
      expect(notices[0]!.state, 'delivered').toBe('delivered');

      // The page agrees, reopened the way the client would reopen it.
      await page.goto('/invoices');
      const settled = page.locator('li', { hasText: issued.invoiceNumber });
      await expect(settled.getByText('Paid'), 'the client reads paid').toBeVisible();
      await expect(settled.getByRole('button', { name: 'Pay now' }), 'and is not offered a second checkout').toHaveCount(0);
      await page.screenshot({ path: shot, fullPage: true });

      // ── THE OTHER SESSION'S EVENT, afterwards. The guard is the invoice, not the session id.
      const second = await postCompleted(owner, issued.id, `cs_stub_second_${issued.id}`, `evt_harness_checkout_${viewport}_2`);
      expect(second.status, 'acknowledged, so Stripe stops retrying').toBeLessThan(300);
      expect(second.body.alreadyPaid, 'recognised as already paid').toBe(true);
      const after = await clientInvoice(page, issued.id);
      expect(after.amount_paid_cents, 'still paid exactly once').toBe(issued.totalCents);
      expect(after.paid_at, 'and the payment kept its own time').toBe(paid.paid_at);
      const logAfter = await asStaff<{ rows: Array<{ what: string }> }>(token, `/invoices/${issued.id}/sends`);
      expect(receiptCount(logAfter.rows), 'still one receipt — the client is not thanked twice').toBe(1);
      passed = true;
    } finally {
      if (!existsSync(shot)) await page.screenshot({ path: shot, fullPage: true }).catch(() => undefined);
      testInfo.annotations.push({ type: passed ? 'artifact' : 'failure-screenshot', description: keepScreenshot(`portal-checkout-${viewport}`, passed, shot) });
    }
  });
});
