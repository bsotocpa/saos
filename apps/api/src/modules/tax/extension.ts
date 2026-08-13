// Extension workflow (MP Tax Ops — 30–40% of clients file extensions).
//
// Daily jobs are idempotent per calendar date: each records its run in the
// audit log and refuses to re-fire the same day (safe across restarts).
// Every job takes `today` (YYYY-MM-DD) explicitly — clock-injected for tests,
// todayChicago() in production.

import type { FastifyInstance } from 'fastify';
import { writeAudit } from '../../audit.ts';
import { AppError } from '../../types.ts';
import { sendTemplatedEmail } from '../templates/service.ts';
import { isAutomationEnabled } from '../../automations.ts';
import { ownerForRole } from '../../staffing.ts';
import { createTask } from '../tasks/service.ts';
import {
  AUTOMATIC_EXTENSION_TYPES,
  addDays,
  daysBetween,
  extendedDeadline,
  nextAg990Deadline,
  originalDeadline,
  upcomingEstimateDates,
  type DeadlineReturnType,
} from './deadlines.ts';

/** Stages "not yet at Internal Review" (MP: decision-list population). */
const PRE_INTERNAL_REVIEW = [
  'intake_started', 'scheduled', 'documents_requested', 'pending_client_response', 'in_preparation', 'on_hold',
];

const CHASE_TEMPLATES = ['extension_chase_june', 'extension_chase_july', 'extension_chase_august'] as const;

async function jobAlreadyRan(app: FastifyInstance, action: string, runDate: string): Promise<boolean> {
  const { rows } = await app.db.query(
    `SELECT 1 FROM audit_log WHERE action = $1 AND details->>'run_date' = $2 LIMIT 1`,
    [action, runDate]
  );
  return rows.length > 0;
}

/** Shared setting reader — the preparer queue reuses it so "at risk" cannot mean two things. */
export async function getSetting<T>(app: FastifyInstance, key: string, fallback: T): Promise<T> {
  const { rows } = await app.db.query<{ value: T }>(`SELECT value FROM app_settings WHERE key = $1`, [key]);
  return rows[0]?.value ?? fallback;
}

/** Stamp original_deadline on any engagement missing it (uses business FYE; individuals = calendar year). */
export async function stampOriginalDeadlines(app: FastifyInstance): Promise<number> {
  const { rows } = await app.db.query<{
    id: string;
    tax_year: number;
    return_type: DeadlineReturnType;
    fiscal_year_end_month: number | null;
  }>(
    `SELECT te.id, te.tax_year, te.return_type, b.fiscal_year_end_month
     FROM tax_engagements te
     JOIN engagements e ON e.id = te.engagement_id
     LEFT JOIN businesses b ON b.id = e.business_id
     WHERE te.original_deadline IS NULL AND te.stage NOT IN ('completed', 'withdrawn')`
  );
  let stamped = 0;
  for (const r of rows) {
    const deadline = originalDeadline(r.return_type, r.tax_year, r.fiscal_year_end_month ?? 12);
    if (deadline) {
      await app.db.query(`UPDATE tax_engagements SET original_deadline = $2 WHERE id = $1`, [r.id, deadline]);
      stamped++;
    }
  }
  return stamped;
}

/**
 * Automation 10: at T-minus N days (default 21) before each filing deadline,
 * announce the Extension Decision List to Brian + the tax preparers.
 */
