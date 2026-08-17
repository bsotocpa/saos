// M22 executor. Dry run writes ONLY the import_batches bookkeeping rows
// (dry_run = true) — zero contact/business/grant writes. Execute runs in one
// transaction and is idempotent: re-running marks everything 'duplicate'
// instead of inserting twice. Existing NATIVE records are never modified.

import type { Db } from '../db.ts';
import { writeAudit } from '../audit.ts';
import type { ImportPlan } from './plan.ts';

export interface ExecuteResult {
  dryRun: boolean;
  batchIds: Record<string, string>;
  contactsCreated: number;
  contactsDuplicate: number;
  businessesCreated: number;
  businessesDuplicate: number;
  ownersLinked: number;
  grantsCreated: number;
  grantsDuplicate: number;
  enrichmentQueued: number;
  skippedRecorded: number;
}

export async function executePlan(
  pool: Db,
  plan: ImportPlan,
  opts: { dryRun: boolean; dirLabel: string }
): Promise<ExecuteResult> {
  const client = await pool.connect();
  const result: ExecuteResult = {
    dryRun: opts.dryRun,
    batchIds: {},
    contactsCreated: 0,
    contactsDuplicate: 0,
    businessesCreated: 0,
    businessesDuplicate: 0,
    ownersLinked: 0,
    grantsCreated: 0,
    grantsDuplicate: 0,
    enrichmentQueued: 0,
    skippedRecorded: 0,
  };

  try {
    await client.query('BEGIN');

    for (const source of ['dubsado', 'zoho', 'grant_tracker'] as const) {
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO import_batches (source, filename, dry_run, stats)
         VALUES ($1, $2, $3, $4::jsonb) RETURNING id`,
        [source, opts.dirLabel, opts.dryRun, JSON.stringify(plan.stats)]
      );
      result.batchIds[source] = rows[0]!.id;
    }

    if (!opts.dryRun) {
      const record = (
        batch: string,
        sourceRef: string,
        raw: unknown,
        status: 'imported' | 'skipped' | 'duplicate',
        contactId: string | null,
        error: string | null
      ) =>
        client.query(
          `INSERT INTO import_records (batch_id, source_ref, raw, status, contact_id, error)
           VALUES ($1, $2, $3::jsonb, $4, $5, $6)`,
          [batch, sourceRef, JSON.stringify(raw), status, contactId, error]
        );

      // ── contacts ──────────────────────────────────────────────────────────
      const contactIdByKey = new Map<string, string>();
      for (const c of plan.contacts) {
        const refs = c.sources.map((s) => s.sourceRef);
        const existing = await client.query<{ id: string }>(
          `SELECT id FROM contacts
           WHERE source_ref = ANY($1)
              OR (email IS NOT NULL AND email = $2)
           LIMIT 1`,
          [refs, c.email]
        );
        let contactId = existing.rows[0]?.id ?? null;
        let status: 'imported' | 'duplicate' = 'duplicate';
        if (!contactId) {
          const ins = await client.query<{ id: string }>(
            `INSERT INTO contacts
               (first_name, last_name, email, phone, secondary_phone, address_line1, city, state, zip,
                language, soto_status, client_since, notes, source, source_ref)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
             RETURNING id`,
            [
              c.firstName, c.lastName, c.email, c.phone, c.secondaryPhone, c.addressLine1, c.city, c.state, c.zip,
              c.language, c.sotoStatus, c.clientSince, c.notes, c.source, c.sourceRef,
            ]
          );
          contactId = ins.rows[0]!.id;
          status = 'imported';
          result.contactsCreated++;
        } else {
          result.contactsDuplicate++;
        }
        contactIdByKey.set(c.key, contactId);
        for (const s of c.sources) {
          const batch = result.batchIds[s.source]!;
          await record(batch, s.sourceRef, s.raw, status, contactId, null);
        }
        if (status === 'imported' && c.missingFields.length > 0) {
          await client.query(
            `INSERT INTO enrichment_queue (contact_id, missing_fields) VALUES ($1, $2)`,
            [contactId, [...new Set(c.missingFields)]]
          );
          result.enrichmentQueued++;
        }
      }

      // ── businesses + owners ───────────────────────────────────────────────
      for (const b of plan.businesses) {
        const existing = await client.query<{ id: string }>(
          `SELECT id FROM businesses WHERE source = 'zoho' AND source_ref = $1 LIMIT 1`,
          [b.sourceRef]
        );
        let businessId = existing.rows[0]?.id ?? null;
        if (!businessId) {
          const ins = await client.query<{ id: string }>(
            `INSERT INTO businesses
               (name, ein, entity_type, industry, irs_activity_code, state, zip, notes, source, source_ref)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'zoho',$9)
             RETURNING id`,
            [b.name, b.ein, b.entityType, b.industry, b.irsActivityCode, b.state, b.zip, b.notes, b.sourceRef]
          );
          businessId = ins.rows[0]!.id;
          result.businessesCreated++;
          let first = true;
          for (const ownerKey of b.ownerKeys) {
            const contactId = contactIdByKey.get(ownerKey);
            if (!contactId) continue;
            await client.query(
              `INSERT INTO business_members (business_id, contact_id, member_role, is_primary)
               VALUES ($1, $2, 'owner', $3)
               ON CONFLICT DO NOTHING`,
              [businessId, contactId, first]
            );
            first = false;
            result.ownersLinked++;
          }
        } else {
          result.businessesDuplicate++;
        }
      }

      // ── grants (Login Details never reach this point — stripped at parse) ─
      const grantBatch = result.batchIds['grant_tracker']!;
      for (const g of plan.grants) {
        const existing = await client.query(
          `SELECT 1 FROM grants_received
           WHERE source = 'grant_tracker' AND funder = $1
             AND program IS NOT DISTINCT FROM $2
             AND hard_deadline IS NOT DISTINCT FROM $3
             AND notes IS NOT DISTINCT FROM $4
           LIMIT 1`,
          [g.funder, g.program, g.hardDeadline, g.notes]
        );
        if (existing.rows.length > 0) {
          result.grantsDuplicate++;
          await record(grantBatch, g.funder, g.raw, 'duplicate', null, null);
          continue;
        }
        await client.query(
          `INSERT INTO grants_received
             (funder, program, amount_cents, submission_type, status,
              internal_deadline, hard_deadline, materials_link, notes, source)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'grant_tracker')`,
          [
            g.funder, g.program, g.amountCents, g.submissionType, g.status,
            g.internalDeadline, g.hardDeadline, g.materialsLink, g.notes,
          ]
        );
        result.grantsCreated++;
        await record(grantBatch, g.funder, g.raw, 'imported', null, null);
      }

      // ── skipped rows: recorded for traceability ───────────────────────────
      for (const s of plan.skipped) {
        const batch = result.batchIds[s.source === 'zoho_lead' ? 'zoho' : s.source]!;
        await record(batch, s.sourceRef, s.raw, 'skipped', null, s.reason);
        result.skippedRecorded++;
      }
    }

    await client.query(
      `UPDATE import_batches SET completed_at = now(), stats = stats || $2::jsonb WHERE id = ANY($1)`,
      [Object.values(result.batchIds), JSON.stringify({ ...counts(result) })]
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }

  await writeAudit(pool, {
    actorType: 'system',
    actorLabel: 'import-legacy CLI',
    action: opts.dryRun ? 'import.dry_run' : 'import.executed',
    details: { dir: opts.dirLabel, ...plan.stats, ...counts(result) },
  });
  return result;
}

function counts(r: ExecuteResult): Record<string, number> {
  return {
    contacts_created: r.contactsCreated,
    contacts_duplicate: r.contactsDuplicate,
    businesses_created: r.businessesCreated,
    businesses_duplicate: r.businessesDuplicate,
    owners_linked: r.ownersLinked,
    grants_created: r.grantsCreated,
    grants_duplicate: r.grantsDuplicate,
    enrichment_queued: r.enrichmentQueued,
    skipped_recorded: r.skippedRecorded,
  };
}
