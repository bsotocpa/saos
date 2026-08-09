// Recurring engagement configurator (v4.2 Service Delivery Model).
//
// This is the file CLAUDE.md points at when it says:
//   "S corp session floor: the engagement configurator must not allow an active
//    S corp client below 2 CPA sessions/year."
//
// The floor is enforced HERE, at write time, on every path that can lower the
// session dial — create, reconfigure, and the maintenance-mode downgrade. The
// utilization report shows existing violations; this prevents new ones. Both are
// needed, and they are not substitutes for each other.
//
// Deliberate non-decisions:
//   · S_CORP_SESSION_FLOOR is a CONSTANT, not an app_setting. Every tunable knob
//     in this system is admin-editable because Brian should not need a deploy to
//     change his own policy — but a floor that can be edited down to zero is not
//     a floor. CLAUDE.md calls it non-negotiable, so the code treats it that way.
//   · Nothing here invents a price. A cadence the price book cannot price is
//     REFUSED, not estimated.

import type { FastifyInstance } from 'fastify';
import { writeAudit } from '../../audit.ts';
import { AppError, type AuthedStaff } from '../../types.ts';

export type PrepCadence = 'weekly' | 'monthly' | 'quarterly' | 'semi_annual';
export type SessionCadence = 'weekly' | 'biweekly' | 'monthly' | 'quarterly' | 'semi_annual' | 'annual';
export type ScopeRung = 'registration_setup' | 'review_audit' | 'admin_training' | 'full_management';

/**
 * THE FLOOR. An active S election means owner-comp calibration and estimated
 * payments have to be touched at least twice a year; one annual session cannot
 * carry both. Not configurable — see the note above.
 */
export const S_CORP_SESSION_FLOOR = 2;

/** Occurrences per year per cadence. The one place cadence becomes a number. */
export const SESSIONS_PER_YEAR: Record<SessionCadence, number> = {
  weekly: 52,
  biweekly: 26,
  monthly: 12,
  quarterly: 4,
  semi_annual: 2,
  annual: 1,
};

export const PREP_PER_YEAR: Record<PrepCadence, number> = {
  weekly: 52,
  monthly: 12,
  quarterly: 4,
  semi_annual: 2,
};

/**
 * Price-book item that prices each prep cadence. Weekly is deliberately absent:
 * the spec offers it as a dial position but the price book has no weekly line,
 * and inventing one would be a hardcoded price. Configuring weekly prep is
 * refused with a message that names the missing item — a data gap for Brian to
 * close in Admin → Pricing, not a number for me to guess.
 */
export const PREP_ITEM: Partial<Record<PrepCadence, string>> = {
  monthly: 'ACCT_MONTHLY',
  quarterly: 'ACCT_QUARTERLY',
  semi_annual: 'ACCT_SEMI_ANNUAL',
};

/** Months covered by one prep charge — turns book units into a monthly figure. */
const PREP_MONTHS: Record<PrepCadence, number> = {
  weekly: 1 / 4.333,
  monthly: 1,
  quarterly: 3,
  semi_annual: 6,
};

export const SCOPE_ITEM: Partial<Record<ScopeRung, string>> = {
  registration_setup: 'SCOPE_REG_SETUP',
  review_audit: 'SCOPE_REVIEW_AUDIT',
  admin_training: 'SCOPE_ADMIN_TRAINING',
  // full_management is the prep-cadence price itself (the ACCT_* lines are
  // "full management"), so it adds no separate rung charge.
};

export interface SElectionEvidence {
  hasActiveSElection: boolean;
  /** Why we think so — shown in the refusal so it is arguable, not magic. */
  reasons: string[];
}

/**
 * Does this client have an active S election? Two independent signals, either
 * sufficient:
 *   · a business they belong to is typed s_corp
 *   · they have a tax engagement filing an 1120-S
 *
 * Using both is the safe direction for a compliance floor. A missed S corp costs
 * owner-comp calibration; a false positive costs one extra session a year.
 */