export async function runExtensionDecisionListJob(
  app: FastifyInstance,
  today: string
): Promise<{ skipped: boolean; lists: Array<{ deadline: string; count: number }> }> {
  const ACTION = 'job.extension_decision_list';
  if (await jobAlreadyRan(app, ACTION, today)) return { skipped: true, lists: [] };

  await stampOriginalDeadlines(app);
  const tMinus = await getSetting<number>(app, 'extension.decision_list_days_before', 21);
  const targetDeadline = addDays(today, tMinus);

  // Types whose extension is AUTOMATIC (FBAR) never need an extend/push
  // decision — they stay off the list (v4.3 table).
  const { rows } = await app.db.query<{ deadline: string; count: number }>(
    `SELECT te.original_deadline::text AS deadline, count(*)::int AS count
     FROM tax_engagements te
     WHERE te.original_deadline = $1
       AND te.stage = ANY($2::tax_stage[])
       AND NOT te.extension_filed
       AND te.return_type <> ALL($3::return_type[])
     GROUP BY te.original_deadline`,
    [targetDeadline, PRE_INTERNAL_REVIEW, AUTOMATIC_EXTENSION_TYPES]
  );

  for (const list of rows) {
    // M25: the review itself is Brian's work item (owner rollup); the
    // notifications below remain the alert channel.
    const ceo = await ownerForRole(app.db, 'ceo');
    if (ceo) {
      await createTask(app, {
        title: `Review Extension Decision List — deadline ${list.deadline} (${list.count} engagement(s))`,
        description: 'Mark each engagement: Extend or Push to finish. The auto-extension batch (Mar 25 / Apr 1 cutoffs) files only after this review.',
        assignedStaffId: ceo,
        dueDate: list.deadline,
        priority: 2,
        source: 'automation',
        sourceType: 'extension_batch_review',
        sourceId: list.deadline,
      });
    }
    const staff = await app.db.query<{ id: string }>(
      `SELECT st.id FROM staff st JOIN roles r ON r.id = st.role_id
       WHERE st.is_active AND r.key IN ('ceo', 'tax_preparer')`
    );
    for (const s of staff.rows) {
      await app.db.query(
        `INSERT INTO notifications (staff_id, type, severity, title, body)
         VALUES ($1, 'extension_decision_list', 'warning', $2, $3)`,
        [
          s.id,
          `Extension Decision List ready — deadline ${list.deadline}`,
          `${list.count} engagement(s) not yet at Internal Review. Mark each: Extend or Push to finish.`,
        ]
      );
    }
  }

  await writeAudit(app.db, {
    actorType: 'system',
    action: ACTION,
    details: { run_date: today, lists: rows },
  });
  return { skipped: false, lists: rows };
}

/** The queryable decision list (sorted by preparer, MP step 1). */
export async function extensionDecisionList(app: FastifyInstance, deadline: string) {
  const { rows } = await app.db.query(
    `SELECT te.id, te.tax_year, te.return_type, te.stage, te.extension_recommended,
            te.original_deadline::text AS original_deadline,
            te.preparer_id, sp.full_name AS preparer_name,
            c.id AS contact_id, c.first_name, c.last_name
     FROM tax_engagements te
     JOIN engagements e ON e.id = te.engagement_id
     JOIN contacts c ON c.id = e.contact_id
     LEFT JOIN staff sp ON sp.id = te.preparer_id
     WHERE te.original_deadline = $1
       AND te.stage = ANY($2::tax_stage[])
       AND NOT te.extension_filed
     ORDER BY sp.full_name NULLS LAST, c.last_name`,
    [deadline, PRE_INTERNAL_REVIEW]
  );
  return rows;
}

/** MP step 2: marked "Extend" → bilingual client notice (file ≠ pay). */
export async function markExtensionDecision(
  app: FastifyInstance,
  actor: { staffId: string; label: string },
  taxEngagementId: string,
  recommend: boolean
): Promise<void> {
  const te = await loadForExtension(app, taxEngagementId);
  await app.db.query(`UPDATE tax_engagements SET extension_recommended = $2 WHERE id = $1`, [
    taxEngagementId,
    recommend,
  ]);

  // Client-acting: gated by the extension_notices kill switch.
  if (recommend && te.email && (await isAutomationEnabled(app, 'extension_notices'))) {
    const ext = extendedDeadline(te.return_type, te.tax_year, te.fiscal_year_end_month ?? 12);
    await sendTemplatedEmail(app, {
      to: te.email,
      templateKey: 'extension_notice',
      language: te.language,
      contactId: te.contact_id,
      vars: {
        first_name: te.first_name,
        tax_year: String(te.tax_year),
        extended_deadline: ext ?? '',
      },
    });
  }
  await writeAudit(app.db, {
    actorType: 'staff',
    actorId: actor.staffId,
    actorLabel: actor.label,
    action: recommend ? 'tax_engagement.extension_recommended' : 'tax_engagement.extension_push_to_finish',
    objectType: 'tax_engagement',
    objectId: taxEngagementId,
    contactId: te.contact_id,
  });
}

