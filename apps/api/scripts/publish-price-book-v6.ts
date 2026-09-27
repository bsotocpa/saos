/*
 * PUBLISH PRICE BOOK v6 THROUGH THE VERSION DOOR (Brian, 2026-09-27, R75).
 *
 * Run once on the box, inside the API container, after the deploy that carries migrations 0128/0129:
 *
 *   docker exec saos-api-1 node scripts/publish-price-book-v6.ts            (dry run: prints the request)
 *   docker exec saos-api-1 node scripts/publish-price-book-v6.ts --apply    (publishes)
 *
 * It does not write a row itself. It builds the request from the change set
 * (packages/db/seeds/data/price_book_v6.mjs, BIZ_990's deposit read from the book it copies), opens a
 * CEO session LABELLED with the ruling (so every audit row reads "… (ruled 2026-09-27 R75, applied by
 * script)"), and posts it to POST /admin/price-book/versions — the same door Admin → Pricing uses, with
 * the R55 deposit check. Refuses if a v6 already exists, or if the latest version is not v5.
 */
import { buildServer } from '../src/server.ts';
import { loadConfig } from '../src/config.ts';
import { createSession } from '../src/modules/auth/service.ts';
import { versionRequestFor } from '../src/modules/admin/price-book-change-set.ts';
// @ts-expect-error — the change set is plain JavaScript data under packages/db, where the book lives.
import { PRICE_BOOK_V6 } from '../../../packages/db/seeds/data/price_book_v6.mjs';

const APPLY = process.argv.includes('--apply');
const APPLIED_BY = 'ruled 2026-09-27 R75, applied by script';

const config = loadConfig();
const app = buildServer(config);
await app.ready();
try {
  const latest = await app.db.query<{ version_number: number; effective_from: string; effective_to: string | null }>(
    `SELECT version_number, effective_from::text AS effective_from, effective_to::text AS effective_to
       FROM price_book_versions ORDER BY version_number DESC LIMIT 1`
  );
  const cur = latest.rows[0];
  if (!cur) throw new Error('refusing: no price book on this database');
  if (cur.version_number !== 5) {
    throw new Error(`refusing: the latest version is v${cur.version_number}; this script publishes v6 over v5 once`);
  }
  const body = await versionRequestFor(app.db, PRICE_BOOK_V6);
  console.log(`publish-price-book-v6: v${cur.version_number} (from ${cur.effective_from}) → v6 effective ${body.effectiveFrom}`);
  console.log(`  additions: ${body.additions.map((a) => `${a.itemCode} ${a.pricingMode} amount=${a.amountCents} deposit=${a.depositCents} group=${a.groupKey} sort=${a.sortOrder}`).join('; ')}`);
  console.log(`  discount rules: ${body.discountRules.map((r) => `${String(r.ruleCode)} ${String(r.percentRate)}% on ${(r.appliesToServiceLines as string[]).join(', ')} (${String(r.condition)}, ${String(r.scope)})`).join('; ')}`);
  if (!APPLY) {
    console.log('  dry run: nothing published (add --apply)');
  } else {
    const ceo = await app.db.query<{ id: string }>(
      `SELECT st.id FROM staff st JOIN roles r ON r.id = st.role_id WHERE r.key = 'ceo' AND st.is_active ORDER BY st.created_at LIMIT 1`
    );
    if (!ceo.rows[0]) throw new Error('refusing: no active CEO');
    const token = await createSession(app.db, config, ceo.rows[0].id, { appliedBy: APPLIED_BY });
    const res = await app.inject({
      method: 'POST', url: '/admin/price-book/versions',
      headers: { authorization: `Bearer ${token}` },
      payload: body,
    });
    console.log(`  POST /admin/price-book/versions → ${res.statusCode} ${res.body}`);
    await app.db.query(`UPDATE staff_sessions SET revoked_at = now() WHERE staff_id = $1 AND revoked_at IS NULL AND user_agent = $2`,
      [ceo.rows[0].id, `script: ${APPLIED_BY}`]);
    if (res.statusCode !== 201) process.exitCode = 1;
  }
} finally {
  await app.close();
}