export async function sElectionEvidence(
  app: FastifyInstance,
  contactId: string
): Promise<SElectionEvidence> {
  const { rows } = await app.db.query<{ scorp_businesses: string | null; scorp_returns: number }>(
    `SELECT
       (SELECT string_agg(DISTINCT b.name, ', ')
        FROM business_members bm JOIN businesses b ON b.id = bm.business_id
        WHERE bm.contact_id = $1 AND b.entity_type = 's_corp') AS scorp_businesses,
       (SELECT count(*)::int
        FROM tax_engagements te JOIN engagements e ON e.id = te.engagement_id
        WHERE e.contact_id = $1 AND te.return_type = '1120s') AS scorp_returns`,
    [contactId]
  );
  const r = rows[0]!;
  const reasons: string[] = [];
  if (r.scorp_businesses) reasons.push(`S corp entity on file: ${r.scorp_businesses}`);
  if (r.scorp_returns > 0) reasons.push(`${r.scorp_returns} Form 1120-S engagement(s) on record`);
  return { hasActiveSElection: reasons.length > 0, reasons };
}

export interface ConfigureInput {
  prepCadence: PrepCadence;
  sessionCadence: SessionCadence;
  scopeRung?: ScopeRung | undefined;
  maintenanceMode?: boolean | undefined;
  note?: string | null | undefined;
}

export interface ConfiguredEngagement {
  engagementId: string;
  prepCadence: PrepCadence;
  sessionCadence: SessionCadence;
  sessionsPerYear: number;
  scopeRung: ScopeRung | null;
  maintenanceMode: boolean;
  sCorpFloorApplied: boolean;
  monthlyEquivalentCents: number;
  lines: Array<{ itemCode: string; label: string; amountCents: number | null; note: string }>;
}

async function currentVersionId(app: FastifyInstance): Promise<string> {
  const { rows } = await app.db.query<{ id: string }>(
    `SELECT id FROM price_book_versions
     WHERE effective_from <= CURRENT_DATE AND (effective_to IS NULL OR effective_to > CURRENT_DATE)
     ORDER BY version_number DESC LIMIT 1`
  );
  if (!rows[0]) throw new AppError(500, 'price_book_missing', 'No price book version in force.');
  return rows[0].id;
}

/**
 * Configure (or reconfigure) a recurring engagement. Throws rather than
 * clamping: silently raising a client's session count to satisfy the floor would
 * change what they are billed without anyone deciding to.
 */