/** MP step 3: payment estimate entered → client notified with instructions. */
export async function setExtensionPaymentEstimate(
  app: FastifyInstance,
  actor: { staffId: string; label: string },
  taxEngagementId: string,
  amountCents: number
): Promise<void> {
  const te = await loadForExtension(app, taxEngagementId);
  await app.db.query(`UPDATE tax_engagements SET extension_payment_estimate_cents = $2 WHERE id = $1`, [
    taxEngagementId,
    amountCents,
  ]);
  if (te.email && (await isAutomationEnabled(app, 'extension_notices'))) {
    await sendTemplatedEmail(app, {
      to: te.email,
      templateKey: 'extension_payment_reminder',
      language: te.language,
      contactId: te.contact_id,
      vars: {
        first_name: te.first_name,
        tax_year: String(te.tax_year),
        amount: formatUsd(amountCents),
        original_deadline: te.original_deadline ?? '',
      },
    });
  }
  await writeAudit(app.db, {
    actorType: 'staff',
    actorId: actor.staffId,
    actorLabel: actor.label,
    action: 'tax_engagement.extension_payment_estimated',
    objectType: 'tax_engagement',
    objectId: taxEngagementId,
    contactId: te.contact_id,
  });
}

/** MP step 4: extension filed in ATX → Extended tag + DERIVED deadline swap. */
export async function markExtensionFiled(
  app: FastifyInstance,
  actor: { staffId: string; label: string },
  taxEngagementId: string,
  today: string
): Promise<{ extendedDeadline: string | null }> {
  const te = await loadForExtension(app, taxEngagementId);
  const ext = extendedDeadline(te.return_type, te.tax_year, te.fiscal_year_end_month ?? 12);
  await app.db.query(
    `UPDATE tax_engagements
     SET extension_filed = true,
         extension_filed_date = $2,
         extended_deadline = $3,
         original_deadline = COALESCE(original_deadline, $4)
     WHERE id = $1`,
    [
      taxEngagementId,
      today,
      ext,
      originalDeadline(te.return_type, te.tax_year, te.fiscal_year_end_month ?? 12),
    ]
  );
  await writeAudit(app.db, {
    actorType: 'staff',
    actorId: actor.staffId,
    actorLabel: actor.label,
    action: 'tax_engagement.extension_filed',
    objectType: 'tax_engagement',
    objectId: taxEngagementId,
    contactId: te.contact_id,
    details: { extended_deadline: ext },
  });
  return { extendedDeadline: ext };
}

/**
 * MP step 5: summer chase (Jun 1 / Jul 15 / Aug 15, escalating copy) for
 * extended clients whose documents haven't arrived. On/after the at-risk date
 * (docs not in by Aug 15) the preparer is alerted too.
 */
