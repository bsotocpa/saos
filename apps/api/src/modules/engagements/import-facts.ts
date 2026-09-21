/*
 * IMPORTING A SALES-TAX OR PAYROLL SERVICE FACT (Brian, 2026-09-20, ruling R33).
 *
 * ── THE CONTRADICTION THIS RESOLVES ──
 *
 * Migrations 0106 and 0107 gave SAOS a home for two facts the Trello bundle carries:
 *
 *   engagements.filing_frequency   monthly | quarterly | annual | quarterly_or_annual
 *                                  CHECK: only on a service_line = 'sales_tax' engagement
 *   engagements.payroll_provider   free text, CHECK: only on a service_line = 'payroll' engagement
 *
 * and the first 04b rehearsal still deferred every sales_tax and payroll row as "no home in SAOS
 * yet". Both statements were true at once, and the gap between them is the ENGAGEMENT: the column
 * exists, but it exists on a row the import never made. The 04b loop's HAS_A_HOME set listed the
 * four types whose home is a table the import already writes (businesses, business_access_facts,
 * entity_compliance), and a fact whose home is a column on an engagement that does not exist had,
 * literally, nowhere to land. The migrations built the shelf; nothing built the box that goes on it.
 *
 * ── WHAT THIS DOES ──
 *
 * For one 04b row: find the client's live sales_tax (or payroll) engagement, or create one, then
 * write the column, then write the ledger row. Every step is the same door the rest of SAOS uses:
 *
 *   · the engagement goes through createEngagement (the independence check, the price-book version,
 *     the lifecycle move, the audit row, and the added-schedule notice — which the import context
 *     refuses and counts, as it does every client-facing effect);
 *   · one active engagement per contact, line, period and entity is the database's rule (0083 /
 *     0098), so "find, else create" cannot make a second one even if two rows race;
 *   · the ledger service_fact_imports (0114) is consulted first and written last, keyed
 *     (source, trello_source_id, fact_type). The second pass finds the row and does nothing.
 *
 * ── WHAT IT REFUSES TO GUESS ──
 *
 *   · A CLOSED service creates nothing. The Trello flag (closed_or_not_client / closed_or_none) is
 *     the card saying "this is not a live service", and an active engagement for it would be a
 *     claim the card contradicts. The row is still applied — ledger row, rows_written 0 — because
 *     it was read and understood, and the second pass must find it.
 *   · A value already on the engagement is never overwritten. A frequency or provider a person set
 *     in SAOS outranks a card typed by hand; the column is written only where it is NULL.
 *   · A frequency outside the CHECK's set is refused, not coerced: the state assigns four
 *     frequencies and 0106's fourth member exists precisely so ambiguity survives as ambiguity.
 *
 * The bundle date, not today, is the fact's as-of date. Trello's payroll board was last touched in
 * 2025 and the sales-tax board in 2026; the ledger carries the row's own as_of so a reader can tell.
 */
import type { FastifyInstance } from 'fastify';
import { AppError } from '../../types.ts';
import type { AuthedStaff } from '../../types.ts';
import { writeAudit } from '../../audit.ts';
import { createEngagement } from './service.ts';

export type RecurringFactType = 'sales_tax' | 'payroll';

/** 0106's CHECK, spelled here so a refusal names the set rather than surfacing as a constraint error. */
const FILING_FREQUENCIES = new Set(['monthly', 'quarterly', 'annual', 'quarterly_or_annual']);

/** The bundle writes "quarterly-or-annual"; the column holds quarterly_or_annual. Nothing else is folded. */
export function normalizeFilingFrequency(raw: unknown): string | null {
  const s = String(raw ?? '').trim().toLowerCase().replace(/[\s-]+/g, '_');
  return FILING_FREQUENCIES.has(s) ? s : null;
}

/**
 * Is this fact a LIVE service? The Trello flag says so. Used by the importer to decide whether a
 * business that is not in SAOS is worth creating for this row: a closed service is a fact about a
 * business we do not have, and not a reason to have it.
 */
export function isLiveServiceFact(factType: RecurringFactType, values: Record<string, unknown>): boolean {
  const flag = factType === 'sales_tax' ? values.closed_or_not_client : values.closed_or_none;
  return flag !== true;
}

export interface RecurringFactInput {
  factType: RecurringFactType;
  /** The Trello id the fact came from: the ledger key, stable across bundles. */
  sourceId: string;
  /** The hand-typed name key, kept in the ledger for reading and never as identity. */
  matchKey: string;
  /** The row's own as-of date (the day the board said it), never today. */
  asOf: string;
  /** The label every audit and ledger row carries. */
  appliedBy: string;
  /** The bundle tag written into the engagement's origin reason. */
  sourceTag: string;
  /** The contact the engagement bills and writes to. Required: engagements.contact_id is NOT NULL. */
  contactId: string;
  /** The entity the service is for, when the name matched a business. */
  businessId: string | null;
  /** The row's values_json, parsed. */
  values: Record<string, unknown>;
}

export interface RecurringFactResult {
  outcome: 'applied' | 'already_applied' | 'closed';
  engagementId: string | null;
  engagementCreated: boolean;
  /** Rows this call wrote: the engagement (1 if created) plus the column (1 if it was NULL and is now set). */
  rowsWritten: number;
}

const ZERO_UUID = '00000000-0000-0000-0000-000000000000';

async function ledgerHas(app: FastifyInstance, sourceId: string, factType: string): Promise<boolean> {
  const { rows } = await app.db.query<{ n: string }>(
    `SELECT count(*) AS n FROM service_fact_imports
      WHERE source = 'trello' AND trello_source_id = $1 AND fact_type = $2`,
    [sourceId, factType]
  );
  return Number(rows[0]!.n) > 0;
}