export async function configureRecurringEngagement(
  app: FastifyInstance,
  engagementId: string,
  input: ConfigureInput,
  actor: AuthedStaff
): Promise<ConfiguredEngagement> {
  const eng = await app.db.query<{ contact_id: string; service_line: string; status: string }>(
    `SELECT contact_id, service_line::text, status::text FROM engagements WHERE id = $1`,
    [engagementId]
  );
  const e = eng.rows[0];
  if (!e) throw new AppError(404, 'not_found', 'Engagement not found.');
  if (e.service_line === 'tax') {
    throw new AppError(
      400,
      'not_recurring',
      'Tax engagements are per-return, not recurring — they have no cadence dials.'
    );
  }

  const sessionsPerYear = SESSIONS_PER_YEAR[input.sessionCadence];
  const prepPerYear = PREP_PER_YEAR[input.prepCadence];

  // Spec rule: the session dial can never be MORE frequent than the prep dial —
  // there is nothing to discuss in a session whose books have not closed.
  if (sessionsPerYear > prepPerYear) {
    throw new AppError(
      400,
      'session_exceeds_prep',
      `Session cadence (${input.sessionCadence}, ${sessionsPerYear}/year) cannot be more frequent than ` +
        `prep cadence (${input.prepCadence}, ${prepPerYear}/year). Raise the prep cadence or lower the sessions.`
    );
  }

  // ── THE HARD RULE ──────────────────────────────────────────────────────────
  const evidence = await sElectionEvidence(app, e.contact_id);
  let sCorpFloorApplied = false;
  if (evidence.hasActiveSElection) {
    sCorpFloorApplied = true;
    if (sessionsPerYear < S_CORP_SESSION_FLOOR) {
      throw new AppError(
        409,
        's_corp_session_floor',
        `This client has an active S election, so the engagement cannot be configured below ` +
          `${S_CORP_SESSION_FLOOR} CPA sessions a year — owner compensation and estimated payments both ` +
          `need touching. ${input.sessionCadence} is ${sessionsPerYear}/year. ` +
          `Use semi-annual sessions or more frequent. (${evidence.reasons.join('; ')})`
      );
    }
  }

  // Price composition — every figure from the price book, or a refusal.
  const versionId = await currentVersionId(app);
  const prepItem = PREP_ITEM[input.prepCadence];
  if (!prepItem) {
    throw new AppError(
      400,
      'cadence_not_priced',
      `The price book in force has no line for ${input.prepCadence} prep cadence, so this configuration ` +
        `cannot be priced. Add the item in Admin → Pricing first — I will not estimate a price.`
    );
  }
  const codes = [prepItem, ...(input.scopeRung && SCOPE_ITEM[input.scopeRung] ? [SCOPE_ITEM[input.scopeRung]!] : [])];
  const priced = await app.db.query<{
    item_code: string; name_en: string; amount_cents: number | null; unit: string | null; needs_confirmation: boolean;
  }>(
    `SELECT item_code, name_en, amount_cents, unit, needs_confirmation
     FROM price_book_items WHERE version_id = $1 AND item_code = ANY($2) AND is_active`,
    [versionId, codes]
  );
  const byCode = new Map(priced.rows.map((r) => [r.item_code, r]));
  const missing = codes.filter((c) => !byCode.has(c));
  if (missing.length > 0) {
    throw new AppError(
      400,
      'cadence_not_priced',
      `Missing from the price book in force: ${missing.join(', ')}.`
    );
  }

  const prep = byCode.get(prepItem)!;
  const prepMonthly = prep.amount_cents === null ? 0 : Math.round(prep.amount_cents / PREP_MONTHS[input.prepCadence]);

  const lines: ConfiguredEngagement['lines'] = [
    {
      itemCode: prep.item_code,
      label: prep.name_en,
      amountCents: prep.amount_cents,
      note: `Prep cadence — ${input.prepCadence}${prep.needs_confirmation ? ' (⚠ price awaiting confirmation)' : ''}`,
    },
  ];
  // The session dial carries no separate price in the book today: the ACCT_*
  // lines are described as full management. Said out loud rather than implied by
  // a zero, so nobody reads a missing charge as a free session.
  lines.push({
    itemCode: '—',
    label: `CPA sessions — ${input.sessionCadence} (${sessionsPerYear}/year)`,
    amountCents: null,
    note:
      'Included in the prep-cadence price. The price book has no separate session-cadence line; ' +
      'if sessions should price independently, add the item in Admin → Pricing.',
  });
  if (input.scopeRung && SCOPE_ITEM[input.scopeRung]) {
    const rung = byCode.get(SCOPE_ITEM[input.scopeRung]!)!;
    lines.push({
      itemCode: rung.item_code,
      label: rung.name_en,
      amountCents: rung.amount_cents,
      note: `Scope rung — ${input.scopeRung}${rung.needs_confirmation ? ' (⚠ price awaiting confirmation)' : ''}`,
    });
  } else if (input.scopeRung === 'full_management') {
    lines.push({
      itemCode: '—',
      label: 'Full management & compliance',
      amountCents: null,
      note: 'Priced by the prep-cadence line, which is the full-management rate.',
    });
  }

  await app.db.query(
    `UPDATE engagements
     SET prep_cadence = $2::prep_cadence,
         session_cadence = $3::session_cadence,
         sessions_per_year = $4,
         scope_rung = $5::scope_rung,
         maintenance_mode = $6,
         maintenance_mode_at = CASE WHEN $6 THEN now() ELSE NULL END,
         s_corp_floor_applied = $7,
         configured_at = now(),
         configured_by_staff_id = $8,
         price_book_version_id = COALESCE(price_book_version_id, $9)
     WHERE id = $1`,
    [
      engagementId, input.prepCadence, input.sessionCadence, sessionsPerYear,
      input.scopeRung ?? null, input.maintenanceMode ?? false, sCorpFloorApplied, actor.id, versionId,
    ]
  );
  await app.db.query(
    `INSERT INTO engagement_config_history
       (engagement_id, prep_cadence, session_cadence, sessions_per_year, scope_rung, maintenance_mode,
        s_corp_floor_applied, monthly_equivalent_cents, price_book_version_id, changed_by_staff_id, note)
     VALUES ($1,$2::prep_cadence,$3::session_cadence,$4,$5::scope_rung,$6,$7,$8,$9,$10,$11)`,
    [
      engagementId, input.prepCadence, input.sessionCadence, sessionsPerYear, input.scopeRung ?? null,
      input.maintenanceMode ?? false, sCorpFloorApplied, prepMonthly, versionId, actor.id, input.note ?? null,
    ]
  );
  await writeAudit(app.db, {
    actorType: 'staff', actorId: actor.id, actorLabel: actor.email,
    action: 'engagement.configured', objectType: 'engagement', objectId: engagementId,
    contactId: e.contact_id,
    details: {
      prep_cadence: input.prepCadence,
      session_cadence: input.sessionCadence,
      sessions_per_year: sessionsPerYear,
      scope_rung: input.scopeRung ?? null,
      maintenance_mode: input.maintenanceMode ?? false,
      s_corp_floor_applied: sCorpFloorApplied,
    },
  });

  return {
    engagementId,
    prepCadence: input.prepCadence,
    sessionCadence: input.sessionCadence,
    sessionsPerYear,
    scopeRung: input.scopeRung ?? null,
    maintenanceMode: input.maintenanceMode ?? false,
    sCorpFloorApplied,
    monthlyEquivalentCents: prepMonthly,
    lines,
  };
}

