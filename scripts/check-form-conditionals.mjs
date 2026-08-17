#!/usr/bin/env node
/*
 * EVERY CONDITIONAL QUESTION MUST HAVE A TRIGGER THAT CAN ACTUALLY HAPPEN (#46).
 *
 * A `showWhen` names a parent question and the value that reveals it. If the parent does
 * not exist, or does not offer that value, the conditional question is invisible forever —
 * and it is invisible SILENTLY. Nothing errors, nothing logs, the form just quietly never
 * asks. That is what happened to F6's "Other" companion: the companion shipped, the option
 * it waits for did not, and the deploy reported success.
 *
 * This is the build-time half. It reads the SOURCE definitions and catches authoring
 * mistakes: a typo in the parent id, a value that is not on the parent's list, a
 * conditional pointing at a question with no options at all.
 *
 * IT WOULD NOT HAVE CAUGHT #46 ON ITS OWN, and that is worth being plain about. The
 * source was correct; the deployed data was stale. Drift between the two is checked in
 * the SEED — `verifyConditionals()` in packages/db/seeds/data/forms.mjs runs the same
 * invariant against what is actually in the database, on every deploy. Two halves,
 * because a bug that lives in the gap between source and deployment cannot be found by
 * looking at either one alone.
 */

import { ONBOARDING_MODULES, SOTO_INTAKE_DEFINITION, HILO_INTAKE_DEFINITION } from '../packages/db/seeds/data/forms.mjs';

const problems = [];

/** Modules speak `question`; intake definitions speak `field`. Same idea, two vocabularies. */
function check(label, items, idKey, parentKey) {
  const byId = new Map(items.map((q) => [q[idKey], q]));
  for (const q of items) {
    const c = q.showWhen;
    if (!c) continue;
    const parentId = c[parentKey];
    const parent = byId.get(parentId);
    if (!parent) {
      problems.push(`${label}/${q[idKey]}: showWhen points at "${parentId}", which does not exist here`);
      continue;
    }
    const wanted = c.includesAny ?? (c.in ?? (c.equals !== undefined ? [c.equals] : []));
    if (wanted.length === 0) continue;
    // A free-text or numeric parent has no option list; any value is possible.
    if (!parent.options) continue;
    const available = new Set(parent.options.map((o) => (typeof o === 'string' ? o : o.value)));
    for (const v of wanted) {
      if (!available.has(v)) {
        problems.push(
          `${label}/${q[idKey]}: waits for ${parentId} = "${v}", but ${parentId} does not offer that ` +
          `(it offers: ${[...available].join(', ')})`
        );
      }
    }
  }
}

for (const m of ONBOARDING_MODULES) check(m.key, m.questions, 'id', 'question');
for (const d of [SOTO_INTAKE_DEFINITION, HILO_INTAKE_DEFINITION]) {
  check(d.slug, d.screens.flatMap((s) => s.fields), 'key', 'field');
}

if (problems.length > 0) {
  console.error('\n✖ Conditional questions whose trigger can never happen.');
  console.error('  These render as nothing, forever, without erroring.\n');
  for (const p of problems) console.error(`  ${p}`);
  console.error('');
  process.exit(1);
}
console.log(`check:form-conditionals: every showWhen has a parent that can produce its trigger.`);
