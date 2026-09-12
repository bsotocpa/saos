// THE TRANSACTIONAL OUTBOX (#48) + the statutory perfection-clock invariant.
//
// The outbox exists because two rules collide: an outward effect must not happen inside a
// transaction (it cannot be rolled back), and it must not be lost if the process dies after
// the commit. A ROW written inside the transaction satisfies both.
//
// Synthetic data only.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/server.ts';
import type { Mailer } from '../src/mailer.ts';
import { createTestConfig, makeContact, makeStaff , signed8879OnFile } from './helpers.ts';
import type { Config } from '../src/config.ts';
import { withTransaction } from '../src/db.ts';
import { drainOutbox, enqueueEffect, MAX_ATTEMPTS } from '../src/outbox.ts';
import { createQuote, sendQuote, acceptQuote } from '../src/modules/pricing/quotes.ts';
import { recordEfileResult } from '../src/modules/tax/pipeline.ts';

let app: FastifyInstance;
let config: Config;
let ceo = '';

/** Sends are counted rather than performed — the drain's job is to CALL the mailer. */
let sent: Array<{ to: string; subject: string }> = [];
const countingMailer: Mailer = {
  transport: 'console',
  async send(msg: { to: string; subject: string }) {
    sent.push({ to: msg.to, subject: msg.subject });
    return { id: `counted-${sent.length}` };
  },
};

function staffActor(id: string) {
  return {
    id, email: 'system@saos', fullName: 'SAOS', roleKey: 'ceo' as const,
    permissions: ['*'], sessionId: 'test',
  };
}

async function ceoId(): Promise<string> {
  if (ceo) return ceo;
  const staff = await makeStaff(app.db, config, {
    email: 'ceo-outbox@example.test', name: 'Synthetic CEO', role: 'ceo',
    password: 'ceo-password-1234567',
  });
  ceo = staff.id;
  return ceo;
}

async function depositItemCode(): Promise<string> {
  const { rows } = await app.db.query<{ item_code: string }>(
    `SELECT pbi.item_code FROM price_book_items pbi
       JOIN price_book_versions v ON v.id = pbi.version_id
      WHERE pbi.deposit_cents > 0 AND pbi.is_active AND pbi.display_on_quote
        AND pbi.amount_cents IS NOT NULL
        AND v.effective_from <= CURRENT_DATE AND (v.effective_to IS NULL OR v.effective_to > CURRENT_DATE)
      ORDER BY pbi.item_code LIMIT 1`
  );
  assert.ok(rows[0], 'the book in force has a quotable item carrying a deposit');
  return rows[0]!.item_code;
}

before(async () => {
  config = await createTestConfig('outbox');
  app = buildServer(config, { mailer: countingMailer });
  await app.ready();
});

after(async () => {
  await app.close();
});

// ── THE MECHANISM ──────────────────────────────────────────────────────────

