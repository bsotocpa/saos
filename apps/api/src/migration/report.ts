// M22 dry-run report + Vaultwarden export. The report lives in the
// git-ignored migration-data/ folder (it names clients — fine for Brian's
// eyes, never for git). The console gets counts only.

import type { CredentialItem } from './sources.ts';
import type { ImportPlan } from './plan.ts';

export function buildReport(
  plan: ImportPlan,
  ctx: {
    dryRun: boolean;
    dir: string;
    sheets: Array<{ name: string; dataRows: number; sectionRows: number }>;
    invoiceRows: number;
    projectRows: number;
    invoicesUnmatched: number;
    unmatchedInvoiceClients: string[];
    projectEmailsNotInRoster: string[];
    options: { today: string; dubsadoWindowMonths: number; zohoInactiveMonths: number };
  }
): string {
  const s = plan.stats;
  const skipReasons = new Map<string, number>();
  for (const sk of plan.skipped) {
    const bucket = sk.reason.replace(/\d+mo/, 'Nmo').replace(/duplicate of .*/, 'duplicate');
    skipReasons.set(bucket, (skipReasons.get(bucket) ?? 0) + 1);
  }

  const missing = new Map<string, number>();
  for (const c of plan.contacts) for (const f of new Set(c.missingFields)) missing.set(f, (missing.get(f) ?? 0) + 1);

  const grantsByStatus = new Map<string, { n: number; cents: number }>();
  for (const g of plan.grants) {
    const cur = grantsByStatus.get(g.status) ?? { n: 0, cents: 0 };
    cur.n++;
    cur.cents += g.amountCents ?? 0;
    grantsByStatus.set(g.status, cur);
  }
  const money = (cents: number) => `$${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2 })}`;

  const migratedClients = plan.contacts.filter((c) => c.sotoStatus !== 'lead');

  return `# M22 migration ${ctx.dryRun ? 'DRY-RUN' : 'EXECUTION'} report

Generated ${new Date().toISOString()} · source dir: ${ctx.dir}
Rules: as-of ${ctx.options.today} · Dubsado window ${ctx.options.dubsadoWindowMonths}mo (≤24mo → active, else inactive) · Zoho skip if inactive ${ctx.options.zohoInactiveMonths}mo+ and untagged

## Contacts
| | |
|---|---|
| Dubsado client rows | ${s.dubsado_rows} (activity from ${ctx.projectRows} projects by email + ${ctx.invoiceRows} invoices by name; ${ctx.invoicesUnmatched} billing names had no client row) |
| → import as ACTIVE (≤24mo) | ${s.dubsado_active} |
| → import as INACTIVE (24–${ctx.options.dubsadoWindowMonths}mo) | ${s.dubsado_inactive_in_window} |
| Zoho contact rows | ${s.zoho_contact_rows} |
| → merged into a Dubsado client (fill-don't-overwrite) | ${s.zoho_merged_into_dubsado} |
| → new contacts (as leads) | ${s.zoho_new_contacts} |
| Zoho lead rows | ${s.zoho_lead_rows} (unconverted + recent → ${s.zoho_leads_imported} imported) |
| **Total contacts planned** | **${s.contacts_planned}** |
| Skipped (all sources) | ${s.skipped_total} |

Skip reasons:
${[...skipReasons.entries()].sort((a, b) => b[1] - a[1]).map(([r, n]) => `- ${n} × ${r}`).join('\n') || '- none'}

### ⚠ Review list — Dubsado clients skipped for having NO activity signal
The Dubsado export's \`start\` column is empty for every row, so activity comes
from invoice matching alone. These clients matched no invoice — either truly
dormant, or their invoices bill under a business name (see the next list).
Rescue any real client by adding them in the CRM after import:
${plan.skipped
  .filter((sk) => sk.source === 'dubsado' && sk.reason === 'no activity date on record')
  .map((sk) => `- ${sk.raw['firstName'] ?? ''} ${sk.raw['lastName'] ?? ''} <${sk.raw['email'] ?? 'no email'}>`)
  .join('\n') || '- none'}

### ⚠ Review list — invoice "Client" names with no client row (likely business-name billing)
${ctx.unmatchedInvoiceClients.map((n) => `- ${n}`).join('\n') || '- none'}

### ⚠ Review list — project client emails absent from the client roster
${ctx.projectEmailsNotInRoster.map((n) => `- ${n}`).join('\n') || '- none'}

## Businesses (from Zoho accounts)
- Planned: **${s.businesses_planned}** (with EIN/entity/industry data or a distinct business name, linked to an imported owner)
- Skipped — no imported owner linked: ${s.accounts_skipped_no_imported_owner}
- Skipped — personal shell (same name as the person, no business data): ${s.accounts_skipped_personal_shell}

## Enrichment queue (gaps the portal's first-login checklist backfills)
${[...missing.entries()].sort((a, b) => b[1] - a[1]).map(([f, n]) => `- ${n} × missing ${f}`).join('\n') || '- no gaps'}

## Grants (Grant Tracker → grants_received)
Sheets: ${ctx.sheets.map((sh) => `"${sh.name}" (${sh.dataRows} rows, ${sh.sectionRows} section labels skipped)`).join(' · ')}

| Status | Count | Tracked amounts |
|---|---|---|
${[...grantsByStatus.entries()].sort((a, b) => b[1].n - a[1].n).map(([st, v]) => `| ${st} | ${v.n} | ${money(v.cents)} |`).join('\n')}
| **total** | **${s.grants_planned}** | |

## 🔐 Funder-portal credentials → Vaultwarden (NEVER the database)
- **${s.credentials_to_vaultwarden} credential row(s)** were separated at parse time. They are NOT in the
  grants table, NOT in import_records, and NOT in this report.
- Written to \`vaultwarden-import.json\` (Bitwarden format) next to this report.
  Import it: Vaultwarden → Tools → Import data → Bitwarden (json) — then
  **delete that file** and purge the credential columns from the Google Sheet.
- ${plan.credentials.filter((c) => c.combined).length} row(s) came from the 2023 combined column (username/email/password in one cell) — they land in the item's notes for a manual split.

## Migrated-client onboarding (staged, NOT sent)
- ${migratedClients.length} imported contacts are Soto clients (active/inactive) — the
  "we upgraded our portal" sequence for them is STAGED ONLY. Nothing sends until the
  M23 launch gates pass; sending is the existing per-client portal-access grant
  (bilingual template \`portal_migration_welcome\`, editable in Admin → Templates).

## Review flags
${plan.reviewFlags.map((f) => `- ${f}`).join('\n') || '- none'}

${ctx.dryRun ? '## Next step\nReview the numbers above. To load the database:\n\n    npm run import:legacy -- --execute\n' : '## Done\nRe-running is safe — existing records are marked duplicates, never doubled.'}
`;
}

/** Bitwarden-format export for Vaultwarden's Tools → Import. */
export function buildVaultwardenExport(credentials: CredentialItem[]): string {
  return JSON.stringify(
    {
      encrypted: false,
      items: credentials.map((c) => ({
        type: 1, // login
        name: `${c.grantName}${c.sheetYear ? ` (${c.sheetYear})` : ''} — funder portal`,
        notes: c.combined
          ? `Imported from Grant Tracker ${c.sheetYear ?? ''}. COMBINED legacy cell — split into username/password manually:\n${c.combined}`
          : `Imported from Grant Tracker ${c.sheetYear ?? ''}.`,
        login: {
          username: c.username,
          password: c.password,
          uris: c.materialsLink ? [{ match: null, uri: c.materialsLink }] : [],
        },
        favorite: false,
      })),
    },
    null,
    2
  );
}
