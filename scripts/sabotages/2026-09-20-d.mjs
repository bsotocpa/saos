/*
 * The 2026-09-20 "D" batch — rulings R8, R9 and R17: one sabotage per item, run through
 * scripts/sabotage-run.mjs so the report table is read from tasks/sabotage/2026-09-20.log.
 *
 *   node scripts/sabotage-run.mjs scripts/sabotages/2026-09-20-d.mjs [--only <substring>]
 */
export const date = '2026-09-20';
const guard = (spec) => ({ kind: 'guard', spec });
const must = (t, a) => { if (!t.includes(a)) throw new Error('anchor missing: ' + a.slice(0, 60)); };

/*
 * The Void control on the Ops client page, bracketed for removal.
 *
 * `Void…` is unique in the file; the opening conditional is not — the same
 * `sent || overdue` test also wraps the reminder and pay-link group a few lines above. So the
 * fragment is cut from the LAST occurrence of that conditional before the button's own closing
 * lines, which lands on the right one without depending on line numbers.
 */
const VOID_OPEN = "{(inv.status === 'sent' || inv.status === 'overdue') ? (";
const VOID_CLOSE = [
  '                          Void…',
  '                        </button>',
  '                      </>',
  '                    ) : null}',
].join('\n');

export const items = [
  {
    item: 'R8 guard: a raw INSERT INTO tasks in the path the old guard exempted',
    file: 'apps/api/src/migration/execute.ts',
    change: 'a raw `INSERT INTO tasks` appended to a migration module — the exact path check-role-guarded-tasks.mjs exempts by name, which is where the deleted Trello importer lived',
    test: guard('check:task-inserts'),
    apply: (t) => t + ['', 'const sabotageDoor = `INSERT INTO tasks (title, source) VALUES ($1, $2)`;', 'void sabotageDoor;', ''].join('\n'),
    expectRed: /raw INSERT INTO tasks/,
  },
  {
    item: 'R9 guard: a task type emitted from apps/api/scripts with no SOP decision',
    file: 'apps/api/scripts/import-legacy.ts',
    change: "a new `sourceType: 'legacy_import_review'` appended to a CLI script — the root the SOP-hook guard did not read until R9",
    test: guard('check:sops'),
    apply: (t) => t + ['', "const sabotageType = { sourceType: 'legacy_import_review' };", 'void sabotageType;', ''].join('\n'),
    expectRed: /legacy_import_review/,
  },
  {
    item: 'R17 harness taps: the Void control removed from the client page',
    file: 'apps/internal/app/clients/[id]/page.tsx',
    change: 'the whole sent-or-overdue Void fragment replaced by nothing; D1 cannot tap a control that is not there',
    test: { kind: 'harness', spec: 'tests/ops-billing-taps.spec.ts' },
    apply: (t) => {
      must(t, VOID_CLOSE);
      must(t, VOID_OPEN);
      const end = t.indexOf(VOID_CLOSE);
      const start = t.lastIndexOf(VOID_OPEN, end);
      if (start === -1) throw new Error('no opening conditional before the Void button');
      return t.slice(0, start) + '{null}' + t.slice(end + VOID_CLOSE.length);
    },
    expectRed: /voids a sent invoice/,
  },
];
