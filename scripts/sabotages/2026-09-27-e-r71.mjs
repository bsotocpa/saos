/*
 * The 2026-09-27 batch 7, item E: R71, staff mail links to the Ops sign-in page.
 *
 *   R71  opsSignInUrl builds OPS_URL + /login. It is changed to the Ops root, so every staff mail's
 *        link opens the home page instead of the sign-in page: M5 in ops-mfa-recovery.spec.ts reads the
 *        harness mailbox and finds no sign-in link in the three mails, red at both viewports.
 *
 * Hold the harness lock: node scripts/sabotage-run.mjs scripts/sabotages/2026-09-27-e-r71.mjs
 */
export const date = '2026-09-27';
const must = (t, a) => { if (!t.includes(a)) throw new Error('anchor missing: ' + a.slice(0, 60)); };

export const items = [
  {
    item: 'R71 staff mail links to the Ops sign-in page: opsSignInUrl built from the Ops root instead of /login',
    file: 'apps/api/src/modules/staff/mail.ts',
    change: "`new URL('/login', app.config.OPS_URL)` replaced by `new URL('/', app.config.OPS_URL)`: the reset-MFA mail, the temporary-password notice and the recovery-code alert all link to the Ops home page, not the sign-in page",
    test: { kind: 'harness', spec: 'tests/ops-mfa-recovery.spec.ts' },
    apply: (t) => {
      const a = "return new URL('/login', app.config.OPS_URL).toString();";
      must(t, a);
      return t.replace(a, "return new URL('/', app.config.OPS_URL).toString();");
    },
    expectRed: /M1–M5/,
  },
];
