// Reports & KPIs (M27, v4.4). Owner-facing analytics, exportable as CSV.
//
// ONE REGISTRY drives everything: the catalog the UI lists, the JSON the tiles
// render, and the CSV columns. That is deliberate — a report whose CSV headers
// drift from its on-screen columns is worse than no export, because the numbers
// still look right.
//
// Two honesty rules baked in:
//   · money that cannot be attributed to a service line is reported as
//     'unattributed', never silently dropped or folded into a real line
//   · a report that CANNOT yet measure something says so in `caveat` instead of
//     approximating it. Guessed KPIs are how a firm ends up managed by fiction.

import type { FastifyInstance } from 'fastify';
import { AppError } from '../../types.ts';
import { todayChicago } from '../tax/deadlines.ts';

export type ColumnType = 'text' | 'money' | 'int' | 'percent' | 'date';

export interface ReportColumn {
  key: string;
  label: string;
  type: ColumnType;
}

export interface DateRange {
  from: string;
  to: string;
}

export interface ReportDef {
  key: string;
  title: string;
  description: string;
  columns: ReportColumn[];
  /** Stated limits of the measurement. Shown with the data, not buried. */
  caveat?: string;
  /** True when the report ignores the date range (a point-in-time snapshot). */
  snapshot?: boolean;
  run(app: FastifyInstance, range: DateRange): Promise<Array<Record<string, unknown>>>;
}

/** Year-to-date in the firm's timezone, unless the caller narrows it. */
export function defaultRange(): DateRange {
  const today = todayChicago();
  return { from: `${today.slice(0, 4)}-01-01`, to: today };
}

const money = (key: string, label: string): ReportColumn => ({ key, label, type: 'money' });
const int = (key: string, label: string): ReportColumn => ({ key, label, type: 'int' });
const text = (key: string, label: string): ReportColumn => ({ key, label, type: 'text' });

// ---------------------------------------------------------------- reports ---

const revenueByLineMonth: ReportDef = {
  key: 'revenue_by_line_month',
  title: 'Revenue by service line and month',
  description: 'Collected revenue (paid invoices) grouped by month and service line.',
  caveat:
    'Counts money COLLECTED, not billed — an invoice sent but unpaid appears in A/R aging, not here. ' +
    'Recurring subscription revenue lands when Stripe Billing ships (Phase 3); today every row is one-time invoicing.',
  columns: [
    text('month', 'Month'),
    text('service_line', 'Service line'),
    int('invoices', 'Invoices'),
    money('collected_cents', 'Collected'),
  ],
  async run(app, range) {
    const { rows } = await app.db.query(
      `SELECT to_char(date_trunc('month', i.paid_at), 'YYYY-MM') AS month,
              COALESCE(e.service_line::text, e2.service_line::text, 'unattributed') AS service_line,
              count(*)::int AS invoices,
              COALESCE(sum(i.amount_paid_cents), 0)::int AS collected_cents
       FROM invoices i
       LEFT JOIN engagements e ON e.id = i.engagement_id
       LEFT JOIN tax_engagements te ON te.id = i.tax_engagement_id
       LEFT JOIN engagements e2 ON e2.id = te.engagement_id
       WHERE i.status = 'paid' AND i.paid_at IS NOT NULL
         AND i.paid_at >= $1::date AND i.paid_at < ($2::date + 1)
       GROUP BY 1, 2
       ORDER BY 1 DESC, 4 DESC`,
      [range.from, range.to]
    );
    return rows;
  },
};

const arAging: ReportDef = {
  key: 'ar_aging',
  title: 'A/R aging',
  description: 'Open invoices by age since sending, with the balance still owed.',
  snapshot: true,
  caveat: 'A point-in-time snapshot of what is owed today — the date range does not apply.',
  columns: [
    text('bucket', 'Age'),
    int('invoices', 'Invoices'),
    money('owed_cents', 'Owed'),
    int('clients', 'Clients'),
    text('oldest_sent', 'Oldest sent'),
  ],
  async run(app) {
    const { rows } = await app.db.query(
      `SELECT CASE
                WHEN now() - sent_at <= interval '30 days' THEN '0-30'
                WHEN now() - sent_at <= interval '60 days' THEN '31-60'
                WHEN now() - sent_at <= interval '90 days' THEN '61-90'
                ELSE '90+' END AS bucket,
              count(*)::int AS invoices,
              COALESCE(sum(total_cents - amount_paid_cents), 0)::int AS owed_cents,
              count(DISTINCT contact_id)::int AS clients,
              to_char(min(sent_at), 'YYYY-MM-DD') AS oldest_sent
       FROM invoices
       WHERE status IN ('sent', 'overdue') AND sent_at IS NOT NULL
       GROUP BY 1 ORDER BY 1`
    );
    return rows;
  },
};

