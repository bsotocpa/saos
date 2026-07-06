// Dashboard aggregations (MP Dashboards — Phase 1 set): Executive (Brian) and
// Hilo Ops (Jackson). Pure reads; every figure traces to the tables the
// modules already maintain. Placeholders are EXPLICIT where the source module
// is a later phase (MRR → Phase 3 subscriptions; milestones/workshops/grant
// cycles → Phase 2/3) — never silently invented numbers.

import type { FastifyInstance } from 'fastify';
import { deadlineDashboard } from '../tax/extension.ts';
import { todayChicago } from '../tax/deadlines.ts';

export async function executiveDashboard(app: FastifyInstance) {
  const [byStage, revenue, ar, health, capacity, deadlines] = await Promise.all([
    // Open returns by stage + value (estimate top until a final fee exists).
    app.db.query(
      `SELECT te.stage::text, count(*)::int AS count,
              COALESCE(sum(COALESCE(te.final_fee_cents, te.estimated_fee_max_cents, 0)), 0)::bigint AS value_cents
       FROM tax_engagements te
       WHERE te.stage NOT IN ('completed', 'withdrawn')
       GROUP BY te.stage ORDER BY min(
         array_position(ARRAY['intake_started','scheduled','documents_requested','pending_client_response',
                              'in_preparation','internal_review','client_review','ready_to_file','filed','on_hold'],
                        te.stage::text))`
    ),
    app.db.query<{ mtd_cents: string; ytd_cents: string }>(
      `SELECT COALESCE(sum(amount_paid_cents) FILTER (WHERE paid_at >= date_trunc('month', now())), 0)::bigint AS mtd_cents,
              COALESCE(sum(amount_paid_cents) FILTER (WHERE paid_at >= date_trunc('year', now())), 0)::bigint AS ytd_cents
       FROM invoices WHERE status = 'paid'`
    ),
    app.db.query(
      `SELECT CASE
                WHEN now() - sent_at <= interval '30 days' THEN '0-30'
                WHEN now() - sent_at <= interval '60 days' THEN '31-60'
                WHEN now() - sent_at <= interval '90 days' THEN '61-90'
                ELSE '90+' END AS bucket,
              count(*)::int AS count,
              COALESCE(sum(total_cents - amount_paid_cents), 0)::bigint AS owed_cents
       FROM invoices WHERE status IN ('sent', 'overdue')
       GROUP BY 1 ORDER BY 1`
    ),
    app.db.query(
      `SELECT CASE
                WHEN health_score IS NULL THEN 'unscored'
                WHEN health_score < (SELECT (value)::text::int FROM app_settings WHERE key = 'health.red_below') THEN 'red'
                WHEN health_score >= (SELECT (value)::text::int FROM app_settings WHERE key = 'health.green_at_or_above') THEN 'green'
                ELSE 'yellow' END AS band,
              count(*)::int AS count
       FROM contacts WHERE soto_status = 'active' AND NOT is_archived
       GROUP BY 1`
    ),
    // Capacity proxy (Phase 4 builds real capacity planning): open work per staffer.
    app.db.query(
      `SELECT st.full_name, r.key AS role,
              (SELECT count(*)::int FROM tasks t WHERE t.assigned_staff_id = st.id AND t.status IN ('open','in_progress')) AS open_tasks,
              (SELECT count(*)::int FROM tax_engagements te WHERE te.preparer_id = st.id AND te.stage NOT IN ('completed','withdrawn')) AS open_returns
       FROM staff st JOIN roles r ON r.id = st.role_id
       WHERE st.is_active ORDER BY st.full_name`
    ),
    deadlineDashboard(app, todayChicago()),
  ]);

  return {
    openReturnsByStage: byStage.rows,
    revenue: { mtdCents: Number(revenue.rows[0]!.mtd_cents), ytdCents: Number(revenue.rows[0]!.ytd_cents) },
    mrr: { note: 'Stripe Billing subscriptions land in Phase 3', cents: 0 },
    arAging: ar.rows,
    healthDistribution: health.rows,
    staffCapacity: capacity.rows,
    deadlines: {
      atRiskCount: deadlines.atRiskCount,
      extendedCount: deadlines.extendedCount,
      next: deadlines.engagements.filter((e) => e.daysLeft !== null && e.daysLeft >= 0).slice(0, 5),
    },
  };
}

export async function hiloDashboard(app: FastifyInstance) {
  const proBonoRate = await app.db.query<{ amount_cents: number | null }>(
    `SELECT i.amount_cents
     FROM price_book_items i
     JOIN price_book_versions v ON v.id = i.version_id
     WHERE i.item_code = (SELECT value #>> '{}' FROM app_settings WHERE key = 'funder.pro_bono_rate_item_code')
     ORDER BY v.version_number DESC LIMIT 1`
  );
  const rateCents = proBonoRate.rows[0]?.amount_cents ?? 0;

  const [byStatus, sessions, referrals, summaries, funder] = await Promise.all([
    app.db.query(
      `SELECT hilo_status::text, count(*)::int AS count
       FROM contacts WHERE hilo_status <> 'none' AND NOT is_archived
       GROUP BY hilo_status ORDER BY count DESC`
    ),
    app.db.query<{ this_month: number }>(
      `SELECT count(*)::int AS this_month
       FROM meetings m JOIN contacts c ON c.id = m.contact_id
       WHERE c.hilo_status <> 'none' AND m.started_at >= date_trunc('month', now())`
    ),
    app.db.query(
      `SELECT direction::text, count(*)::int AS pending
       FROM referrals WHERE status = 'pending_approval' GROUP BY direction`
    ),
    app.db.query(
      `SELECT ms.summary, ms.tax_need, m.title, m.started_at, c.first_name, c.last_name
       FROM meeting_summaries ms
       JOIN meetings m ON m.id = ms.meeting_id
       LEFT JOIN contacts c ON c.id = m.contact_id
       WHERE ms.created_at >= now() - interval '7 days'
       ORDER BY ms.created_at DESC LIMIT 10`
    ),
    Promise.all([
      app.db.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM contacts WHERE hilo_status IN ('exploring','active','referral','alumni') AND NOT is_archived`
      ),
      app.db.query(
        `SELECT COALESCE(zip, 'unknown') AS zip, count(*)::int AS count
         FROM contacts WHERE hilo_status IN ('exploring','active','referral','alumni') AND NOT is_archived
         GROUP BY 1 ORDER BY count DESC LIMIT 10`
      ),
      app.db.query<{ hours: string }>(
        `SELECT COALESCE(sum(hours), 0)::text AS hours FROM time_entries WHERE is_pro_bono AND status <> 'discarded'`
      ),
    ]),
  ]);

  const proBonoHours = Number(funder[2].rows[0]!.hours);
  return {
    entrepreneursByStatus: byStatus.rows,
    sessionsThisMonth: sessions.rows[0]!.this_month,
    referralQueues: referrals.rows,
    recentSummaries: summaries.rows,
    milestones30d: { note: 'Milestone tracker ships with the Hilo portal (Phase 2)', items: [] },
    funderMetrics: {
      entrepreneursImpacted: funder[0].rows[0]!.n,
      byNeighborhood: funder[1].rows,
      proBonoHours,
      proBonoValueCents: Math.round(proBonoHours * rateCents),
      grantsDistributed: { note: 'Grant distribution module lands in Phase 3', count: 0, cents: 0 },
      workshopAttendance: { note: 'Eventbrite sync lands in Phase 3', count: 0 },
    },
  };
}
