/*
 * The 2026-09-19 walk batch: eight items, seven sabotages (Brian, report item 7). Each entry breaks
 * the guard its item shipped, runs the test that should catch it, and restores the file. The
 * items are the ones in tasks/todo.md under RULED 2026-09-19: add a business (0), defects 1 to 4,
 * the solo dry run's preparer queue, and the dry run's two findings (the signed-date gate and the
 * acceptance-email actor). Defect 4 removed controls and has no guard to break; its evidence is
 * the harness assertion that no period badge renders on a completed business return.
 */
export const date = '2026-09-19';
const WALK = 'test/sept19-walk.spec.ts';
const api = (spec) => ({ kind: 'api', spec });
const must = (t, a) => { if (!t.includes(a)) throw new Error('anchor missing: ' + a.slice(0, 60)); };

export const items = [
  { item: '0 add a business: setPrimary ignored at creation', file: 'apps/api/src/modules/crm/routes.ts', change: 'makePrimary no longer reads setPrimary; only the first business becomes primary', test: api(WALK),
    apply: (t) => { const a = 'const makePrimary = b.setPrimary === true || (b.setPrimary === undefined && existing.rows[0]!.n === 0);'; must(t, a); return t.replace(a, 'const makePrimary = existing.rows[0]!.n === 0;'); },
    expectRed: /^a business added from the client page/ },
  { item: 'defect 1 reasons: "rehearsal" back on the refused list', file: 'apps/api/src/reasons.ts', change: 'a refused pattern \\b(dress )?rehearsal\\b added above the claude pattern', test: api('test/reasons.spec.ts'),
    apply: (t) => { const a = "  { re: /\\bclaude( code)?\\b/i,"; must(t, a); return t.replace(a, "  { re: /\\b(dress )?rehearsal\\b/i, why: 'sabotage' },\n" + a); },
    expectRed: /^the shapes that were actually written/ },
  { item: 'defect 2 inline errors: the modal swallows the refusal and closes', file: 'apps/internal/components/ask.tsx', change: 'run() wrapped in a try that swallows; finish(r) called as if it succeeded', test: { kind: 'harness', spec: 'tests/ops-inline-error.spec.ts' },
    apply: (t) => { const a = '        await pending.opts.run(r);\n        finish(r);\n      } catch (err) {'; must(t, a); return t.replace(a, '        try { await pending.opts.run(r); } catch { /* SABOTAGE */ }\n        finish(r);\n      } catch (err) {'); },
    expectRed: /phone/ },
  { item: 'defect 3 hold line: the date dropped from the held line', file: 'apps/api/src/outbox.ts', change: 'holdLine returns the undated present-tense sentence', test: api(WALK),
    apply: (t) => { const a = 'return `held on ${chicagoDate(at)} — automation was off at the time`;'; must(t, a); return t.replace(a, "return 'held — the automation is off (Admin → Automations)';"); },
    expectRed: /^a held send is dated/ },
  { item: 'defect 4 period badge: no period badge or control on non-tax lines', file: 'apps/internal/app/clients/[id]/page.tsx', none: 'the change removed controls; there is no guard to break. Evidence is the assertion "no period badge on a completed business return" in ops-scorp-dry-run.spec.ts', test: { kind: 'harness', spec: 'tests/ops-scorp-dry-run.spec.ts' } },
  { item: 'solo dry run: the preparer queue ignores ?all=1', file: 'apps/api/src/modules/tax/routes.ts', change: 'the leadership all=1 branch removed from the queue target', test: api(WALK),
    apply: (t) => { const a = 'const target = isLeadership && q.all ? null : isLeadership && q.preparerId ? q.preparerId : staff.id;'; must(t, a); return t.replace(a, 'const target = isLeadership && q.preparerId ? q.preparerId : staff.id;'); },
    expectRed: /^the preparer queue/ },
  { item: 'dry run finding: the acceptance-email actor back to the outbox', file: 'apps/api/src/modules/tax/efile-ack.ts', change: 'the send audits actor system/outbox instead of the releaser', test: api(WALK),
    apply: (t) => { const a = "actorType: a.released_by ? 'staff' : 'system', actorId: a.released_by, actorLabel: a.released_by_name ?? 'outbox',"; must(t, a); return t.replace(a, "actorType: 'system', actorId: null, actorLabel: 'outbox',"); },
    expectRed: /^the actor on an acceptance email/ },
  { item: 'dry run finding: the 8879 signed-date gate removed', file: 'apps/api/src/modules/tax/signed-8879.ts', change: 'the signed_date_in_future check made unreachable', test: api(WALK),
    apply: (t) => { const a = "if (calendarDay(input.signedOn, 'signedOn') > calendarDay(todayChicago(), 'today')) throw new AppError(409, 'signed_date_in_future',"; must(t, a); return t.replace(a, "if (false) throw new AppError(409, 'signed_date_in_future',"); },
    expectRed: /^the 8879 signed date/ },
];