test('#48: the intent to send commits WITH its state, and vanishes with it', async () => {
  /*
   * The whole reason this is a row rather than a call. An effect enqueued inside a transaction
   * that rolls back must not survive — otherwise the drain would email a client about
   * something that never happened, which is worse than not emailing them at all.
   */
  const c = await makeContact(app.db, {
    firstName: 'Synthetic', lastName: 'Intent', email: 'intent@example.test',
  });

  await assert.rejects(
    () =>
      withTransaction(app.db, async () => {
        await enqueueEffect(app, {
          effect: 'invoice.send',
          payload: { invoiceId: '00000000-0000-0000-0000-000000000001' },
          contactId: c.id,
          objectType: 'invoice',
          objectId: '00000000-0000-0000-0000-000000000001',
        });
        const queued = await app.db.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM outbox WHERE contact_id = $1`, [c.id]
        );
        assert.equal(queued.rows[0]!.n, 1, 'the row exists inside its own transaction');
        throw new Error('synthetic');
      }),
    /synthetic/
  );

  const after = await app.db.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM outbox WHERE contact_id = $1`, [c.id]
  );
  assert.equal(after.rows[0]!.n, 0, 'and is gone with the state that asked for it');
});

test('#48: enqueueing the same effect twice queues ONE send', async () => {
  /*
   * Two rows asking to email the same invoice is two emails. The ways that happens — a retried
   * request, a re-run job, a double-click three layers up — are all things this system has
   * already been bitten by (#41), so the uniqueness is an index rather than a convention.
   */
  const c = await makeContact(app.db, {
    firstName: 'Synthetic', lastName: 'Once', email: 'once-outbox@example.test',
  });
  const id = '00000000-0000-0000-0000-0000000000aa';
  const first = await enqueueEffect(app, {
    effect: 'invoice.send', payload: { invoiceId: id }, contactId: c.id,
    objectType: 'invoice', objectId: id,
  });
  const second = await enqueueEffect(app, {
    effect: 'invoice.send', payload: { invoiceId: id }, contactId: c.id,
    objectType: 'invoice', objectId: id,
  });
  assert.ok(first, 'the first enqueue took');
  assert.equal(second, null, 'the second is a no-op, not a second email');

  const rows = await app.db.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM outbox WHERE object_id = $1`, [id]
  );
  assert.equal(rows.rows[0]!.n, 1);
});

test('#48: an unknown effect is refused at enqueue, where the caller is still on the stack', async () => {
  /*
   * A row naming an effect nothing can perform would retry five times and dead-letter, telling
   * a person about a typo. Refusing at enqueue puts the error where it can be fixed.
   */
  await assert.rejects(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    () => enqueueEffect(app, { effect: 'invoice.telepathy' as any, payload: {} }),
    /not an outbox effect/
  );
});

// ── ACCEPTANCE, END TO END ─────────────────────────────────────────────────

test('#48: accepting a quote queues the deposit email, and the drain sends it', async () => {
  sent = [];
  const c = await makeContact(app.db, {
    firstName: 'Synthetic', lastName: 'Queued', email: 'queued@example.test',
  });
  const quote = await createQuote(
    app, { contactId: c.id, lines: [{ itemCode: await depositItemCode() }] }, staffActor(await ceoId())
  );
  const s = await sendQuote(app, quote.id, staffActor(await ceoId()));
  sent = []; // the quote email itself is not what this test is about
  const accepted = await acceptQuote(app, s.url.split('/').pop()!, {});
  assert.ok(accepted.depositInvoiceId, 'the fixture carries a deposit');

  // NOTHING went out during acceptance — the whole point of the split.
  assert.equal(sent.length, 0, 'acceptance sent no email of its own');
  const queued = await app.db.query<{ status: string; effect: string }>(
    `SELECT status::text AS status, effect FROM outbox WHERE object_id = $1`,
    [accepted.depositInvoiceId]
  );
  assert.equal(queued.rows[0]!.effect, 'invoice.send');
  assert.equal(queued.rows[0]!.status, 'pending', 'the intent is queued');

  const inv = await app.db.query<{ status: string }>(
    `SELECT status::text AS status FROM invoices WHERE id = $1`, [accepted.depositInvoiceId]
  );
  // Decision 5 (2026-09-09): ISSUED with the acceptance (sent, payable); the EMAIL has not left —
  // the record of that is the invoice.sent audit row, not the status. Inverted premise.
  assert.equal(inv.rows[0]!.status, 'sent', 'issued with the acceptance');
  assert.equal((await app.db.query(`SELECT 1 FROM audit_log WHERE action = 'invoice.sent' AND object_id = $1`, [accepted.depositInvoiceId])).rows.length, 0, 'and the email has not left yet');

  const drained = await drainOutbox(app);
  assert.equal(drained.sent, 1, 'the drain performed it');
  assert.equal(sent.length, 1, 'and an email actually went');
  assert.equal(sent[0]!.to, 'queued@example.test');

  const after = await app.db.query<{ ostatus: string; istatus: string; sent_at: Date | null }>(
    `SELECT o.status::text AS ostatus, i.status::text AS istatus, i.sent_at
       FROM outbox o JOIN invoices i ON i.id = o.object_id WHERE o.object_id = $1`,
    [accepted.depositInvoiceId]
  );
  assert.equal(after.rows[0]!.ostatus, 'sent');
  assert.equal(after.rows[0]!.istatus, 'sent', 'the invoice now says sent, because it was');
  assert.ok(after.rows[0]!.sent_at);

  // A second drain must not send it again.
  const again = await drainOutbox(app);
  assert.equal(again.sent, 0);
  assert.equal(sent.length, 1, 'still exactly one email');
});

test('#48: a client with no address is retried, then abandoned with a P1 task naming them', async () => {
  /*
   * Brian's rule: "silent post-commit failure is how a client gets an engagement and never
   * learns it exists." Retrying will not conjure an address, so this must end at a person.
   */
  sent = [];
  const c = await makeContact(app.db, {
    firstName: 'Synthetic', lastName: 'Noaddress', email: 'noaddress-outbox@example.test',
  });
  const quote = await createQuote(
    app, { contactId: c.id, lines: [{ itemCode: await depositItemCode() }] }, staffActor(await ceoId())
  );
  const s = await sendQuote(app, quote.id, staffActor(await ceoId()));
  await app.db.query(`UPDATE contacts SET email = NULL WHERE id = $1`, [c.id]);
  const accepted = await acceptQuote(app, s.url.split('/').pop()!, {});

  // Drain repeatedly; the backoff is bypassed by moving the clock, not by waiting.
  for (let i = 0; i < MAX_ATTEMPTS + 1; i++) {
    await app.db.query(
      `UPDATE outbox SET next_attempt_at = now() - interval '1 minute' WHERE object_id = $1`,
      [accepted.depositInvoiceId]
    );
    await drainOutbox(app);
  }

  const row = await app.db.query<{ status: string; attempts: number; last_error: string | null }>(
    `SELECT status::text AS status, attempts, last_error FROM outbox WHERE object_id = $1`,
    [accepted.depositInvoiceId]
  );
  assert.equal(row.rows[0]!.status, 'abandoned', 'it gave up rather than retrying forever');
  assert.equal(row.rows[0]!.attempts, MAX_ATTEMPTS, `after exactly ${MAX_ATTEMPTS} attempts`);
  assert.match(row.rows[0]!.last_error ?? '', /no email address/);

  const task = await app.db.query<{ n: number; title: string; priority: number }>(
    `SELECT count(*)::int AS n, max(title) AS title, min(priority) AS priority
       FROM tasks WHERE contact_id = $1 AND source_type = 'outbox_abandoned'`,
    [c.id]
  );
  assert.equal(task.rows[0]!.n, 1, 'a person is told');
  assert.equal(task.rows[0]!.priority, 1);
  assert.match(task.rows[0]!.title, /Synthetic Noaddress/, 'and the task names the client');
  assert.match(task.rows[0]!.title, /payment link/, 'and what they never received');
});

test('#48: an invoice already sent by hand retires its row quietly, with no alarm', async () => {
  sent = [];
  const c = await makeContact(app.db, {
    firstName: 'Synthetic', lastName: 'Byhand', email: 'byhand@example.test',
  });
  const quote = await createQuote(
    app, { contactId: c.id, lines: [{ itemCode: await depositItemCode() }] }, staffActor(await ceoId())
  );
  const s = await sendQuote(app, quote.id, staffActor(await ceoId()));
  const accepted = await acceptQuote(app, s.url.split('/').pop()!, {});

  // Someone sends it from the client record before the tick fires. Decision 5: "sent by hand"
  // is the RECORD that the mail left (the route writes invoice.sent), not the status word.
  await app.db.query(
    `INSERT INTO audit_log (actor_type, actor_label, action, object_type, object_id, contact_id, details)
     VALUES ('staff', 'Synthetic by hand', 'invoice.sent', 'invoice', $1, $2, '{"by_hand": true}'::jsonb)`,
    [accepted.depositInvoiceId, c.id]
  );
  const drained = await drainOutbox(app);
  assert.equal(drained.skipped, 1, 'retired without sending');
  assert.equal(drained.abandoned, 0, 'and without alarming anyone');

  const tasks = await app.db.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM tasks WHERE contact_id = $1 AND source_type = 'outbox_abandoned'`,
    [c.id]
  );
  assert.equal(tasks.rows[0]!.n, 0, 'a resolution is not a failure');
});

// ── THE PACKET PATH ────────────────────────────────────────────────────────

test('#48: the packet is marked sent and the link queued together — never sent-but-unrecorded', async () => {
  /*
   * This path used to email the client and THEN call markPacketSent. If the mark failed, the
   * client held a signing link for a packet the system believed was never sent: every screen
   * read "unsent", nothing followed up, and a second send would have mailed the same link
   * again.
   */
  sent = [];
  const c = await makeContact(app.db, {
    firstName: 'Synthetic', lastName: 'Signlink', email: 'signlink@example.test',
  });
  const version = await app.db.query<{ id: string }>(
    `SELECT id FROM price_book_versions ORDER BY version_number DESC LIMIT 1`
  );
  await app.db.query(
    `INSERT INTO engagements (contact_id, service_line, status, price_book_version_id)
     VALUES ($1, 'tax', 'active', $2)`,
    [c.id, version.rows[0]!.id]
  );
  await app.db.query(
    `INSERT INTO portal_users (contact_id, email, is_active) VALUES ($1, $2, true)`,
    [c.id, 'signlink@example.test']
  );

  const { createPacket, sendPacketForPortalSignature } = await import('../src/modules/engagements/packet.ts');
  const packet = await createPacket(app, c.id, staffActor(await ceoId()));
  sent = [];
  await sendPacketForPortalSignature(app, packet.packetId, staffActor(await ceoId()), 'en');

  assert.equal(sent.length, 0, 'the send did not happen inline');
  const state = await app.db.query<{ pstatus: string; sent_at: Date | null; ostatus: string }>(
    `SELECT p.status::text AS pstatus, p.sent_at, o.status::text AS ostatus
       FROM engagement_packets p JOIN outbox o ON o.object_id = p.id
      WHERE p.id = $1`,
    [packet.packetId]
  );
  assert.equal(state.rows[0]!.pstatus, 'sent', 'the record is committed first');
  assert.ok(state.rows[0]!.sent_at);
  assert.equal(state.rows[0]!.ostatus, 'pending', 'with the delivery queued, not lost');

  const drained = await drainOutbox(app);
  assert.equal(drained.sent, 1);
  assert.equal(sent.length, 1, 'the client got the link');
  assert.equal(sent[0]!.to, 'signlink@example.test');
});

test('#48: a packet signed before the tick fires is not asked to be signed again', async () => {
  /*
   * The handler RE-READS at send time, which is why the payload carries ids rather than a
   * rendered message. A client who signed in the window would otherwise be emailed a link to
   * sign what they have already signed.
   */
  sent = [];
  const c = await makeContact(app.db, {
    firstName: 'Synthetic', lastName: 'Fastsigner', email: 'fastsigner@example.test',
  });
  const version = await app.db.query<{ id: string }>(
    `SELECT id FROM price_book_versions ORDER BY version_number DESC LIMIT 1`
  );
  await app.db.query(
    `INSERT INTO engagements (contact_id, service_line, status, price_book_version_id)
     VALUES ($1, 'tax', 'active', $2)`,
    [c.id, version.rows[0]!.id]
  );
  await app.db.query(
    `INSERT INTO portal_users (contact_id, email, is_active) VALUES ($1, $2, true)`,
    [c.id, 'fastsigner@example.test']
  );
  const { createPacket, sendPacketForPortalSignature, recordMasterSignature } =
    await import('../src/modules/engagements/packet.ts');
  const packet = await createPacket(app, c.id, staffActor(await ceoId()));
  await sendPacketForPortalSignature(app, packet.packetId, staffActor(await ceoId()), 'en');
  await recordMasterSignature(app, packet.packetId, { method: 'portal_esign' });

  sent = [];
  const drained = await drainOutbox(app);
  assert.equal(drained.skipped, 1, 'retired quietly — they already signed');
  assert.equal(sent.length, 0, 'and were not asked again');
});

// ── THE STATUTORY INVARIANT ────────────────────────────────────────────────

async function filedReturn(lastName: string): Promise<{ contactId: string; returnId: string }> {
  const c = await makeContact(app.db, {
    firstName: 'Synthetic', lastName, email: `${lastName.toLowerCase()}-outbox@example.test`,
  });
  const version = await app.db.query<{ id: string }>(
    `SELECT id FROM price_book_versions ORDER BY version_number DESC LIMIT 1`
  );
  const eng = await app.db.query<{ id: string }>(
    `INSERT INTO engagements (contact_id, service_line, status, price_book_version_id)
     VALUES ($1, 'tax', 'active', $2) RETURNING id`,
    [c.id, version.rows[0]!.id]
  );
  const te = await app.db.query<{ id: string }>(
    `INSERT INTO tax_engagements
       (engagement_id, tax_year, return_type, stage, engagement_letter_signed_at,
        estimate_locked_at)
     VALUES ($1, 2025, '1040', 'filed', now(), now()) RETURNING id`,
    [eng.rows[0]!.id]
  );
  await signed8879OnFile(app, te.rows[0]!.id, (await app.db.query<{ id: string }>(`SELECT id FROM staff WHERE is_active ORDER BY created_at LIMIT 1`)).rows[0]!.id);
  return { contactId: c.id, returnId: te.rows[0]!.id };
}

test('a rejected return is OWNED and ALERTED even though nobody holds tax_preparer', async () => {
  /*
   * THE DEFECT BRIAN ASKED ME TO CONFIRM WAS FIXED, AND WAS NOT.
   *
   * This resolved the owner with `firstActiveByRole('tax_preparer')` — no fallback — and
   * nobody holds that role. So the task was created UNASSIGNED and the alert, gated on
   * `if (owner)`, never fired. A statutory perfection clock started and nobody was told.
   * Finding #17 again, in the tax pipeline, where what expires is the original filing date.
   *
   * The transaction wrap could not fix this: it guaranteed the clock and the task landed
   * together, and "together" included "together with no owner".
   */
  const unstaffed = await app.db.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM staff st JOIN roles r ON r.id = st.role_id
      WHERE r.key = 'tax_preparer' AND st.is_active`
  );
  assert.equal(unstaffed.rows[0]!.n, 0, 'nobody holds tax_preparer — the condition that made this silent');

  const r = await filedReturn('Unowned');
  await recordEfileResult(app, { staffId: null, label: 'test' }, r.returnId, {
    result: 'rejected', rejectCode: 'IND-031-04', rejectReason: 'Synthetic AGI mismatch',
  });

  const task = await app.db.query<{ assigned: string | null; priority: number; due: string | null }>(
    `SELECT assigned_staff_id AS assigned, priority, due_date::text AS due
       FROM tasks WHERE source_type = 'efile_reject' AND source_id = $1`,
    [r.returnId]
  );
  assert.ok(task.rows[0], 'the task exists');
  assert.equal(task.rows[0]!.assigned, await ceoId(), 'and it OWNS — falling back to Brian');
  assert.equal(task.rows[0]!.priority, 1, 'at P1, because a statutory clock is running');
  assert.ok(task.rows[0]!.due, 'clocked to the perfection deadline');

  const alert = await app.db.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM notifications
      WHERE type = 'efile_rejected' AND related_object_id = $1`,
    [r.returnId]
  );
  assert.equal(alert.rows[0]!.n, 1, 'and a real person was alerted, not nobody');
});

