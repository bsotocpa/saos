/*
 * The 2026-09-29 batch 11: R97, same-name pairs. Only a record that holds nothing (no engagement,
 * quote, document, invoice, task, portal user or business) is archived as an empty duplicate. The
 * task count dropped from what a record holds: records holding work are archived as empty;
 * same-name.spec.ts is red.
 *
 *   node scripts/sabotage-run.mjs scripts/sabotages/2026-09-29-h-r97.mjs
 */
export const date = '2026-09-29';
const must = (t, a) => { if (!t.includes(a)) throw new Error('anchor missing: ' + a.slice(0, 60)); };

export const items = [
  {
    item: 'R97 a record holding work is never archived as an empty duplicate',
    file: 'apps/api/src/modules/crm/same-name.ts',
    change: 'the task count removed from holdings(): a record whose only work is a task reads as empty and is archived',
    test: { kind: 'api', spec: 'test/same-name.spec.ts' },
    apply: (t) => {
      const a = '+ (SELECT count(*) FROM tasks WHERE contact_id = c.id)';
      must(t, a);
      return t.replace(a, '+ 0');
    },
    expectRed: /the pass: an empty record is archived/,
  },
];
