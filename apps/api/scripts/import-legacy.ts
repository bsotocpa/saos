// M22 legacy import CLI.
//
//   npm run import:legacy                    # DRY RUN (default): report + Vaultwarden file, no DB data writes
//   npm run import:legacy -- --execute       # load the database (idempotent; re-runs mark duplicates)
//   flags: --dir=<path> --dubsado-window=36 --zoho-inactive=36 --as-of=YYYY-MM-DD
//
// Console output is COUNTS ONLY (no client data). The full report — which
// names clients, so it stays in the git-ignored source dir — lands at
// <dir>/import-report.md. Funder-portal credentials go to
// <dir>/vaultwarden-import.json and NEVER into the database (CLAUDE.md;
// grants_received table comment).

import { existsSync } from 'node:fs';
import { readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { loadConfig } from '../src/config.ts';
import { todayChicago } from '../src/modules/tax/deadlines.ts';
import { parseDubsado, parseGrantTracker, parseZoho } from '../src/migration/sources.ts';
import { buildPlan } from '../src/migration/plan.ts';
import { executePlan } from '../src/migration/execute.ts';
import { buildReport, buildVaultwardenExport } from '../src/migration/report.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../..');

function arg(name: string): string | null {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
}

const dir = path.resolve(arg('dir') ?? path.join(repoRoot, 'migration-data'));
const execute = process.argv.includes('--execute');
const options = {
  today: arg('as-of') ?? todayChicago(),
  dubsadoWindowMonths: Number(arg('dubsado-window') ?? 36),
  zohoInactiveMonths: Number(arg('zoho-inactive') ?? 36),
};

if (!(await readdir(dir)).some((f) => /clients.*\.csv$/i.test(f))) {
  console.error(`import: ${dir} has no *clients*.csv — point --dir= at the export folder.`);
  process.exit(1);
}
if (!existsSync(path.join(dir, 'zoho-extracted', 'Data'))) {
  console.error(
    `import: ${dir}\\zoho-extracted\\Data not found. Expand the Zoho backup first:\n` +
      `  Expand-Archive -Path "${dir}\\Data_001.zip" -DestinationPath "${dir}\\zoho-extracted"`
  );
  process.exit(1);
}

const xlsx = (await readdir(dir)).find((f) => f.toLowerCase().endsWith('.xlsx'));
if (!xlsx) {
  console.error(`import: no Grant Tracker .xlsx found in ${dir}.`);
  process.exit(1);
}

console.log(`import: ${execute ? 'EXECUTE' : 'dry run'} from ${dir} (as of ${options.today})`);
const dubsado = await parseDubsado(dir);
const zoho = await parseZoho(dir);
const tracker = await parseGrantTracker(path.join(dir, xlsx));

const plan = buildPlan(
  { dubsado: dubsado.clients, zoho, grants: tracker.grants, credentials: tracker.credentials },
  options
);

// Report + credentials file live next to the exports (git-ignored), never in git.
const reportPath = path.join(dir, 'import-report.md');
await writeFile(
  reportPath,
  buildReport(plan, {
    dryRun: !execute,
    dir,
    sheets: tracker.sheets,
    invoiceRows: dubsado.invoiceRows,
    projectRows: dubsado.projectRows,
    invoicesUnmatched: dubsado.invoicesUnmatched,
    unmatchedInvoiceClients: dubsado.unmatchedInvoiceClients,
    projectEmailsNotInRoster: dubsado.projectEmailsNotInRoster,
    options,
  }),
  'utf8'
);
const vaultPath = path.join(dir, 'vaultwarden-import.json');
await writeFile(vaultPath, buildVaultwardenExport(plan.credentials), 'utf8');

const config = loadConfig();
const pool = new pg.Pool({ connectionString: config.DATABASE_URL });
try {
  const result = await executePlan(pool, plan, { dryRun: !execute, dirLabel: path.basename(dir) });
  console.log('import: plan —', JSON.stringify(plan.stats));
  if (execute) {
    console.log(
      `import: EXECUTED — contacts ${result.contactsCreated} created / ${result.contactsDuplicate} duplicate; ` +
        `businesses ${result.businessesCreated}/${result.businessesDuplicate}; owners linked ${result.ownersLinked}; ` +
        `grants ${result.grantsCreated}/${result.grantsDuplicate}; enrichment ${result.enrichmentQueued}; ` +
        `skipped recorded ${result.skippedRecorded}`
    );
  } else {
    console.log('import: DRY RUN — no contact/business/grant rows written (batch bookkeeping only).');
  }
  console.log(`import: report  -> ${reportPath}`);
  console.log(`import: creds   -> ${vaultPath} (${plan.credentials.length} items — import to Vaultwarden, then DELETE this file)`);
} finally {
  await pool.end();
}