test('a perfection clock CANNOT be stored without an open owning task', async () => {
  /*
   * Brian: "that's a statutory deadline, same tier as the deadline table." So the pairing is
   * enforced by the database at COMMIT, not by the service being careful. A deferred
   * constraint trigger, because the rule spans two tables and the task is written after the
   * deadline is stamped.
   */
  const r = await filedReturn('Unwatched');
  await assert.rejects(
    () =>
      app.db.query(
        `UPDATE tax_engagements SET perfection_deadline = CURRENT_DATE + 5 WHERE id = $1`,
        [r.returnId]
      ),
    /no open owning task/,
    'a clock with nobody watching it is unstorable'
  );

  // Clearing it is always allowed — that is the resolution, not a violation.
  await app.db.query(`UPDATE tax_engagements SET perfection_deadline = NULL WHERE id = $1`, [r.returnId]);
});

test('closing the owning task is only legal once the clock is cleared', async () => {
  /*
   * The other direction. Re-filing inside the window clears the deadline AND closes the task
   * (`transitionStage` does both); the invariant is what stops someone closing the task and
   * leaving the clock running.
   */
  const r = await filedReturn('Reopened');
  await recordEfileResult(app, { staffId: null, label: 'test' }, r.returnId, {
    result: 'rejected', rejectCode: 'IND-031-04',
  });
  const live = await app.db.query<{ deadline: string | null }>(
    `SELECT perfection_deadline::text AS deadline FROM tax_engagements WHERE id = $1`, [r.returnId]
  );
  assert.ok(live.rows[0]!.deadline, 'the clock is running');

  // Clearing the clock first, then closing the task, is the legal order and stays legal.
  await app.db.query(`UPDATE tax_engagements SET perfection_deadline = NULL WHERE id = $1`, [r.returnId]);
  await app.db.query(
    `UPDATE tasks SET status = 'completed' WHERE source_type = 'efile_reject' AND source_id = $1`,
    [r.returnId]
  );
  const after = await app.db.query<{ deadline: string | null }>(
    `SELECT perfection_deadline::text AS deadline FROM tax_engagements WHERE id = $1`, [r.returnId]
  );
  assert.equal(after.rows[0]!.deadline, null);
});

