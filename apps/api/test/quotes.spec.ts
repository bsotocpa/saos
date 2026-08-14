// M27 "Prove it": the quote builder + the leads pipeline.
//
// The hard rules under test:
//   · every dollar comes from the price book — an unknown item code is REFUSED,
//     never silently priced at zero
//   · the price-book version is PINNED, so a later price change never re-prices
//     a quote a client is currently looking at
//   · accepting converts to an engagement (+ deposit invoice) with ZERO
//     re-entry — the accepted lines carry the locked prices forward
//   · declined / expired quotes return to the pipeline WITH A REASON
//   · quoting extra work to an EXISTING CLIENT never demotes them into the
//     funnel — that would count real clients as open leads and lost deals
//   · the public link is a token whose SHA-256 alone is stored

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as OTPAuth from 'otpauth';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/server.ts';
import type { Mailer } from '../src/mailer.ts';
import { createTestConfig, makeContact, makeStaff, type TestStaff } from './helpers.ts';
import type { Config } from '../src/config.ts';
import { runQuoteExpiryJob } from '../src/modules/pricing/quotes.ts';
import { pipelineMetrics, setLeadStage } from '../src/modules/pricing/pipeline.ts';
import { addDays, todayChicago } from '../src/modules/tax/deadlines.ts';

let app: FastifyInstance;
let config: Config;
let ana: TestStaff & { token: string };

const sent: Array<{ to: string; subject: string; text: string }> = [];
const capturingMailer: Mailer = {
  transport: 'console',
  async send(msg: { to: string; subject: string; text: string }) {
    sent.push({ to: msg.to, subject: msg.subject, text: msg.text });
    return { id: `captured-${sent.length}` };
  },
};
const auth = (t: { token: string }) => ({ authorization: `Bearer ${t.token}` });

async function staffWithToken(email: string, role: string): Promise<TestStaff & { token: string }> {
  const secret = new OTPAuth.Secret({ size: 20 }).base32;
  const staff = await makeStaff(app.db, config, {
    email, name: `Synthetic ${role}`, role, password: `${role}-password-123456`, totpSecret: secret,
  });
  const code = new OTPAuth.TOTP({
    algorithm: 'SHA1', digits: 6, period: 30, secret: OTPAuth.Secret.fromBase32(secret),
  }).generate();
  const res = await app.inject({ method: 'POST', url: '/auth/login', payload: { email, password: staff.password, totp: code } });
  assert.equal(res.statusCode, 200, res.body);
  return { ...staff, token: res.json().token as string };
}

before(async () => {
  config = await createTestConfig('quotes');
  app = buildServer(config, { mailer: capturingMailer });
  await app.ready();
  ana = await staffWithToken('ana-quote@example.test', 'tax_preparer');
  // Rene owns the accepted-quote onboarding task; Brian owns declines.
  await makeStaff(app.db, config, {
    email: 'rene-quote@example.test', name: 'Synthetic Rene', role: 'comms_billing',
    password: 'comms_billing-password-123456',
  });
  await makeStaff(app.db, config, {
    email: 'brian-quote@example.test', name: 'Synthetic Brian', role: 'ceo',
    password: 'ceo-password-1234567',
  });
});

after(async () => {
  await app.close();
});

test('a quote composes from the price book only — unknown codes are refused', async () => {
  const lead = await makeContact(app.db, { firstName: 'Synthetic', lastName: 'Priced', email: 'priced@example.test' });

  const bogus = await app.inject({
    method: 'POST', url: '/quotes', headers: auth(ana),
    payload: { contactId: lead.id, lines: [{ itemCode: 'MADE_UP_SERVICE' }] },
  });
  assert.equal(bogus.statusCode, 400, bogus.body);
  assert.equal(bogus.json().error, 'unknown_price_items');

  // Real codes: Single 1040 ($150) + Schedule C ($180) = $330, from the book.
  const good = await app.inject({
    method: 'POST', url: '/quotes', headers: auth(ana),
    payload: {
      contactId: lead.id,
      lines: [{ itemCode: 'IND_BASE_SINGLE' }, { itemCode: 'IND_SCH_C' }],
    },
  });
  assert.equal(good.statusCode, 201, good.body);
  assert.equal(good.json().totalCents, 33000, 'price came from the book, not from the caller');
});

