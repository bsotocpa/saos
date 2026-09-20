/*
 * The 2026-09-20 batch 4, item H: the sync-root guard (R19 build item 1), sabotaged in both of its
 * doors. The guard refuses when the checkout sits under a Dropbox, OneDrive or Google Drive root.
 * The sabotage points the guard's notion of the checkout at the folder the repository lived in until
 * today, C:\Users\brian\Dropbox\AI AGENT\saos, which is under the Dropbox root on this machine; the
 * guard must go red there, once through the root chain (npm run check:sync-root) and once through
 * scripts/deploy.sh, whose first act is the same check (`--preflight-only` stops it right after).
 *
 *   node scripts/sabotage-run.mjs scripts/sabotages/2026-09-20-h.mjs
 */
export const date = '2026-09-20';
const must = (t, a) => { if (!t.includes(a)) throw new Error('anchor missing: ' + a.slice(0, 60)); };
const underDropbox = (t) => {
  const a = "const CHECKOUT = resolve(here, '..');";
  must(t, a);
  return t.replace(a, "const CHECKOUT = resolve(process.env.USERPROFILE ?? '', 'Dropbox', 'AI AGENT', 'saos');");
};

export const items = [
  {
    item: 'R19 sync-root guard, root chain: the checkout path pointed at the old folder under the Dropbox root',
    file: 'scripts/check-sync-root.mjs',
    change: 'CHECKOUT resolved to C:\\Users\\brian\\Dropbox\\AI AGENT\\saos instead of the repository root; the guard must refuse that path',
    test: { kind: 'guard', spec: 'check:sync-root' },
    apply: underDropbox,
    expectRed: /sits under the Dropbox root/,
  },
  {
    item: 'R19 sync-root guard, deploy.sh: the same path under the Dropbox root, refused before the receipt check',
    file: 'scripts/check-sync-root.mjs',
    change: 'CHECKOUT resolved to the old folder under the Dropbox root; scripts/deploy.sh --preflight-only must exit non-zero on the guard, not on anything after it',
    test: { kind: 'guard', spec: 'deploy:preflight' },
    apply: underDropbox,
    expectRed: /sits under the Dropbox root/,
  },
];
