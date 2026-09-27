/*
 * The 2026-09-26 batch, item I: R65, the MFA recovery code is consumed by the statement that
 * accepts it. One sabotage, on the API suite, in the auth service:
 *
 *   R65  a recovery code signs in ONCE. The consuming UPDATE (used_at = now() ... RETURNING id) is
 *        replaced by a SELECT of the same row, so the code still matches, the session is still
 *        minted, and the code stays live: the second sign-in with it succeeds, the live count never
 *        moves, and the spec's "signs in once and is consumed" test is red on the count of live codes.
 *
 * Run through scripts/sabotage-run.mjs so the report table is read from tasks/sabotage/2026-09-26.log:
 *
 *   node scripts/sabotage-run.mjs scripts/sabotages/2026-09-26-i.mjs
 */
export const date = '2026-09-26';
const must = (t, a) => { if (!t.includes(a)) throw new Error('anchor missing: ' + a.slice(0, 60)); };

export const items = [
  {
    item: 'R65 a recovery code is consumed on use: the used_at stamp removed so a code signs in twice',
    file: 'apps/api/src/modules/auth/service.ts',
    change: 'the consuming UPDATE (SET used_at = now() WHERE id = $1 AND used_at IS NULL RETURNING id) replaced by a SELECT of the same row: the code matches, the session is minted, and the code stays live for a second sign-in',
    test: { kind: 'api', spec: 'test/mfa-recovery.spec.ts' },
    apply: (t) => {
      const a = '`UPDATE staff_mfa_recovery_codes SET used_at = now() WHERE id = $1 AND used_at IS NULL RETURNING id`';
      must(t, a);
      return t.replace(a, '`SELECT id FROM staff_mfa_recovery_codes WHERE id = $1`');
    },
    expectRed: /signs in once and is consumed/,
  },
];
