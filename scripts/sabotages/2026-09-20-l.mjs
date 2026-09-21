/*
 * The 2026-09-20 batch, item L: the emailed proposal link. One sabotage on the harness, in the
 * portal's API client — because that is where the person was thrown off the page they were emailed:
 *
 *   R37  a public portal page (the proposal, the pay link, the sign-in link…) never redirects to the
 *        sign-in request page. Put the unconditional redirect back and the portal spec that follows
 *        the emailed proposal href with a lapsed session and a stale signed-in marker is red at both
 *        viewports: the browser lands on /login before the proposal draws.
 *
 * Run through scripts/sabotage-run.mjs so the report table is read from tasks/sabotage/2026-09-20.log:
 *
 *   node scripts/sabotage-run.mjs scripts/sabotages/2026-09-20-l.mjs
 */
export const date = '2026-09-20';
const must = (t, a) => { if (!t.includes(a)) throw new Error('anchor missing: ' + a.slice(0, 60)); };

export const items = [
  {
    item: 'R37 the public-page guard: a 401 redirects to /login on every path again, the proposal page included',
    file: 'apps/portal/lib/api.ts',
    change: 'the isPublicPath() guard in front of the /login redirect removed; a stale signed-in marker on /quote/:token sends the reader to the sign-in request page before the proposal renders',
    test: { kind: 'harness', spec: 'tests/portal-public-links.spec.ts' },
    apply: (t) => {
      const a = "    if (!isPublicPath()) window.location.href = '/login';";
      must(t, a);
      return t.replace(a, "    window.location.href = '/login';");
    },
    expectRed: /a proposal link renders its quote/,
  },
];
