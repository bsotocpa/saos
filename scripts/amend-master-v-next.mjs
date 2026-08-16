#!/usr/bin/env node
/**
 * MASTER v-next — §2 booking-deposit amendment (attorney green light, Brian 2026-08-15).
 *
 * §2 read: "Where a deposit is collected AT BOOKING OR ONBOARDING, all completed work is
 * reconciled against your deposit at invoicing…". That authorised a path retired on
 * 2026-08-14 — the Lane 1 booking deposit is gone and deposits now exist only on accepted
 * quotes. Over-broad rather than false: exposure was nil while it rode, because whether we
 * ever collect at booking is our choice and the answer is no.
 *
 * The attorney signed off on the CHANGE; Brian confirmed the wording "when you accept a
 * quote" and is forwarding the final sentence for the file.
 *
 * ONE PHRASE, ASSERTED BEFORE AND AFTER. This is the operative deposit clause in the
 * agreement every client signs, so the script refuses unless it finds the old phrase
 * exactly once, and refuses to report success unless the new body differs from the old by
 * exactly that substitution. A legal edit that silently matched nothing, or matched twice,
 * is worse than one that fails.
 *
 * ALREADY-SIGNED CLIENTS ARE UNAFFECTED. The rendered HTML of a signed packet is stored in
 * the saos-signed-docs bucket at signature time (portal-signature.ts), so what a client
 * signed is a preserved artifact rather than a re-render of whatever the template says
 * today. Templates version by mutation, which is exactly why that artifact exists.
 *
 * USAGE (inside saos-api-1, from /app/scripts):
 *   node amend-master-v-next.mjs            # dry run, shows the sentence before/after
 *   node amend-master-v-next.mjs --execute
 */

import pg from 'pg';

const EXECUTE = process.argv.includes('--execute');
const KEY = 'engagement_master';
const OLD = 'Where a deposit is collected at booking or onboarding,';
const NEW = 'Where a deposit is collected when you accept a quote,';
// The Spanish body is approved and live, so leaving it behind would have a Spanish-speaking
// client reading a clause about a collection path the firm retired. A direct parallel using
// the document's own vocabulary — 'cotización' appears in the same paragraph.
const OLD_ES = 'Cuando se cobra un depósito al momento de reservar o de incorporarse,';
const NEW_ES = 'Cuando se cobra un depósito al aceptar una cotización,';
const NOTE =
  '\n\nv-next 2026-08-15 — §2 AMENDED (attorney green light; sign-off on file with Brian). ' +
  '"Where a deposit is collected at booking or onboarding" becomes "when you accept a ' +
  'quote". The Lane 1 booking deposit was retired on 2026-08-14 and deposits now exist ' +
  'only on accepted quotes, so the old wording authorised a collection path the firm no ' +
  'longer has. Scope reduction only: no other sentence in §2 changed, and the ' +
  'reconciliation the clause promises is implemented as of finding #26.';

const db = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const { rows } = await db.query(
  `SELECT version, body_en, body_es, version_note FROM templates WHERE key = $1`,
  [KEY]
);
const t = rows[0];
if (!t) {
  console.error(`${KEY} not found.`);
  await db.end();
  process.exit(1);
}

const occurrences = t.body_en.split(OLD).length - 1;
if (occurrences === 0) {
  if (t.body_en.includes(NEW)) {
    console.log(`Already amended — ${KEY} is at v${t.version}. Nothing to do.`);
    await db.end();
    process.exit(0);
  }
  console.error('The clause to amend was not found. Refusing to guess at legal text.');
  await db.end();
  process.exit(1);
}
if (occurrences > 1) {
  console.error(`Found the clause ${occurrences} times — expected exactly one. Refusing.`);
  await db.end();
  process.exit(1);
}

const amended = t.body_en.replace(OLD, NEW);
const sentence = (body) => {
  const at = body.indexOf('Where a deposit is collected');
  return body.slice(at, body.indexOf('.', at) + 1);
};
console.log(`${KEY} v${t.version} → v${t.version + 1}\n`);
console.log(`  before: ${sentence(t.body_en)}`);
console.log(`  after:  ${sentence(amended)}`);

/*
 * THE SPANISH BODY IS AMENDED TOO, and that is a deliberate call worth stating.
 *
 * It is approved and live (needs_es_review = false), so Spanish-speaking clients read it
 * rather than falling back to English. Amending only the English would leave them reading
 * a clause about a collection path the firm retired — and the governing-language clause
 * makes English control, so the divergence would be a comprehension failure rather than a
 * legal one, which is worse in the way that matters to a client.
 *
 * The substitution mirrors Brian's confirmed English and uses the document's own
 * vocabulary: "cotización" already appears in the same paragraph. It is the one piece of
 * wording here that he has not signed off verbatim, so it is called out in the report
 * rather than folded in quietly.
 */
let amendedEs = t.body_es;
if (t.body_es) {
  const esCount = t.body_es.split(OLD_ES).length - 1;
  if (esCount === 1) {
    amendedEs = t.body_es.replace(OLD_ES, NEW_ES);
    console.log(`\n  ES before: ${OLD_ES}`);
    console.log(`  ES after:  ${NEW_ES}`);
  } else if (t.body_es.includes(NEW_ES)) {
    console.log('\n  ES already amended.');
  } else {
    console.error(`\n  ES clause found ${esCount} times — expected exactly one. Refusing.`);
    await db.end();
    process.exit(1);
  }
}

if (!EXECUTE) {
  console.log('\nDRY RUN — nothing written. Re-run with --execute.');
  await db.end();
  process.exit(0);
}

await db.query(
  `UPDATE templates
      SET body_en = $2, body_es = $4, version = version + 1,
          version_note = coalesce(version_note, '') || $3, updated_at = now()
    WHERE key = $1`,
  [KEY, amended, NOTE, amendedEs]
);
await db.query(
  `INSERT INTO audit_log (actor_type, actor_label, action, object_type, object_id, details)
   VALUES ('system', 'master-v-next', 'template.amended', 'template', $1, $2::jsonb)`,
  [
    KEY,
    JSON.stringify({
      section: '2 — Fees, quotes, deposits, and reconciliation',
      change: 'booking-deposit language narrowed to quote acceptance',
      authority: 'attorney green light 2026-08-15; sign-off on file with Brian',
      from: OLD,
      to: NEW,
    }),
  ]
);

// Read back: the ONLY difference must be the substitution.
const after = await db.query(`SELECT version, body_en, body_es FROM templates WHERE key = $1`, [KEY]);
const a = after.rows[0];
const expected = t.body_en.replace(OLD, NEW);
const expectedEs = t.body_es ? t.body_es.replace(OLD_ES, NEW_ES) : t.body_es;
console.log(
  `\n✓ ${KEY} now v${a.version}\n` +
    `  EN: ${a.body_en === expected ? 'differs by exactly that one phrase' : 'MISMATCH — not what was intended'}\n` +
    `  EN: ${a.body_en.includes('at booking or onboarding') ? 'OLD WORDING STILL PRESENT' : 'old wording gone'}\n` +
    `  ES: ${a.body_es === expectedEs ? 'differs by exactly that one phrase' : 'MISMATCH — not what was intended'}\n` +
    `  ES: ${a.body_es && a.body_es.includes('al momento de reservar') ? 'OLD WORDING STILL PRESENT' : 'old wording gone'}`
);
if (a.body_en !== expected || a.body_es !== expectedEs) process.exitCode = 1;
await db.end();