test('one-time work quotes as a RANGE whose width is a setting, not a literal', async () => {
  const lead = await makeContact(app.db, { firstName: 'Synthetic', lastName: 'Ranged', email: 'ranged@example.test' });
  const res = await app.inject({
    method: 'POST', url: '/quotes', headers: auth(ana),
    payload: { contactId: lead.id, lines: [{ itemCode: 'IND_BASE_MFJ' }], asRange: true },
  });
  assert.equal(res.statusCode, 201, res.body);
  const q = res.json();
  // $200 base, 15% band → $200–$230. Both ends derive; neither is hardcoded.
  assert.equal(q.rangeMinCents, 20000);
  assert.equal(q.rangeMaxCents, 23000);

  // Move the setting and the band moves with it — no deploy.
  await app.db.query(`UPDATE app_settings SET value = '25'::jsonb WHERE key = 'pricing.estimate_band_percent'`);
  const wider = await app.inject({
    method: 'POST', url: '/quotes', headers: auth(ana),
    payload: { contactId: lead.id, lines: [{ itemCode: 'IND_BASE_MFJ' }], asRange: true },
  });
  assert.equal(wider.json().rangeMaxCents, 25000, 'the band is admin-tunable');
  await app.db.query(`UPDATE app_settings SET value = '15'::jsonb WHERE key = 'pricing.estimate_band_percent'`);
});