// ── THE FAST LANE (2026-09-09) ─────────────────────────────────────────────

test('the outbox fast lane runs at least once a minute — the number that makes the portal copy true', async () => {
  /*
   * Brian accepted a rehearsal quote eleven seconds after the 15-minute tick (a deploy had just
   * moved its phase) and read "your deposit invoice is on its way by email." It was fifteen
   * minutes away. The portal now says "within a few minutes"; this is the constant that backs
   * the sentence. A frozen number, on purpose — loosen it and the copy is a lie again.
   */
  const { OUTBOX_SWEEP_MS } = await import('../src/jobs/daily.ts');
  assert.ok(OUTBOX_SWEEP_MS <= 60_000, `outbox sweep every ${OUTBOX_SWEEP_MS}ms is slower than the minute the copy promises`);
  assert.ok(OUTBOX_SWEEP_MS >= 10_000, 'and not so hot it hammers the database when idle');
});

test('one pass of the fast lane performs a queued deposit email, without the rest of the tick', async () => {
  sent = [];
  const c = await makeContact(app.db, {
    firstName: 'Synthetic', lastName: 'Fastlane', email: 'fastlane@example.test',
  });
  const quote = await createQuote(
    app, { contactId: c.id, lines: [{ itemCode: await depositItemCode() }] }, staffActor(await ceoId())
  );
  const s = await sendQuote(app, quote.id, staffActor(await ceoId()));
  sent = [];
  const accepted = await acceptQuote(app, s.url.split('/').pop()!, {});
  assert.ok(accepted.depositInvoiceId, 'the fixture carries a deposit');
  assert.equal(sent.length, 0, 'acceptance itself sent nothing');

  const { runOutboxSweep } = await import('../src/jobs/daily.ts');
  const swept = await runOutboxSweep(app);
  assert.equal(swept.sent, 1, 'the sweep performed the queued effect');
  assert.equal(sent.length, 1, 'and the client got exactly one email');
  assert.equal(sent[0]!.to, 'fastlane@example.test');

  const row = await app.db.query<{ status: string }>(
    `SELECT status::text AS status FROM outbox WHERE object_id = $1`, [accepted.depositInvoiceId]
  );
  assert.equal(row.rows[0]!.status, 'sent');
});