const pipelineConversion: ReportDef = {
  key: 'pipeline_conversion',
  title: 'Pipeline conversion',
  description: 'Quotes sent in the period and what became of them, by outcome.',
  caveat:
    'Win rate counts DECIDED quotes only (accepted + declined + expired). Quotes still open are ' +
    'neither wins nor losses, so a fresh quote never drags the rate down.',
  columns: [
    text('outcome', 'Outcome'),
    int('quotes', 'Quotes'),
    money('value_cents', 'Value'),
    text('share_of_decided', 'Share of decided'),
    text('median_days', 'Median days to decide'),
  ],
  async run(app, range) {
    const { rows } = await app.db.query<{
      outcome: string; quotes: number; value_cents: number; median_days: string | null;
    }>(
      `SELECT status::text AS outcome,
              count(*)::int AS quotes,
              COALESCE(sum(total_cents), 0)::int AS value_cents,
              to_char(percentile_cont(0.5) WITHIN GROUP (
                ORDER BY EXTRACT(EPOCH FROM (COALESCE(accepted_at, declined_at) - sent_at)) / 86400.0
              ), 'FM990.0') AS median_days
       FROM quotes
       WHERE sent_at IS NOT NULL AND sent_at >= $1::date AND sent_at < ($2::date + 1)
       GROUP BY 1 ORDER BY 2 DESC`,
      [range.from, range.to]
    );
    const decided = rows
      .filter((r) => ['accepted', 'declined', 'expired'].includes(r.outcome))
      .reduce((sum, r) => sum + r.quotes, 0);
    return rows.map((r) => ({
      ...r,
      share_of_decided:
        decided === 0 || !['accepted', 'declined', 'expired'].includes(r.outcome)
          ? '—'
          : `${Math.round((r.quotes / decided) * 1000) / 10}%`,
      median_days: r.median_days ?? '—',
    }));
  },
};

const referralPerformance: ReportDef = {
  key: 'referral_performance',
  title: 'Referral-source performance',
  description: 'Referrals created in the period by direction and source, with conversion.',
  caveat:
    'Hilo→Soto referrals cannot reach sent/converted without the alternatives-exist disclosure on ' +
    'record (enforced by a database CHECK), so these counts are also the disclosure trail.',
  columns: [
    text('direction', 'Direction'),
    text('source', 'Source'),
    int('referrals', 'Referrals'),
    int('sent', 'Sent'),
    int('converted', 'Converted'),
    text('conversion_rate', 'Conversion'),
  ],
  async run(app, range) {
    const { rows } = await app.db.query<{
      direction: string; source: string; referrals: number; sent: number; converted: number;
    }>(
      `SELECT direction::text, source::text,
              count(*)::int AS referrals,
              count(*) FILTER (WHERE status IN ('sent', 'converted'))::int AS sent,
              count(*) FILTER (WHERE status = 'converted')::int AS converted
       FROM referrals
       WHERE created_at >= $1::date AND created_at < ($2::date + 1)
       GROUP BY 1, 2 ORDER BY 3 DESC`,
      [range.from, range.to]
    );
    return rows.map((r) => ({
      ...r,
      conversion_rate: r.sent === 0 ? '—' : `${Math.round((r.converted / r.sent) * 1000) / 10}%`,
    }));
  },
};