test('sending pins the price-book version and stores only the token hash', async () => {
  const lead = await makeContact(app.db, { firstName: 'Synthetic', lastName: 'Pinned', email: 'pinned@example.test' });
  const created = await app.inject({
    method: 'POST', url: '/quotes', headers: auth(ana),
    payload: { contactId: lead.id, lines: [{ itemCode: 'IND_BASE_SINGLE' }], expiresInDays: 30 },
  });
  const quoteId = created.json().id as string;

  const before = sent.length;
  const sendRes = await app.inject({ method: 'POST', url: `/quotes/${quoteId}/send`, headers: auth(ana) });
  assert.equal(sendRes.statusCode, 200, sendRes.body);
  const { token, url } = sendRes.json();

  // Only the hash is at rest — the plaintext lives in the email and nowhere else.
  const stored = await app.db.query<{ public_token_hash: string; price_book_version_id: string | null }>(
    `SELECT public_token_hash, price_book_version_id FROM quotes WHERE id = $1`,
    [quoteId]
  );
  assert.equal(stored.rows[0]!.public_token_hash, createHash('sha256').update(token).digest('hex'));
  assert.notEqual(stored.rows[0]!.public_token_hash, token);
  assert.ok(stored.rows[0]!.price_book_version_id, 'the version in force is pinned at send time');
  assert.match(url, /\/quote\//);

  // The client got a link, in their language, and no attachment.
  assert.equal(sent.length, before + 1);
  assert.match(sent.at(-1)!.subject, /proposal/i);
  assert.ok(sent.at(-1)!.text.includes(token), 'the email carries the link');

  // Lead moved to 'quoted'.
  const stage = await app.db.query<{ lead_stage: string }>(`SELECT lead_stage::text FROM contacts WHERE id = $1`, [lead.id]);
  assert.equal(stage.rows[0]!.lead_stage, 'quoted');

  // Sending twice is refused — one live link per quote.
  const again = await app.inject({ method: 'POST', url: `/quotes/${quoteId}/send`, headers: auth(ana) });
  assert.equal(again.statusCode, 409);
  assert.equal(again.json().error, 'already_sent');
});

test('a failed send rolls the quote back to draft instead of stranding the link', async () => {
  const lead = await makeContact(app.db, { firstName: 'Synthetic', lastName: 'Undeliverable', email: 'undeliverable@example.test' });
  const created = await app.inject({
    method: 'POST', url: '/quotes', headers: auth(ana),
    payload: { contactId: lead.id, lines: [{ itemCode: 'IND_BASE_SINGLE' }] },
  });
  const quoteId = created.json().id as string;

  // Break the email the way reality breaks it: the template is unsendable.
  // (Same shape as the placeholder gate firing, or SES refusing the address.)
  await app.db.query(`UPDATE templates SET is_placeholder = true WHERE key = 'quote_ready'`);
  const failed = await app.inject({ method: 'POST', url: `/quotes/${quoteId}/send`, headers: auth(ana) });
  assert.equal(failed.statusCode, 409, failed.body);
  assert.equal(failed.json().error, 'template_placeholder_blocked');

  // Nothing half-sent: no token hash to strand, and status is back to draft.
  const row = await app.db.query<{ status: string; sent_at: Date | null; public_token_hash: string | null }>(
    `SELECT status::text, sent_at, public_token_hash FROM quotes WHERE id = $1`, [quoteId]
  );
  assert.equal(row.rows[0]!.status, 'draft', 'a quote the client never received is not "sent"');
  assert.equal(row.rows[0]!.sent_at, null);
  assert.equal(row.rows[0]!.public_token_hash, null, 'no orphan token hash left behind');

  // Fix the cause and the same quote sends for real — no rebuild needed.
  await app.db.query(`UPDATE templates SET is_placeholder = false WHERE key = 'quote_ready'`);
  const ok = await app.inject({ method: 'POST', url: `/quotes/${quoteId}/send`, headers: auth(ana) });
  assert.equal(ok.statusCode, 200, ok.body);
  assert.ok(ok.json().token);
});

test('the public link needs no account, and a wrong token is a 404', async () => {
  const lead = await makeContact(app.db, { firstName: 'Synthetic', lastName: 'Reader', email: 'reader@example.test', language: 'es' });
  const created = await app.inject({
    method: 'POST', url: '/quotes', headers: auth(ana),
    payload: { contactId: lead.id, language: 'es', lines: [{ itemCode: 'IND_BASE_HOH' }] },
  });
  const { token } = (await app.inject({
    method: 'POST', url: `/quotes/${created.json().id}/send`, headers: auth(ana),
  })).json();

  // No authorization header at all.
  const view = await app.inject({ method: 'GET', url: `/public/quote/${token}` });
  assert.equal(view.statusCode, 200, view.body);
  assert.equal(view.json().quote.language, 'es');
  // BOTH languages ride on the line, so the reader's toggle relabels without
  // re-pricing — a Spanish reader never gets English service names.
  assert.match(view.json().lines[0].description_es, /Cabeza de familia/, 'Spanish copy, from the price book');
  assert.match(view.json().lines[0].description_en, /Head of household/, 'and the English label is there too');

  const wrong = await app.inject({ method: 'GET', url: `/public/quote/${'x'.repeat(43)}` });
  assert.equal(wrong.statusCode, 404);
});

test('accepting converts to an engagement + deposit invoice with zero re-entry', async () => {
  const lead = await makeContact(app.db, { firstName: 'Synthetic', lastName: 'Accepter', email: 'accepter@example.test' });
  const created = await app.inject({
    method: 'POST', url: '/quotes', headers: auth(ana),
    payload: {
      contactId: lead.id,
      lines: [
        { itemCode: 'IND_BASE_MFJ' },                          // $200
        { itemCode: 'IND_SCH_E_RENTAL', quantity: 2 },          // $180 × 2
        { itemCode: 'IND_SCH_A', isOptional: true },            // $100, client's call
      ],
    },
  });
  const quoteId = created.json().id as string;
  assert.equal(created.json().totalCents, 56000, 'optional lines are excluded until chosen');

  const { token } = (await app.inject({ method: 'POST', url: `/quotes/${quoteId}/send`, headers: auth(ana) })).json();

  const accepted = await app.inject({
    method: 'POST', url: `/public/quote/${token}/accept`,
    payload: { chooseOptional: ['IND_SCH_A'] },
  });
  assert.equal(accepted.statusCode, 200, accepted.body);
  const { engagementId, depositInvoiceId, totalCents } = accepted.json();
  assert.equal(totalCents, 66000, 'the ticked add-on is priced from the book and included');
  assert.ok(engagementId, 'an engagement exists without anyone re-typing the scope');
  assert.ok(depositInvoiceId, 'the deposit invoice was issued from the price book deposit item');

  // The invoice amount is the BOOK deposit, not a number the quote invented.
  const inv = await app.db.query<{ total_cents: number; contact_id: string }>(
    `SELECT total_cents, contact_id FROM invoices WHERE id = $1`, [depositInvoiceId]
  );
  assert.equal(inv.rows[0]!.total_cents, 25000);
  assert.equal(inv.rows[0]!.contact_id, lead.id);

  // Rene gets the onboarding task; the pipeline moved to deposit_paid.
  const task = await app.db.query<{ title: string }>(
    `SELECT title FROM tasks WHERE source_type = 'quote_accepted' AND source_id = $1`, [quoteId]
  );
  assert.equal(task.rows.length, 1, 'accepted quotes create exactly one onboarding task');
  const stage = await app.db.query<{ lead_stage: string }>(`SELECT lead_stage::text FROM contacts WHERE id = $1`, [lead.id]);
  assert.equal(stage.rows[0]!.lead_stage, 'deposit_paid');

  // Accepting twice cannot double-create an engagement.
  const twice = await app.inject({ method: 'POST', url: `/public/quote/${token}/accept`, payload: {} });
  assert.equal(twice.statusCode, 409);
  assert.equal(twice.json().error, 'already_accepted');
});

test('a later price change does not re-price a quote already in the client’s hands', async () => {
  const lead = await makeContact(app.db, { firstName: 'Synthetic', lastName: 'Locked', email: 'locked@example.test' });
  const created = await app.inject({
    method: 'POST', url: '/quotes', headers: auth(ana),
    payload: { contactId: lead.id, lines: [{ itemCode: 'IND_BASE_SINGLE' }] },
  });
  const quoteId = created.json().id as string;
  const { token } = (await app.inject({ method: 'POST', url: `/quotes/${quoteId}/send`, headers: auth(ana) })).json();

  // Raise the live book price by $50 AFTER the quote went out.
  await app.db.query(
    `UPDATE price_book_items SET amount_cents = 20000
     WHERE item_code = 'IND_BASE_SINGLE'
       AND version_id = (SELECT id FROM price_book_versions
                         WHERE effective_from <= CURRENT_DATE AND (effective_to IS NULL OR effective_to > CURRENT_DATE)
                         ORDER BY version_number DESC LIMIT 1)`
  );

  const view = await app.inject({ method: 'GET', url: `/public/quote/${token}` });
  assert.equal(view.json().quote.total_cents, 15000, 'the client still sees the price we quoted');
  assert.equal(view.json().lines[0].unit_cents, 15000, 'line prices are copies taken at build time');

  await app.db.query(
    `UPDATE price_book_items SET amount_cents = 15000
     WHERE item_code = 'IND_BASE_SINGLE'
       AND version_id = (SELECT id FROM price_book_versions
                         WHERE effective_from <= CURRENT_DATE AND (effective_to IS NULL OR effective_to > CURRENT_DATE)
                         ORDER BY version_number DESC LIMIT 1)`
  );
});

test('a bundle quote is still only price-book references', async () => {
  const lead = await makeContact(app.db, { firstName: 'Synthetic', lastName: 'Bundled', email: 'bundled@example.test' });
  const res = await app.inject({
    method: 'POST', url: '/quotes', headers: auth(ana),
    payload: { contactId: lead.id, bundleSlug: 's-corp-conversion' },
  });
  assert.equal(res.statusCode, 201, res.body);
  const quoteId = res.json().id as string;

  const lines = await app.db.query<{ item_code: string; unit_cents: number | null; is_optional: boolean }>(
    `SELECT item_code, unit_cents, is_optional FROM quote_line_items WHERE quote_id = $1 ORDER BY sort_order`,
    [quoteId]
  );
  assert.ok(lines.rows.length >= 6, 'every bundle component became a line');
  // Each line's price matches the book — nothing was invented inside the bundle.
  for (const line of lines.rows) {
    const book = await app.db.query<{ amount_cents: number | null }>(
      `SELECT amount_cents FROM price_book_items
       WHERE item_code = $1 AND version_id = (SELECT id FROM price_book_versions
         WHERE effective_from <= CURRENT_DATE AND (effective_to IS NULL OR effective_to > CURRENT_DATE)
         ORDER BY version_number DESC LIMIT 1)`,
      [line.item_code]
    );
    assert.equal(line.unit_cents, book.rows[0]!.amount_cents, `${line.item_code} priced from the book`);
  }
  assert.ok(lines.rows.some((l) => l.is_optional), 'optional components stay optional in the quote');
});

test('declining returns the lead to the pipeline WITH a reason, and tasks it to Brian', async () => {
  const lead = await makeContact(app.db, { firstName: 'Synthetic', lastName: 'Decliner', email: 'decliner@example.test' });
  const created = await app.inject({
    method: 'POST', url: '/quotes', headers: auth(ana),
    payload: { contactId: lead.id, lines: [{ itemCode: 'BIZ_1120S' }] },
  });
  const quoteId = created.json().id as string;
  const { token } = (await app.inject({ method: 'POST', url: `/quotes/${quoteId}/send`, headers: auth(ana) })).json();

  const declined = await app.inject({
    method: 'POST', url: `/public/quote/${token}/decline`,
    payload: { reason: 'Going with my brother-in-law this year' },
  });
  assert.equal(declined.statusCode, 200, declined.body);

  const row = await app.db.query<{ status: string; decline_reason: string }>(
    `SELECT status::text, decline_reason FROM quotes WHERE id = $1`, [quoteId]
  );
  assert.equal(row.rows[0]!.status, 'declined');
  assert.match(row.rows[0]!.decline_reason, /brother-in-law/);

  const contact = await app.db.query<{ lead_stage: string; lost_reason: string }>(
    `SELECT lead_stage::text, lost_reason FROM contacts WHERE id = $1`, [lead.id]
  );
  assert.equal(contact.rows[0]!.lead_stage, 'lost');
  assert.match(contact.rows[0]!.lost_reason, /brother-in-law/, 'the reason survives on the contact');

  const task = await app.db.query(`SELECT 1 FROM tasks WHERE source_type = 'quote_declined' AND source_id = $1`, [quoteId]);
  assert.equal(task.rows.length, 1, 'a declined quote is a decision, so it is a task');
});

test('expiry is date-guarded, records a reason, and runs once per day', async () => {
  const today = todayChicago();
  const lead = await makeContact(app.db, { firstName: 'Synthetic', lastName: 'Expired', email: 'expired@example.test' });
  const created = await app.inject({
    method: 'POST', url: '/quotes', headers: auth(ana),
    payload: { contactId: lead.id, lines: [{ itemCode: 'IND_BASE_SINGLE' }] },
  });
  const quoteId = created.json().id as string;
  const { token } = (await app.inject({ method: 'POST', url: `/quotes/${quoteId}/send`, headers: auth(ana) })).json();
  // Backdate the expiry relative to the job's date, never to the wall clock.
  await app.db.query(`UPDATE quotes SET expires_at = ($2::date - 1) WHERE id = $1`, [quoteId, today]);

  const first = await runQuoteExpiryJob(app, today);
  assert.equal(first.skipped, false);
  assert.ok(first.expired >= 1);

  const row = await app.db.query<{ status: string }>(`SELECT status::text FROM quotes WHERE id = $1`, [quoteId]);
  assert.equal(row.rows[0]!.status, 'expired');
  const contact = await app.db.query<{ lead_stage: string; lost_reason: string }>(
    `SELECT lead_stage::text, lost_reason FROM contacts WHERE id = $1`, [lead.id]
  );
  assert.equal(contact.rows[0]!.lead_stage, 'lost');
  assert.equal(contact.rows[0]!.lost_reason, 'quote expired', 'silence is recorded as a reason too');

  // Second run the same day is a no-op.
  const second = await runQuoteExpiryJob(app, today);
  assert.equal(second.skipped, true);

  // An expired token cannot be accepted.
  const late = await app.inject({ method: 'POST', url: `/public/quote/${token}/accept`, payload: {} });
  assert.equal(late.statusCode, 409);
  assert.equal(late.json().error, 'not_open');
});

test('an expired-at-read quote closes itself instead of converting', async () => {
  const today = todayChicago();
  const lead = await makeContact(app.db, { firstName: 'Synthetic', lastName: 'Stale', email: 'stale@example.test' });
  const created = await app.inject({
    method: 'POST', url: '/quotes', headers: auth(ana),
    payload: { contactId: lead.id, lines: [{ itemCode: 'IND_BASE_SINGLE' }] },
  });
  const { token } = (await app.inject({
    method: 'POST', url: `/quotes/${created.json().id}/send`, headers: auth(ana),
  })).json();
  // Past the expiry, but the nightly job has not run yet today.
  await app.db.query(`UPDATE quotes SET expires_at = ($2::date - 1) WHERE id = $1`, [created.json().id, today]);

  const res = await app.inject({ method: 'POST', url: `/public/quote/${token}/accept`, payload: {} });
  assert.equal(res.statusCode, 409);
  assert.equal(res.json().error, 'expired', 'the request itself enforces the date — not just the job');
  const row = await app.db.query<{ status: string }>(`SELECT status::text FROM quotes WHERE id = $1`, [created.json().id]);
  assert.equal(row.rows[0]!.status, 'expired');
});

test('quoting extra work to an existing CLIENT never demotes them into the funnel', async () => {
  const client = await makeContact(app.db, { firstName: 'Synthetic', lastName: 'Longstanding', email: 'longstanding@example.test' });
  await setLeadStage(app, client.id, 'client', null, 'migrated');

  const created = await app.inject({
    method: 'POST', url: '/quotes', headers: auth(ana),
    // Was SPEC_TAX_PLANNING (specialized_cpa). GATE 1 in launch-readiness.md now
    // blocks non-tax lines from being SENT until finding #19 is fixed, and this test
    // is about not demoting an existing client — not about the service line. An
    // individual-tax add-on exercises the same path without colliding with the gate;
    // the gate has its own test in quote-consequence.spec.ts.
    payload: { contactId: client.id, lines: [{ itemCode: 'IND_AMENDMENT_1040X' }], expiresInDays: 14 },
  });
  const quoteId = created.json().id as string;
  await app.inject({ method: 'POST', url: `/quotes/${quoteId}/send`, headers: auth(ana) });

  let stage = await app.db.query<{ lead_stage: string }>(`SELECT lead_stage::text FROM contacts WHERE id = $1`, [client.id]);
  assert.equal(stage.rows[0]!.lead_stage, 'client', 'sending a quote did not reopen them as a lead');

  // And letting it lapse does not mark a paying client "lost".
  // Today's guard is already burned by the previous test, and the audit log is
  // append-only by design — so advance the job's clock instead of rewriting history.
  const tomorrow = addDays(todayChicago(), 1);
  await app.db.query(`UPDATE quotes SET expires_at = $2::date WHERE id = $1`, [quoteId, todayChicago()]);
  const sweep = await runQuoteExpiryJob(app, tomorrow);
  assert.equal(sweep.skipped, false);

  stage = await app.db.query<{ lead_stage: string }>(`SELECT lead_stage::text FROM contacts WHERE id = $1`, [client.id]);
  assert.equal(stage.rows[0]!.lead_stage, 'client', 'an expired add-on quote is not client churn');

  // The attempt IS visible in history — skipped, not hidden.
  const history = await app.db.query<{ stage: string; note: string }>(
    `SELECT stage::text, note FROM lead_stage_history WHERE contact_id = $1 AND stage <> 'client' ORDER BY entered_at`,
    [client.id]
  );
  assert.ok(history.rows.length >= 1, 'the skipped move is recorded, not silently dropped');
  assert.match(history.rows[0]!.note, /recorded only/);
});

test('conversion metrics measure win rate against DECIDED quotes only', async () => {
  const m = await pipelineMetrics(app);
  assert.ok(m.quotesSent >= 6);
  assert.ok(m.quotesAccepted >= 1);
  assert.ok(m.quotesDeclined >= 1);
  assert.ok(m.quotesExpired >= 1);

  const decided = m.quotesAccepted + m.quotesDeclined + m.quotesExpired;
  assert.equal(m.winRatePercent, Math.round((m.quotesAccepted / decided) * 1000) / 10);
  assert.ok(m.winRatePercent! < 100, 'open quotes are not counted as wins');

  // Lost reasons are grouped so the pattern is visible, not just the count.
  assert.ok(m.lostReasons.some((r) => /brother-in-law/.test(r.reason)));
  assert.ok(m.lostReasons.some((r) => r.reason === 'no response'), 'silence is its own bucket');

  const count = (stage: string) => m.byStage.find((s) => s.stage === stage)?.count ?? 0;
  assert.ok(count('quoted') >= 1);
  assert.ok(count('lost') >= 2);
  assert.ok(count('client') >= 1);
});

test('the pipeline board shows leads only — clients are not open opportunities', async () => {
  const res = await app.inject({ method: 'GET', url: '/pipeline', headers: auth(ana) });
  assert.equal(res.statusCode, 200, res.body);
  const { board, metrics } = res.json();
  assert.ok(Array.isArray(board));
  assert.ok(board.length >= 3);
  assert.equal(
    board.filter((r: { lead_stage: string }) => r.lead_stage === 'client').length,
    0,
    'the board is a funnel, not a client list'
  );
  assert.ok(metrics.winRatePercent !== undefined);
});
