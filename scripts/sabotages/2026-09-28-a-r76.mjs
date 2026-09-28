/*
 * The 2026-09-28 batch 9, item R76: the enrolment QR code, one sabotage on the harness.
 *
 *   R76  the login page draws the otpauth URI the setup returned as a QR code above the text secret.
 *        The wrong URI rendered (the same shape, another secret): the code no longer carries the secret
 *        beneath it, and M6 in ops-mfa-recovery.spec.ts is red.
 *
 * Hold the harness lock: node scripts/sabotage-run.mjs scripts/sabotages/2026-09-28-a-r76.mjs
 */
export const date = '2026-09-28';
const must = (t, a) => { if (!t.includes(a)) throw new Error('anchor missing: ' + a.slice(0, 60)); };

export const items = [
  {
    item: 'R76 the enrolment QR code carries the secret shown beneath it: the wrong URI rendered',
    file: 'apps/internal/app/login/page.tsx',
    change: "`setOtpauthUri(setup.otpauthUri);` replaced by the same URI with another secret: an authenticator that scans it makes codes the server refuses",
    test: { kind: 'harness', spec: 'tests/ops-mfa-recovery.spec.ts' },
    apply: (t) => {
      const a = 'setOtpauthUri(setup.otpauthUri);';
      must(t, a);
      return t.replace(a, "setOtpauthUri(setup.otpauthUri.replace(/secret=[^&]+/, 'secret=JBSWY3DPEHPK3PXP'));");
    },
    expectRed: /M1–M6/,
  },
];