const sessionUtilization: ReportDef = {
  key: 'session_utilization',
  title: 'Session utilization per client',
  description: 'Sessions held, still scheduled, and cancelled per client in the period.',
  caveat:
    'Usage against ENTITLEMENT for clients whose engagement has been configured (sessions_per_year from ' +
    'the session-cadence dial). A client with no configured recurring engagement shows "—" for entitled: ' +
    'that is unconfigured, not zero. Low utilization is a maintenance-mode candidate — hold the prep ' +
    'cadence, reduce the sessions — not proof that a client is over-serviced. The S corp floor column is ' +
    'a backstop: the configurator refuses to create a sub-floor configuration, so a flag here means a ' +
    'client whose sessions were not actually held, or one configured before the gate existed.',
  columns: [
    text('client', 'Client'),
    text('entity_types', 'Entity'),
    int('held', 'Held'),
    int('scheduled', 'Still scheduled'),
    int('cancelled', 'Cancelled'),
    text('entitled_per_year', 'Entitled/yr'),
    text('utilization', 'Utilization'),
    text('scorp_floor_flag', 'S corp floor'),
  ],
  async run(app, range) {
    const { rows } = await app.db.query<{
      client: string; entity_types: string | null; held: number; scheduled: number;
      cancelled: number; is_active_scorp: boolean; held_trailing_year: number;
      entitled_per_year: number | null;
    }>(
      `SELECT c.first_name || ' ' || c.last_name AS client,
              (SELECT string_agg(DISTINCT b.entity_type::text, ', ')
               FROM business_members bm JOIN businesses b ON b.id = bm.business_id
               WHERE bm.contact_id = c.id) AS entity_types,
              count(*) FILTER (WHERE s.status = 'completed')::int AS held,
              count(*) FILTER (WHERE s.status = 'scheduled')::int AS scheduled,
              count(*) FILTER (WHERE s.status = 'cancelled')::int AS cancelled,
              EXISTS (
                SELECT 1 FROM business_members bm2 JOIN businesses b2 ON b2.id = bm2.business_id
                WHERE bm2.contact_id = c.id AND b2.entity_type = 's_corp'
              ) AND c.soto_status = 'active' AS is_active_scorp,
              (SELECT count(*)::int FROM client_sessions s2
               WHERE s2.contact_id = c.id AND s2.status = 'completed'
                 AND s2.starts_at >= now() - interval '1 year') AS held_trailing_year,
              -- Entitlement from the configurator's session dial. NULL means no
              -- recurring engagement has been configured — unconfigured, not zero.
              (SELECT max(e.sessions_per_year) FROM engagements e
               WHERE e.contact_id = c.id AND e.status = 'active'
                 AND e.sessions_per_year IS NOT NULL) AS entitled_per_year
       FROM contacts c
       JOIN client_sessions s ON s.contact_id = c.id
         AND s.starts_at >= $1::date AND s.starts_at < ($2::date + 1)
       WHERE NOT c.is_archived
       GROUP BY c.id, c.first_name, c.last_name, c.soto_status
       ORDER BY 3 DESC, 1`,
      [range.from, range.to]
    );
    return rows.map((r) => ({
      client: r.client,
      entity_types: r.entity_types ?? '—',
      held: r.held,
      scheduled: r.scheduled,
      cancelled: r.cancelled,
      entitled_per_year: r.entitled_per_year === null ? '—' : String(r.entitled_per_year),
      // Utilization only means something against a configured entitlement.
      utilization:
        r.entitled_per_year === null || r.entitled_per_year === 0
          ? '—'
          : `${Math.round((r.held_trailing_year / r.entitled_per_year) * 100)}%`,
      scorp_floor_flag:
        !r.is_active_scorp ? 'n/a' : r.held_trailing_year < 2 ? `BELOW FLOOR (${r.held_trailing_year}/2)` : 'ok',
    }));
  },
};

const teamThroughput: ReportDef = {
  key: 'team_throughput',
  title: 'Team throughput',
  description: 'Work completed per staff member in the period: tasks, returns filed, hours logged.',
  caveat:
    'Throughput is volume, not value — a 1040 and a multi-entity 1120-S both count as one return. ' +
    'Filed and ACCEPTED are reported separately on purpose: filing is not the finish line, e-file ' +
    'acceptance is, and a rejected return would otherwise inflate the filed column. ' +
    'Complexity-weighted throughput needs the complexity score on every engagement, not just scored ones.',
  columns: [
    text('staff', 'Staff'),
    text('role', 'Role'),
    int('tasks_completed', 'Tasks completed'),
    int('returns_filed', 'Returns filed'),
    int('returns_accepted', 'Returns accepted'),
    text('hours_logged', 'Hours logged'),
    text('pro_bono_hours', 'Pro bono hours'),
    int('open_now', 'Open now'),
  ],
  async run(app, range) {
    const { rows } = await app.db.query(
      `SELECT st.full_name AS staff, r.key AS role,
              (SELECT count(*)::int FROM tasks t
               WHERE t.assigned_staff_id = st.id AND t.status = 'completed'
                 AND t.completed_at >= $1::date AND t.completed_at < ($2::date + 1)) AS tasks_completed,
              (SELECT count(*)::int FROM tax_engagements te
               WHERE te.preparer_id = st.id AND te.filed_date IS NOT NULL
                 AND te.filed_date >= $1::date AND te.filed_date <= $2::date) AS returns_filed,
              (SELECT count(*)::int FROM tax_engagements te
               WHERE te.preparer_id = st.id AND te.efile_accepted_at IS NOT NULL
                 AND te.efile_accepted_at >= $1::date AND te.efile_accepted_at < ($2::date + 1)) AS returns_accepted,
              (SELECT to_char(COALESCE(sum(hours), 0), 'FM990.00') FROM time_entries tm
               WHERE tm.staff_id = st.id AND tm.status = 'confirmed'
                 AND tm.entry_date >= $1::date AND tm.entry_date <= $2::date) AS hours_logged,
              (SELECT to_char(COALESCE(sum(hours), 0), 'FM990.00') FROM time_entries tm
               WHERE tm.staff_id = st.id AND tm.status = 'confirmed' AND tm.is_pro_bono
                 AND tm.entry_date >= $1::date AND tm.entry_date <= $2::date) AS pro_bono_hours,
              (SELECT count(*)::int FROM tasks t
               WHERE t.assigned_staff_id = st.id
                 AND t.status IN ('not_started','in_progress','waiting_for_input','deferred')) AS open_now
       FROM staff st JOIN roles r ON r.id = st.role_id
       WHERE st.is_active
       ORDER BY 3 DESC, st.full_name`,
      [range.from, range.to]
    );
    return rows;
  },
};