export async function runSummerChaseJob(
  app: FastifyInstance,
  today: string
): Promise<{ skipped: boolean; chased: number; atRiskAlerts: number; suppressed?: number }> {
  const ACTION = 'job.extension_summer_chase';
  if (await jobAlreadyRan(app, ACTION, today)) return { skipped: true, chased: 0, atRiskAlerts: 0 };

  const dates = await getSetting<string[]>(app, 'extension.summer_chase_dates', ['06-01', '07-15', '08-15']);
  const monthDay = today.slice(5);
  const chaseIndex = dates.indexOf(monthDay);
  if (chaseIndex === -1) return { skipped: true, chased: 0, atRiskAlerts: 0 };

  const atRiskDate = await getSetting<string>(app, 'extension.at_risk_no_docs_by', '08-15');
  const isAtRiskDate = monthDay >= atRiskDate;

  const { rows } = await app.db.query<{
    id: string;
    contact_id: string;
    first_name: string;
    last_name: string;
    email: string | null;
    language: 'en' | 'es';
    extended_deadline: string | null;
    preparer_id: string | null;
  }>(
    `SELECT te.id, c.id AS contact_id, c.first_name, c.last_name, c.email, c.language,
            te.extended_deadline::text AS extended_deadline, te.preparer_id
     FROM tax_engagements te
     JOIN engagements e ON e.id = te.engagement_id
     JOIN contacts c ON c.id = e.contact_id
     WHERE te.extension_filed
       AND te.docs_received_at IS NULL
       AND te.stage = ANY($1::tax_stage[])`,
    [PRE_INTERNAL_REVIEW]
  );

  let chased = 0;
  let atRiskAlerts = 0;
  let suppressed = 0;
  // Kill switch covers the client chase; at-risk preparer alerts still fire.
  const noticesArmed = await isAutomationEnabled(app, 'extension_notices');
  const templateKey = CHASE_TEMPLATES[chaseIndex] ?? CHASE_TEMPLATES[CHASE_TEMPLATES.length - 1]!;

  for (const r of rows) {
    if (r.email && !noticesArmed) suppressed++;
    if (r.email && noticesArmed) {
      await sendTemplatedEmail(app, {
        to: r.email,
        templateKey,
        language: r.language,
        contactId: r.contact_id,
        vars: {
          first_name: r.first_name,
          extended_deadline: r.extended_deadline ?? '',
          portal_link: app.config.PORTAL_BASE_URL,
        },
      });
      chased++;
    }
    if (isAtRiskDate && r.preparer_id) {
      await app.db.query(
        `INSERT INTO notifications (staff_id, type, severity, title, contact_id)
         VALUES ($1, 'extension_at_risk', 'critical', $2, $3)`,
        [r.preparer_id, `Extension AT RISK: ${r.first_name} ${r.last_name} — no documents received`, r.contact_id]
      );
      atRiskAlerts++;
    }
  }

  await writeAudit(app.db, {
    actorType: 'system',
    action: ACTION,
    details: { run_date: today, chase_index: chaseIndex, chased, at_risk_alerts: atRiskAlerts, suppressed, automation_disabled: !noticesArmed },
  });
  return { skipped: false, chased, atRiskAlerts, suppressed };
}

/** Deadline dashboard data (countdowns + at-risk, MP step 6). */
export async function deadlineDashboard(app: FastifyInstance, today: string) {
  const atRiskMonthDay = await getSetting<string>(app, 'extension.at_risk_no_docs_by', '08-15');
  const { rows } = await app.db.query<{
    id: string;
    first_name: string;
    last_name: string;
    tax_year: number;
    return_type: string;
    stage: string;
    extension_filed: boolean;
    docs_received_at: Date | null;
    effective_deadline: string | null;
  }>(
    `SELECT te.id, c.first_name, c.last_name, te.tax_year, te.return_type, te.stage,
            te.extension_filed, te.docs_received_at,
            COALESCE(te.extended_deadline, te.original_deadline)::text AS effective_deadline
     FROM tax_engagements te
     JOIN engagements e ON e.id = te.engagement_id
     JOIN contacts c ON c.id = e.contact_id
     WHERE te.stage NOT IN ('completed', 'withdrawn', 'filed')
     ORDER BY COALESCE(te.extended_deadline, te.original_deadline) NULLS LAST`
  );

  const engagements = rows.map((r) => {
    const daysLeft = r.effective_deadline ? daysBetween(today, r.effective_deadline) : null;
    const atRisk =
      r.extension_filed && r.docs_received_at === null && today.slice(5) >= atRiskMonthDay;
    return {
      id: r.id,
      client: `${r.first_name} ${r.last_name}`,
      taxYear: r.tax_year,
      returnType: r.return_type,
      stage: r.stage,
      deadline: r.effective_deadline,
      daysLeft,
      extended: r.extension_filed,
      atRisk,
    };
  });

  const byDeadline: Record<string, { total: number; atRisk: number }> = {};
  for (const e of engagements) {
    if (!e.deadline) continue;
    byDeadline[e.deadline] ??= { total: 0, atRisk: 0 };
    byDeadline[e.deadline]!.total++;
    if (e.atRisk) byDeadline[e.deadline]!.atRisk++;
  }
  // v4.5: AG990-IL tracks SEPARATELY for every IL-registered charity —
  // derived per client from FYE, on its own clock (a federally-extended 990
  // does not move it). Nonprofit cluster = IL businesses typed nonprofit.
  const charities = await app.db.query<{
    business_id: string; name: string; fiscal_year_end_month: number;
    first_name: string | null; last_name: string | null;
  }>(
    `SELECT DISTINCT ON (b.id) b.id AS business_id, b.name, b.fiscal_year_end_month,
            c.first_name, c.last_name
     FROM businesses b
     LEFT JOIN business_members m ON m.business_id = b.id
     LEFT JOIN contacts c ON c.id = m.contact_id
     WHERE b.entity_type = 'nonprofit' AND b.state = 'IL'
     ORDER BY b.id, c.last_name NULLS LAST`
  );
  const ag990 = charities.rows
    .map((r) => {
      const next = nextAg990Deadline(today, r.fiscal_year_end_month);
      return {
        businessId: r.business_id,
        business: r.name,
        client: r.first_name ? `${r.first_name} ${r.last_name}` : null,
        fiscalYear: next.fiscalYear,
        deadline: next.date,
        daysLeft: daysBetween(today, next.date),
      };
    })
    .sort((a, b) => a.deadline.localeCompare(b.deadline));

  return {
    today,
    engagements,
    byDeadline,
    atRiskCount: engagements.filter((e) => e.atRisk).length,
    extendedCount: engagements.filter((e) => e.extended).length,
    // v4.3: the staff board ALWAYS shows estimated-payment dates (the
    // client-side toggle only affects the portal + reminder emails).
    estimates: upcomingEstimateDates(today),
    ag990,
  };
}