/**
 * Maintenance mode: keep the prep cadence, reduce the session cadence. This is
 * the path most likely to walk an S corp under the floor, so it runs through the
 * SAME gate rather than around it.
 */
export async function enterMaintenanceMode(
  app: FastifyInstance,
  engagementId: string,
  sessionCadence: SessionCadence,
  actor: AuthedStaff,
  note?: string
): Promise<ConfiguredEngagement> {
  const { rows } = await app.db.query<{ prep_cadence: PrepCadence | null; scope_rung: ScopeRung | null; sessions_per_year: number | null }>(
    `SELECT prep_cadence, scope_rung, sessions_per_year FROM engagements WHERE id = $1`,
    [engagementId]
  );
  const current = rows[0];
  if (!current) throw new AppError(404, 'not_found', 'Engagement not found.');
  if (!current.prep_cadence) {
    throw new AppError(
      400,
      'not_configured',
      'Configure the engagement before moving it to maintenance mode.'
    );
  }
  if (current.sessions_per_year !== null && SESSIONS_PER_YEAR[sessionCadence] > current.sessions_per_year) {
    throw new AppError(
      400,
      'not_a_reduction',
      'Maintenance mode reduces session frequency. Use the configurator to increase it.'
    );
  }
  return configureRecurringEngagement(
    app,
    engagementId,
    {
      prepCadence: current.prep_cadence,
      sessionCadence,
      ...(current.scope_rung ? { scopeRung: current.scope_rung } : {}),
      maintenanceMode: true,
      note: note ?? 'Moved to maintenance mode (prep cadence held, sessions reduced).',
    },
    actor
  );
}

/**
 * Preview what the configurator would allow for a client, so the UI can disable
 * the impossible options instead of letting staff hit an error. Read-only.
 */
export async function configuratorOptions(
  app: FastifyInstance,
  contactId: string
): Promise<{
  sElection: SElectionEvidence;
  sessionFloor: number;
  prepCadences: Array<{ value: PrepCadence; perYear: number; priced: boolean; itemCode: string | null }>;
  sessionCadences: Array<{ value: SessionCadence; perYear: number; allowed: boolean; reason: string | null }>;
}> {
  const sElection = await sElectionEvidence(app, contactId);
  const prepCadences = (Object.keys(PREP_PER_YEAR) as PrepCadence[]).map((value) => ({
    value,
    perYear: PREP_PER_YEAR[value],
    priced: Boolean(PREP_ITEM[value]),
    itemCode: PREP_ITEM[value] ?? null,
  }));
  const sessionCadences = (Object.keys(SESSIONS_PER_YEAR) as SessionCadence[]).map((value) => {
    const perYear = SESSIONS_PER_YEAR[value];
    const blocked = sElection.hasActiveSElection && perYear < S_CORP_SESSION_FLOOR;
    return {
      value,
      perYear,
      allowed: !blocked,
      reason: blocked
        ? `Below the ${S_CORP_SESSION_FLOOR}-session floor for an active S election.`
        : null,
    };
  });
  return { sElection, sessionFloor: S_CORP_SESSION_FLOOR, prepCadences, sessionCadences };
}
