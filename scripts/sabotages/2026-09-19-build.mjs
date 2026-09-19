/*
 * The 2026-09-19 BUILD batch (items 2, 4, 5 and the harness item 3): one sabotage per item, run
 * through scripts/sabotage-run.mjs so the report table is read from tasks/sabotage/2026-09-19.log.
 */
export const date = '2026-09-19';
const api = (spec) => ({ kind: 'api', spec });
const must = (t, a) => { if (!t.includes(a)) throw new Error('anchor missing: ' + a.slice(0, 60)); };

export const items = [
  { item: 'item 4 completion: the state jurisdiction never awaited', file: 'apps/api/src/modules/tax/pipeline.ts', change: 'the awaiting check for the expected state made unreachable, so federal alone completes', test: api('test/completion.spec.ts'),
    apply: (t) => { const a = 'if (expectedState && !(r.state_accepted_on && normaliseState(r.state_accepted_code) === expectedState)) awaiting.push(expectedState);'; must(t, a); return t.replace(a, 'if (false && expectedState && !(r.state_accepted_on && normaliseState(r.state_accepted_code) === expectedState)) awaiting.push(expectedState);'); },
    expectRed: /federal|state|manual/i },
  { item: 'item 5 money line: system actors classed as staff', file: 'apps/api/src/modules/billing/money-digest.ts', change: "the actor-class CASE reads WHEN a.actor_type IN ('staff','system') THEN 'staff'", test: api('test/money-digest.spec.ts'),
    apply: (t) => { const a = "WHEN a.actor_type = 'staff' AND a.actor_id IS NOT NULL THEN 'staff'"; must(t, a); return t.replace(a, "WHEN a.actor_type IN ('staff','system') THEN 'staff'"); },
    expectRed: /outside|staff/i },
  { item: 'item 2 return controls: the outside-range reason check disabled', file: 'apps/api/src/modules/tax/routes.ts', change: 'the final_fee_reason_required branch made unreachable, so a fee outside the quoted range passes without a reason', test: api('test/return-controls.spec.ts'),
    apply: (t) => { const a = 'if (outside && !b.reason) {'; must(t, a); return t.replace(a, 'if (false && outside && !b.reason) {'); },
    expectRed: /outside|reason|range/i },
  { item: 'item 3 harness taps: the Set final fee control removed from the Returns card', file: 'apps/internal/components/return-controls.tsx', change: 'the Set final fee button replaced by nothing; the dry run cannot tap it', test: { kind: 'harness', spec: 'tests/ops-scorp-dry-run.spec.ts' },
    apply: (t) => { const a = '<button type="button" className="btn small ghost" onClick={() => void setFinalFee()}>Set final fee</button>'; must(t, a); return t.replace(a, '{null}'); },
    expectRed: /signed 8879-CORP, final fee/ },
  { item: 'report item 9 ratchet: the old modal-then-api shape back in a page', file: 'apps/internal/app/alerts/page.tsx', change: 'a handler appended that awaits ask() without run and then calls api()', test: { kind: 'guard', spec: 'check:inline-errors' },
    apply: (t) => t + ['', 'async function sabotageShape(): Promise<void> {', "  const a = await ask({ title: 'x', choices: [] });", "  if (a) await api('/x');", '}', ''].join('\n'),
    expectRed: /ask\(\) without run/ },
];