/**
 * v4.3: quarterly estimated-payment reminders — T-7 before each estimate
 * date, to portal-active clients whose estimate toggle is ON (default).
 * The staff deadline board shows the dates regardless of any toggle.
 */
export async function runEstimateReminderJob(
  app: FastifyInstance,
  today: string
): Promise<{ skipped: boolean; sent: number; suppressed?: number }> {
  const ACTION = 'job.estimate_reminder';
  if (await jobAlreadyRan(app, ACTION, today)) return { skipped: true, sent: 0 };

  const next = upcomingEstimateDates(today, 1)[0];
  let sent = 0;
  let suppressed = 0;
  // Firm-wide kill switch sits ON TOP of each client's own toggle.
  const remindersArmed = await isAutomationEnabled(app, 'estimate_reminders');
  if (next && daysBetween(today, next.date) === 7) {
    const { rows } = await app.db.query<{
      id: string; first_name: string; email: string; language: 'en' | 'es';
    }>(
      `SELECT DISTINCT c.id, c.first_name, c.email, c.language
       FROM contacts c
       JOIN portal_users u ON u.contact_id = c.id AND u.is_active
       WHERE c.estimate_reminders_enabled
         AND c.email IS NOT NULL
         AND NOT c.is_archived`
    );
    for (const c of rows) {
      if (!remindersArmed) { suppressed++; continue; }
      await sendTemplatedEmail(app, {
        to: c.email,
        templateKey: 'estimated_payment_reminder',
        language: c.language,
        contactId: c.id,
        vars: { first_name: c.first_name, quarter: next.quarter, due_date: next.date },
      });
      sent++;
    }
  }

  await writeAudit(app.db, {
    actorType: 'system', actorLabel: 'daily-jobs',
    action: ACTION,
    details: { run_date: today, estimate_date: next?.date ?? null, sent, suppressed, automation_disabled: !remindersArmed },
  });
  return { skipped: false, sent, suppressed };
}

// ── helpers ─────────────────────────────────────────────────────────────────

function formatUsd(cents: number): string {
  return `$${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

interface ExtensionRow {
  id: string;
  tax_year: number;
  return_type: DeadlineReturnType;
  original_deadline: string | null;
  contact_id: string;
  first_name: string;
  email: string | null;
  language: 'en' | 'es';
  fiscal_year_end_month: number | null;
}

async function loadForExtension(app: FastifyInstance, taxEngagementId: string): Promise<ExtensionRow> {
  const { rows } = await app.db.query<ExtensionRow>(
    `SELECT te.id, te.tax_year, te.return_type, te.original_deadline::text AS original_deadline,
            c.id AS contact_id, c.first_name, c.email, c.language, b.fiscal_year_end_month
     FROM tax_engagements te
     JOIN engagements e ON e.id = te.engagement_id
     JOIN contacts c ON c.id = e.contact_id
     LEFT JOIN businesses b ON b.id = e.business_id
     WHERE te.id = $1`,
    [taxEngagementId]
  );
  if (!rows[0]) throw new AppError(404, 'not_found', 'Tax engagement not found.');
  return rows[0];
}
