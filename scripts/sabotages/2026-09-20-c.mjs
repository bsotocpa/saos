/*
 * THE 2026-09-20 BATCH C (R14, ADD A CLIENT): the new control this track added a walk to is the
 * duplicate check on the way into a new contact, so that is what gets broken. Run through
 * scripts/sabotage-run.mjs so the report table is read from tasks/sabotage/2026-09-20.log rather
 * than composed.
 *
 *   node scripts/sabotage-run.mjs scripts/sabotages/2026-09-20-c.mjs
 *
 * The sabotage is the defect class this route is most exposed to: three positional parameters, all
 * text, handed to the query in the wrong order. The SQL still runs, the types still check, tsc is
 * silent and nothing throws — a typed name is compared against an email, an email against ten
 * digits, a phone against a full name, so every row fails every predicate and the check answers
 * "no duplicate" for every question it is ever asked. That is the whole failure: the modal stays
 * clean, "Add client" creates, and the second record for one person is born silently. Only a spec
 * that types a person the book already holds and reads the warning can catch it; the API spec's
 * duplicate assertions go red beside it, which is the point of having both.
 */
export const date = '2026-09-20';
const must = (t, a) => { if (!t.includes(a)) throw new Error('anchor missing: ' + a.slice(0, 60)); };

export const items = [
  {
    item: 'R14 the duplicate check: the query parameters transposed, so nothing is ever a duplicate',
    file: 'apps/api/src/modules/crm/routes.ts',
    change: 'GET /contacts/duplicate-check binds [email, phone, name] to $1/$2/$3, so the name is compared against an email and the check answers nothing',
    test: { kind: 'harness', spec: 'tests/ops-add-client.spec.ts' },
    apply: (t) => {
      const a = 'LIMIT 5`,\n      [name, email, phone]\n    );';
      must(t, a);
      return t.replace(a, 'LIMIT 5`,\n      [email, phone, name]\n    );');
    },
    expectRed: /reads the duplicate before anything is created/,
  },
];
