/*
 * The 2026-09-26 batch, item E: rulings R51, R52, R54, R55 and R56, one guard broken on purpose
 * per ruling (two for R52, which has two independent guards), restored byte for byte.
 *
 *   R51  "Business — owner" in every Ops search. clientSearchLabel (apps/internal/lib/labels.ts) is
 *        the one place the three searches compose the row; make it return the person's name alone and
 *        H1, H2 and H3 are red at both viewports on ops-business-search.spec.ts.
 *   R52a test clients never appear in "Needs you today": the rollup's excludeTestClients removed;
 *        test-clients.spec.ts is red on the NEEDS YOU TODAY test.
 *   R52b a container the host no longer lists closes its own task: the close made unreachable in
 *        container-health.ts; container-health.spec.ts is red.
 *   R54  a duplicate EIN on Add needs a reason: the POST refusal made unreachable; business-edit.spec.ts
 *        is red on the Add test (the save goes through with no reason and no acceptance audit).
 *   R55  publishing a version refuses a deposit over its price: the route's refusal made unreachable;
 *        the constraint's 409 check_violation arrives instead of deposit_over_price and
 *        price-book-publish.spec.ts is red.
 *   R56  a root-chain check fails on bundle-shaped files under the checkout: the explicit skip of the
 *        committed synthetic ATX fixture folder removed, so the fixture named like an export trips the
 *        E-Files pattern; check:bundle-files is RED naming the file.
 *
 * Run through scripts/sabotage-run.mjs so the report table is read from tasks/sabotage/2026-09-26.log:
 *
 *   node scripts/sabotage-run.mjs scripts/sabotages/2026-09-26-e.mjs --only R5
 */
export const date = '2026-09-26';
const must = (t, a) => { if (!t.includes(a)) throw new Error('anchor missing: ' + a.slice(0, 60)); };

export const items = [
  {
    item: 'R51 "Business — owner" in every Ops search: clientSearchLabel returns the person alone',
    file: 'apps/internal/lib/labels.ts',
    change: "`return r.business_matched && r.business_name ? `${r.business_name} — ${person}` : person;` replaced by `return person;`; Deliver Return, New quote and the clients list print the owner's name with no business on a business-name hit",
    test: { kind: 'harness', spec: 'tests/ops-business-search.spec.ts' },
    apply: (t) => {
      const a = '  return r.business_matched && r.business_name ? `${r.business_name} — ${person}` : person;';
      must(t, a);
      return t.replace(a, '  return person; // SABOTAGE: the business dropped from the row');
    },
    expectRed: /Business — owner/,
  },
  {
    item: 'R52a test clients never appear in "Needs you today": the rollup filter removed',
    file: 'apps/api/src/modules/tasks/service.ts',
    change: '`excludeTestClients: true,` removed from ownerRollup\'s searchTasks call; a flagged rehearsal client\'s task is back on the tile',
    test: { kind: 'api', spec: 'test/test-clients.spec.ts' },
    apply: (t) => {
      const a = "    excludeSourceTypes: [...BACKLOG_SOURCE_TYPES],\n    excludeTestClients: true,\n";
      must(t, a);
      return t.replace(a, "    excludeSourceTypes: [...BACKLOG_SOURCE_TYPES],\n");
    },
    expectRed: /NEEDS YOU TODAY/,
  },
  {
    item: 'R52b a container the host no longer lists closes its own task: the close made unreachable',
    file: 'apps/api/src/modules/admin/container-health.ts',
    change: '`if (containers.length > 0) {` replaced by `if (false) {`; a removed container\'s task stays open forever, the 2026-09-20 shape',
    test: { kind: 'api', spec: 'test/container-health.spec.ts' },
    apply: (t) => {
      const a = '  if (containers.length > 0) {\n    const listed = new Set(containers.map((c) => c.name));';
      must(t, a);
      return t.replace(a, '  if (false as boolean) { // SABOTAGE: never closes\n    const listed = new Set(containers.map((c) => c.name));');
    },
    expectRed: /no longer lists closes its own task/,
  },
  {
    item: 'R54 a duplicate EIN on Add a business needs a reason: the POST refusal made unreachable',
    file: 'apps/api/src/modules/crm/routes.ts',
    change: 'the `if (holder && !b.duplicateReason)` before the create-anyway message replaced by `if (false)`; a second business takes another\'s EIN with no reason and no acceptance audit',
    test: { kind: 'api', spec: 'test/business-edit.spec.ts' },
    apply: (t) => {
      const a = "    if (holder && !b.duplicateReason) {\n      throw new AppError(409, 'ein_in_use', `That EIN is already on ${holder.name}. If this is a different business, say why and create anyway.`);";
      must(t, a);
      return t.replace(a, "    if (false as boolean) { // SABOTAGE: the reason no longer required\n      throw new AppError(409, 'ein_in_use', `That EIN is already on ${holder.name}. If this is a different business, say why and create anyway.`);");
    },
    expectRed: /needs a reason and is audited/,
  },
  {
    item: 'R55 publishing a version refuses a deposit over its price: the refusal made unreachable',
    file: 'apps/api/src/modules/admin/routes.ts',
    change: '`if (overPrice.length > 0) {` replaced by `if (false) {`; the copy INSERT hits the NOT VALID constraint and the publisher reads a constraint name (check_violation) instead of the lines',
    test: { kind: 'api', spec: 'test/price-book-publish.spec.ts' },
    apply: (t) => {
      const a = '      if (overPrice.length > 0) {\n        throw new AppError(409, \'deposit_over_price\',';
      must(t, a);
      return t.replace(a, '      if (false as boolean) { // SABOTAGE: the deposit rule dropped\n        throw new AppError(409, \'deposit_over_price\',');
    },
    expectRed: /refused by name|refused the same way|both named/,
  },
  {
    item: 'R56 a root-chain check fails on bundle-shaped files under the checkout: the fixture skip removed',
    file: 'scripts/check-bundle-files.mjs',
    change: "the explicit skip of apps/api/test/fixtures/atx removed from SKIP_DIRS; the committed synthetic ATX export, named like the real one, trips the E-Files pattern",
    test: { kind: 'guard', spec: 'check:bundle-files' },
    apply: (t) => {
      const a = "  'apps/api/test/fixtures/atx', // the committed synthetic ATX export; see its README\n";
      must(t, a);
      return t.replace(a, '');
    },
    expectRed: /ATX_EFiles_synthetic\.csv/,
  },
];
