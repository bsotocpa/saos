/*
 * BEFORE THE API SUITE (Brian, 2026-09-29, R95): sweep the orphaned test databases, then build this
 * checkout's migrated template once, so the parallel specs clone it rather than race to build it.
 *
 * An orphan is a saos_api_test_* database no live checkout owns: its tag is not the tag of any
 * `git worktree list` root (the retired Dropbox checkout's, the untagged ones from before the tags),
 * or it is a template of this checkout's for migrations and seeds that no longer stand. Another live
 * checkout's databases are never touched: the receipt worktree may be running beside this one.
 *
 *   node --experimental-strip-types scripts/test-db-prepare.ts   (the API test script runs it first)
 */
import { execFileSync } from 'node:child_process';
import { adminClient, checkoutTag, dropDatabase, ensureTestTemplate, templateDatabaseName } from '../test/helpers.ts';

const roots = execFileSync('git', ['worktree', 'list', '--porcelain'], { encoding: 'utf8' })
  .split('\n').filter((l) => l.startsWith('worktree ')).map((l) => l.slice('worktree '.length).trim());
const live = new Set(roots.map(checkoutTag));
const current = templateDatabaseName();
const ownTag = /^saos_api_test_([0-9a-f]{6})_/.exec(current)![1]!;

const admin = await adminClient();
let dropped = 0;
let kept = 0;
try {
  const { rows } = await admin.query<{ datname: string }>(`SELECT datname FROM pg_database WHERE datname ~ '^saos_api_test(_|$)' ORDER BY datname`);
  for (const { datname } of rows) {
    const tag = /^saos_api_test_([0-9a-f]{6})_/.exec(datname)?.[1];
    const orphanCheckout = !tag || !live.has(tag);
    const staleTemplate = tag === ownTag && /_tpl_/.test(datname) && datname !== current;
    if (orphanCheckout || staleTemplate) { await dropDatabase(admin, datname); dropped++; } else kept++;
  }
} finally {
  await admin.end();
}
const tpl = await ensureTestTemplate();
console.log(`test-db-prepare: ${roots.length} live checkout(s); ${dropped} orphaned test database(s) dropped, ${kept} kept; template ${tpl}`);
