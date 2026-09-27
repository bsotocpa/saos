/*
 * The 2026-09-27 batch 8, item M: R77, the configurator history and the event waitlist read in write
 * order (seq, migration 0130), never by clock. One sabotage each: the read ordered by created_at again,
 * and the deterministic clock-step reproduction in each spec is red.
 *
 *   node scripts/sabotage-run.mjs scripts/sabotages/2026-09-27-m-r77.mjs
 */
export const date = '2026-09-27';
const must = (t, a) => { if (!t.includes(a)) throw new Error('anchor missing: ' + a.slice(0, 60)); };

export const items = [
  {
    item: 'R77 the configurator history reads in write order: configHistory ordered by the clock again',
    file: 'apps/api/src/modules/engagements/configurator.ts',
    change: '`ORDER BY seq` replaced by `ORDER BY created_at` in configHistory: two changes made moments apart read in clock order, reversed by a backward step',
    test: { kind: 'api', spec: 'test/configurator.spec.ts' },
    apply: (t) => {
      const a = 'FROM engagement_config_history WHERE engagement_id = $1 ORDER BY seq`';
      must(t, a);
      return t.replace(a, 'FROM engagement_config_history WHERE engagement_id = $1 ORDER BY created_at`');
    },
    expectRed: /./,
  },
  {
    item: 'R77 the waitlist gives a freed seat to the first to join, by write order: the promotion ordered by the clock again',
    file: 'apps/api/src/modules/events/service.ts',
    change: '`ORDER BY seq LIMIT 1` replaced by `ORDER BY created_at LIMIT 1` in the promotion: after a backward clock step the later registrant takes the seat',
    test: { kind: 'api', spec: 'test/events.spec.ts' },
    apply: (t) => {
      const a = 'ORDER BY seq LIMIT 1';
      must(t, a);
      return t.replace(a, 'ORDER BY created_at LIMIT 1');
    },
    expectRed: /a cancelled seat is actually given to the next person on the waitlist/,
  },
];
