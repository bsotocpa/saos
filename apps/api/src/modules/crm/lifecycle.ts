/*
 * CONTACT LIFECYCLE (#42, Brian's ruling 2026-08-16).
 *
 * lead → onboarding → active → dormant, with archived as the only manually-set state.
 *
 * The point of this file is that the status is DERIVED FROM WHAT HAPPENED. RC2 read
 * "lead" while holding a signed Master, an answered §7216, a paid invoice and a live
 * portal session — because the old field was hand-set at creation and nothing ever moved
 * it. A field that only changes when someone remembers to change it will be wrong, and it
 * will be wrong in the direction of whatever it was first set to.
 *
 * So callers do not pass a status. They tell this module that something happened, and it
 * recomputes from the record. There is no exported "set it to active".
 */

import type { FastifyInstance } from 'fastify';
import { writeAudit } from '../../audit.ts';

export type ContactLifecycle = 'lead' | 'onboarding' | 'active' | 'dormant' | 'archived';

/**
 * The legacy `soto_status` mirror.
 *
 * That column is read in over a hundred places — broadcast audiences, health scoring,
 * reports, the importer — and changing all of them in the same breath as introducing this
 * ladder is how an audience filter breaks without anyone noticing. So it is kept in step
 * here, by the one function that writes either column, and the two cannot drift.
 */
const LEGACY: Record<ContactLifecycle, string> = {
  lead: 'lead',
  onboarding: 'lead',   // pre-service in the old vocabulary; not yet a client
  active: 'active',
  dormant: 'inactive',
  archived: 'former',
};

/**
 * What the record says this contact's lifecycle IS, from events alone.
 *
 * `archived` is never returned: it is a deliberate act, not an observation, so a contact
 * someone closed out is not silently reopened by this recomputing underneath them.
 */
export async function deriveLifecycle(app: FastifyInstance, contactId: string): Promise<ContactLifecycle> {
  const { rows } = await app.db.query<{
    master_signed: boolean; open_engagements: number; ever_engaged: boolean;
    accepted_quote: boolean; from_client_book: boolean;
  }>(
    `SELECT
       EXISTS (SELECT 1 FROM engagement_packets p WHERE p.contact_id = $1 AND p.status = 'signed') AS master_signed,
       -- on_hold IS OPEN (#44). Brian's ruling: a pause keeps the client active. A client
       -- whose work we deliberately held this week has not stopped being a client, and
       -- flipping them to dormant would be the system reporting our own decision back to
       -- us as their disengagement.
       (SELECT count(*)::int FROM engagements e
         WHERE e.contact_id = $1 AND e.status IN ('active', 'on_hold'))                            AS open_engagements,
       EXISTS (SELECT 1 FROM engagements e WHERE e.contact_id = $1)                                AS ever_engaged,
       EXISTS (SELECT 1 FROM quotes q WHERE q.contact_id = $1 AND q.status = 'accepted')           AS accepted_quote,
       (SELECT c.source::text = 'dubsado' FROM contacts c WHERE c.id = $1)                         AS from_client_book`,
    [contactId]
  );
  const f = rows[0]!;
  if (f.master_signed && f.open_engagements > 0) return 'active';
  if (f.ever_engaged && f.open_engagements === 0) return 'dormant';
  if (f.accepted_quote) return 'onboarding';

  /*
   * MIGRATION PROVENANCE IS EVIDENCE — the lesson from the 426-client backfill, in code
   * rather than only in a doc.
   *
   * A contact imported from the Dubsado client book has a real relationship whose history
   * lives in the old system. SAOS sees no engagement because the work predates SAOS, not
   * because it never happened, so deriving purely from what SAOS generated calls 426
   * established clients "leads". Worse, without this the health sweep would recompute them
   * back to lead on its next run and silently undo migration 0063.
   *
   * Zoho was the CRM and held prospects, so those contacts really are leads.
   */
  if (f.from_client_book) return 'dormant';
  return 'lead';
}

/**
 * Recompute and store, after something happened. Idempotent and safe to call from any
 * event — it writes only when the answer changed, so the timestamp means "when this
 * client's standing last actually moved".
 *
 * An archived contact is left alone. Re-engaging one is a deliberate act too, and should
 * not be a side effect of a webhook.
 */
export async function refreshContactStatus(
  app: FastifyInstance,
  contactId: string,
  because: string
): Promise<ContactLifecycle | null> {
  const current = await app.db.query<{ contact_status: ContactLifecycle }>(
    `SELECT contact_status FROM contacts WHERE id = $1`,
    [contactId]
  );
  if (!current.rows[0]) return null;
  if (current.rows[0].contact_status === 'archived') return 'archived';

  const next = await deriveLifecycle(app, contactId);
  if (next === current.rows[0].contact_status) {
    /*
     * The lifecycle has not moved — but the MIRROR still might be stale, and this is the
     * only place allowed to repair it. Contacts get created outside this ladder (the
     * importer, the Hilo transition, test fixtures) and land on the column default, so
     * soto_status can say 'none' while contact_status says 'lead'. Returning early left
     * that untouched and quietly broke Hilo → Soto conversion, which relies on the
     * intake making someone a Soto lead.
     *
     * Self-healing rather than hand-written: any path that creates a contact can call
     * this and be sure both columns agree afterwards.
     */
    await app.db.query(
      `UPDATE contacts SET soto_status = $2::soto_status
        WHERE id = $1 AND soto_status <> $2::soto_status`,
      [contactId, LEGACY[next]]
    );
    return next;
  }

  await app.db.query(
    `UPDATE contacts
        SET contact_status = $2::contact_lifecycle,
            contact_status_at = now(),
            soto_status = $3::soto_status
      WHERE id = $1`,
    [contactId, next, LEGACY[next]]
  );
  await writeAudit(app.db, {
    actorType: 'system',
    action: 'contact.status_changed',
    objectType: 'contact',
    objectId: contactId,
    contactId,
    details: { from: current.rows[0].contact_status, to: next, because },
  });
  return next;
}

/**
 * Archive — the one state a person sets, and the only one that takes a reason.
 *
 * The reason is required by the database as well as by this signature, because "archived"
 * with nothing next to it is indistinguishable from a mistake six months later.
 */
export async function archiveContact(
  app: FastifyInstance,
  contactId: string,
  reason: string,
  actor: { id: string; email: string }
): Promise<void> {
  await app.db.query(
    `UPDATE contacts
        SET contact_status = 'archived', contact_status_at = now(),
            archived_reason = $2, soto_status = 'former'
      WHERE id = $1`,
    [contactId, reason]
  );
  await writeAudit(app.db, {
    actorType: 'staff', actorId: actor.id, actorLabel: actor.email,
    action: 'contact.archived', objectType: 'contact', objectId: contactId,
    contactId, details: { reason },
  });
}