const clientCounts: ReportDef = {
  key: 'client_counts',
  title: 'Client counts by industry and cadence',
  description: 'Active clients grouped by industry, with the bookkeeping cadence they are on.',
  snapshot: true,
  caveat:
    'A point-in-time snapshot; the date range does not apply. Cadence comes from close cycles, so a ' +
    'client with no closes yet shows "none" — that is a real state (tax-only clients), not missing data. ' +
    'Industry lives on the BUSINESS, so an individual client with no business shows "unspecified"; the ' +
    'migrated book is largely unspecified until the enrichment queue is worked.',
  columns: [
    text('industry', 'Industry'),
    text('cadence', 'Cadence'),
    int('clients', 'Clients'),
  ],
  async run(app) {
    const { rows } = await app.db.query(
      `SELECT COALESCE(NULLIF(ind.industry, ''), 'unspecified') AS industry,
              COALESCE(cad.cadence, 'none') AS cadence,
              count(*)::int AS clients
       FROM contacts c
       LEFT JOIN LATERAL (
         -- The client's primary business drives industry; fall back to any of theirs.
         SELECT b.industry FROM business_members bm JOIN businesses b ON b.id = bm.business_id
         WHERE bm.contact_id = c.id AND b.industry IS NOT NULL
         ORDER BY bm.is_primary DESC LIMIT 1
       ) ind ON true
       LEFT JOIN LATERAL (
         SELECT cc.cadence FROM close_cycles cc
         WHERE cc.contact_id = c.id ORDER BY cc.period_start DESC LIMIT 1
       ) cad ON true
       WHERE c.soto_status = 'active' AND NOT c.is_archived
       GROUP BY 1, 2 ORDER BY 3 DESC, 1, 2`
    );
    return rows;
  },
};

export const REPORTS: Record<string, ReportDef> = {
  [revenueByLineMonth.key]: revenueByLineMonth,
  [arAging.key]: arAging,
  [pipelineConversion.key]: pipelineConversion,
  [referralPerformance.key]: referralPerformance,
  [sessionUtilization.key]: sessionUtilization,
  [teamThroughput.key]: teamThroughput,
  [clientCounts.key]: clientCounts,
};

export function reportCatalog() {
  return Object.values(REPORTS).map((r) => ({
    key: r.key,
    title: r.title,
    description: r.description,
    columns: r.columns,
    caveat: r.caveat ?? null,
    snapshot: r.snapshot ?? false,
  }));
}

export async function runReport(
  app: FastifyInstance,
  key: string,
  range: DateRange
): Promise<{
  key: string; title: string; columns: ReportColumn[]; caveat: string | null;
  snapshot: boolean; range: DateRange; rows: Array<Record<string, unknown>>;
}> {
  const def = REPORTS[key];
  if (!def) throw new AppError(404, 'unknown_report', `No report '${key}'.`);
  if (range.from > range.to) {
    throw new AppError(400, 'bad_range', 'The start of the range is after its end.');
  }
  const rows = await def.run(app, range);
  return {
    key: def.key,
    title: def.title,
    columns: def.columns,
    caveat: def.caveat ?? null,
    snapshot: def.snapshot ?? false,
    range,
    rows,
  };
}