async function liveEngagementFor(
  app: FastifyInstance,
  contactId: string,
  businessId: string | null,
  line: RecurringFactType
): Promise<string | null> {
  // The same shape as 0098's unique index: one active engagement per contact, line, period and entity.
  const { rows } = await app.db.query<{ id: string }>(
    `SELECT id FROM engagements
      WHERE contact_id = $1 AND service_line = $2::service_line AND status IN ('active', 'on_hold')
        AND COALESCE(business_id, $4::uuid) = COALESCE($3::uuid, $4::uuid)
      ORDER BY created_at LIMIT 1`,
    [contactId, line, businessId, ZERO_UUID]
  );
  return rows[0]?.id ?? null;
}

/**
 * Apply one sales-tax or payroll fact. Idempotent on (source, trello_source_id, fact_type): the
 * ledger is consulted before anything is read and written after everything is done.
 */
export async function applyRecurringServiceFact(
  app: FastifyInstance,
  actor: AuthedStaff,
  input: RecurringFactInput
): Promise<RecurringFactResult> {
  if (input.factType !== 'sales_tax' && input.factType !== 'payroll') {
    throw new AppError(400, 'not_a_recurring_fact', `'${String(input.factType)}' is not a sales-tax or payroll fact.`);
  }
  if (!input.sourceId.trim()) {
    throw new AppError(400, 'fact_source_id_required', 'A service fact needs the Trello id it came from; without one a second run cannot tell it from the first.');
  }
  if (await ledgerHas(app, input.sourceId, input.factType)) {
    return { outcome: 'already_applied', engagementId: null, engagementCreated: false, rowsWritten: 0 };
  }

  const line = input.factType;
  const frequency = line === 'sales_tax' ? normalizeFilingFrequency(input.values.frequency) : null;
  const provider = line === 'payroll' ? String(input.values.provider ?? '').trim() : '';
  if (line === 'sales_tax' && !frequency) {
    throw new AppError(
      422,
      'unknown_filing_frequency',
      `Refusing: '${String(input.values.frequency ?? '')}' is not a sales-tax filing frequency the ` +
        `column holds (${[...FILING_FREQUENCIES].join(', ')}). The state assigns one of those; nothing here picks a near one.`
    );
  }

  const ledger = async (engagementId: string | null, rowsWritten: number): Promise<void> => {
    await app.db.query(
      `INSERT INTO service_fact_imports (source, trello_source_id, fact_type, business_id, match_key, as_of, applied_by, rows_written)
       VALUES ('trello', $1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (source, trello_source_id, fact_type) DO NOTHING`,
      [input.sourceId, input.factType, input.businessId, input.matchKey, input.asOf, input.appliedBy, rowsWritten]
    );
    await writeAudit(app.db, {
      actorType: 'staff',
      actorId: actor.id,
      actorLabel: actor.fullName,
      action: 'engagement.service_fact_imported',
      objectType: engagementId ? 'engagement' : 'business',
      objectId: engagementId ?? input.businessId,
      contactId: input.contactId,
      details: {
        fact_type: input.factType,
        trello_source_id: input.sourceId,
        as_of: input.asOf,
        live: isLiveServiceFact(line, input.values),
        ...(frequency ? { filing_frequency: frequency } : {}),
        ...(provider ? { payroll_provider: provider } : {}),
        rows_written: rowsWritten,
      },
    });
  };

  /*
   * CLOSED: read, understood, nothing created. The ledger row is what makes the second pass find it.
   */
  if (!isLiveServiceFact(line, input.values)) {
    await ledger(null, 0);
    return { outcome: 'closed', engagementId: null, engagementCreated: false, rowsWritten: 0 };
  }

  let engagementId = await liveEngagementFor(app, input.contactId, input.businessId, line);
  let created = false;
  if (!engagementId) {
    try {
      const made = await createEngagement(
        app,
        actor,
        {
          contactId: input.contactId,
          ...(input.businessId ? { businessId: input.businessId } : {}),
          serviceLine: line,
          title: line === 'sales_tax' ? 'Sales tax filings' : 'Payroll',
          status: 'active',
          periodKey: 'ongoing',
          origin: { via: 'staff', reason: `Trello import (${input.sourceTag}), ${line} fact ${input.sourceId}, as of ${input.asOf}` },
        },
        { ip: null, userAgent: `script: ${input.appliedBy}` }
      );
      engagementId = made.id;
      created = true;
      await app.db.query(`UPDATE engagements SET source = 'trello', trello_card_id = $2 WHERE id = $1`, [engagementId, input.sourceId]);
    } catch (err) {
      // Two rows for one client racing the unique index: the first one won, and this one uses it.
      const code = err && typeof err === 'object' && 'code' in err ? String((err as { code: unknown }).code) : '';
      if (code !== 'engagement_exists') throw err;
      engagementId = await liveEngagementFor(app, input.contactId, input.businessId, line);
      if (!engagementId) throw err;
    }
  }

  let columnRows = 0;
  if (line === 'sales_tax') {
    const r = await app.db.query(
      `UPDATE engagements SET filing_frequency = $2 WHERE id = $1 AND filing_frequency IS NULL`,
      [engagementId, frequency]
    );
    columnRows = r.rowCount ?? 0;
  } else if (provider) {
    const r = await app.db.query(
      `UPDATE engagements SET payroll_provider = $2 WHERE id = $1 AND payroll_provider IS NULL`,
      [engagementId, provider]
    );
    columnRows = r.rowCount ?? 0;
  }

  const rowsWritten = (created ? 1 : 0) + columnRows;
  await ledger(engagementId, rowsWritten);
  return { outcome: 'applied', engagementId, engagementCreated: created, rowsWritten };
}
