// §7216 consent PRESENTATION (legal package v3 FINAL).
//
// The consent capture already existed. What v3 defines is WHEN each consent is put
// in front of a client and HOW it is framed — and that is a compliance question,
// not a UI preference, because §7216 invalidates a consent obtained by
// conditioning service on it.
//
// Brian's ruling, from v3:
//
//   USE consent      → EVERY client, at onboarding, AFTER the Master signature,
//                      framed as a benefit.
//   DISCLOSE consent → ONLY Hilo-bridge clients, at onboarding OR at an actual
//                      referral moment.
//
// Both optional. Neither ever conditions service.
//
// Three rules this file enforces:
//
//  1. NEVER BEFORE THE MASTER SIGNATURE. Both consent forms say "presented
//     separately from your engagement documents". Presenting a consent alongside
//     the thing the client must sign to be served is exactly the conditioning
//     §7216 prohibits, so the presentation is gated on the signature existing.
//
//  2. DISCLOSE IS NOT OFFERED TO EVERYONE. Its recipient is Hilo NFP. Showing it
//     to a client with no Hilo relationship asks them to authorise a disclosure
//     that has no purpose — which is both pointless and a bad look on a form that
//     says "not a condition of any service".
//
//  3. DECLINING IS A RECORDED ANSWER. A client who says no is not asked again at
//     the next onboarding step; the absence of a consent and a declined consent
//     are different states, and only one of them should be re-asked.

import type { FastifyInstance } from 'fastify';
import { writeAudit } from '../../audit.ts';
import { AppError } from '../../types.ts';

export type ConsentKind = '7216_use' | '7216_disclose';

export interface ConsentOffer {
  kind: ConsentKind;
  templateKey: string;
  /** Why this client is being shown it — the audit answer to "why did you ask?" */
  reason: string;
  /** Benefit framing, EN. Spanish follows Brian's translation approval. */
  headlineEn: string;
  bodyEn: string;
  /**
   * THE CONSENT ITSELF — the §7216 text with the statements the regulation prescribes.
   *
   * This was missing, and its absence was a compliance defect rather than a cosmetic
   * one. The screen showed benefit framing and captured an answer, and the consent row
   * stamped policy_version = v3-t{n} pointing at template text the client had never been
   * shown. Treas. Reg. §301.7216-3 requires the mandatory statements to be IN the
   * consent — "Federal law requires this consent form be provided to you", the
   * invalid-if-conditioned sentence, the duration rule, the TIGTA contact. A summary is
   * not a consent, however honestly it summarises.
   */
  legalEn: string;
  /**
   * The approved Spanish rendering, or null when it is unapproved or absent.
   *
   * Brian's ruling (attorney green light, 2026-08-13): ship BILINGUAL with English
   * operative. So this never replaces legalEn — both are shown, and the English governs.
   */
  legalEs: string | null;
  /** The template version stamped onto the consent record, so the screen and the audit row agree. */
  templateVersion: number;
}

/**
 * Wet-signature ruled lines have no place in an e-signed consent (Brian's ruling,
 * 2026-08-13: "drop from e-sign rendering now").
 *
 * A screen where consent is given by tapping a button should not show
 * "Client signature: ______" — it invites the reader to look for a pen, and it implies
 * the tap was not the signature. Stripped at RENDER time rather than removed from the
 * stored template, because the paper lane still exists for older filing years and the
 * template is the same text either way.
 */
export function stripWetSignatureLines(body: string): string {
  return body
    .split('\n')
    .filter((line) => !/_{6,}/.test(line))
    .join('\n')
    .replace(/\n{3,}$/, '\n')
    .trimEnd();
}

const USE_OFFER = {
  kind: '7216_use' as const,
  templateKey: 'consent_7216_use',
  headlineEn: 'Want us to look for savings you have not asked about?',
  bodyEn:
    'Your tax return tells us things worth telling you — whether an S-corp election would save you money, ' +
    'whether your payroll setup is costing you, whether you are leaving a deduction on the table. Federal law ' +
    'says we cannot use your return for that without your written permission.\n\n' +
    'This is entirely optional and is not a condition of any service. Say no and nothing about your ' +
    'engagement changes — we simply will not proactively flag those opportunities. You can revoke it any time.',
};

const DISCLOSE_OFFER = {
  kind: '7216_disclose' as const,
  templateKey: 'consent_7216_disclose',
  headlineEn: 'Should we introduce you to Hilo?',
  bodyEn:
    'Hilo NFP runs free programming for business owners — workshops, grants, and one-on-one help. To ' +
    'coordinate that for you, we would share your name, contact details, business type, and a general ' +
    'description of what you need.\n\n' +
    'This is entirely optional and is not a condition of any service. Federal law may not protect your ' +
    'information from further use once disclosed, which is why we ask separately and in writing. You can ' +
    'revoke it any time.',
};

/** Does this client have any Hilo relationship the DISCLOSE consent would serve? */
export async function hasHiloBridge(app: FastifyInstance, contactId: string): Promise<{ bridge: boolean; reason: string | null }> {
  const { rows } = await app.db.query<{
    hilo_status: string; referred_by_hilo: boolean; jackson_referral: boolean;
    program_participant: boolean; referral_rows: number;
  }>(
    `SELECT c.hilo_status::text,
            c.br1_referred_by_hilo         AS referred_by_hilo,
            c.br3_referred_by_jackson      AS jackson_referral,
            c.br4_hilo_program_participant AS program_participant,
            (SELECT count(*)::int FROM referrals r WHERE r.contact_id = c.id) AS referral_rows
     FROM contacts c WHERE c.id = $1`,
    [contactId]
  );
  const r = rows[0];
  if (!r) throw new AppError(404, 'not_found', 'Contact not found.');
  const reasons: string[] = [];
  if (r.hilo_status !== 'none') reasons.push(`Hilo status: ${r.hilo_status}`);
  if (r.referred_by_hilo) reasons.push('referred by Hilo');
  if (r.jackson_referral) reasons.push('referred by Jackson');
  if (r.program_participant) reasons.push('Hilo program participant');
  if (r.referral_rows > 0) reasons.push('has a referral record');
  return { bridge: reasons.length > 0, reason: reasons.length > 0 ? reasons.join('; ') : null };
}

/**
 * What §7216 consents to put in front of this client right now.
 *
 * `atReferralMoment` is the second window v3 allows for DISCLOSE: a client with no
 * prior Hilo relationship who is about to be referred should be asked then, even
 * though they were not asked at onboarding.
 */
export async function consentsToPresent(
  app: FastifyInstance,
  contactId: string,
  opts: { atReferralMoment?: boolean } = {}
): Promise<{
  masterSigned: boolean;
  offers: ConsentOffer[];
  withheld: Array<{ kind: ConsentKind; reason: string }>;
}> {
  const signedRow = await app.db.query(
    `SELECT 1 FROM engagement_packets WHERE contact_id = $1 AND status = 'signed'`,
    [contactId]
  );
  const masterSigned = signedRow.rows.length > 0;

  const existing = await app.db.query<{ type: string; status: string }>(
    `SELECT type::text, status::text FROM consents
     WHERE contact_id = $1 AND type IN ('7216_use', '7216_disclose')`,
    [contactId]
  );
  // 'signed' or 'declined' is an ANSWER. 'requested' is not — a consent that was
  // put in front of a client who never responded should be offered again.
  const answered = new Set(
    existing.rows.filter((c) => c.status === 'signed' || c.status === 'declined').map((c) => c.type)
  );

  const offers: ConsentOffer[] = [];
  const withheld: Array<{ kind: ConsentKind; reason: string }> = [];

  // RULE 1 — nothing before the Master signature.
  if (!masterSigned) {
    withheld.push({
      kind: '7216_use',
      reason: 'Master Engagement Agreement not signed yet — a consent presented alongside the document a client must sign to be served is the conditioning §7216 prohibits.',
    });
    withheld.push({ kind: '7216_disclose', reason: 'Master Engagement Agreement not signed yet.' });
    return { masterSigned, offers, withheld };
  }

  /**
   * Load the actual §7216 texts. An offer that cannot carry its own consent text is not
   * an offer we may present, so a missing or placeholder template WITHHOLDS the consent
   * rather than showing framing with nothing behind it.
   */
  const texts = await loadConsentTexts(app);

  // USE — every client, benefit-framed.
  if (answered.has('7216_use')) {
    withheld.push({ kind: '7216_use', reason: 'Already answered — a declined consent is not re-asked.' });
  } else if (!texts.consent_7216_use) {
    withheld.push({
      kind: '7216_use',
      reason: 'The §7216 USE text is missing or still a placeholder — a consent cannot be presented without it.',
    });
  } else {
    offers.push({
      ...USE_OFFER,
      reason: 'Every client is offered the USE consent after signing.',
      ...texts.consent_7216_use,
    });
  }

  // DISCLOSE — Hilo-bridge clients, or an actual referral moment.
  const hilo = await hasHiloBridge(app, contactId);
  if (answered.has('7216_disclose')) {
    withheld.push({ kind: '7216_disclose', reason: 'Already answered — a declined consent is not re-asked.' });
  } else if (!texts.consent_7216_disclose) {
    withheld.push({
      kind: '7216_disclose',
      reason: 'The §7216 DISCLOSE text is missing or still a placeholder — a consent cannot be presented without it.',
    });
  } else if (hilo.bridge) {
    offers.push({ ...DISCLOSE_OFFER, reason: `Hilo bridge — ${hilo.reason}`, ...texts.consent_7216_disclose });
  } else if (opts.atReferralMoment) {
    offers.push({
      ...DISCLOSE_OFFER,
      reason: 'Presented at an actual referral moment.',
      ...texts.consent_7216_disclose,
    });
  } else {
    withheld.push({
      kind: '7216_disclose',
      reason: 'No Hilo relationship and no referral in progress — the recipient is Hilo NFP, so there is nothing this disclosure would serve.',
    });
  }

  await writeAudit(app.db, {
    actorType: 'system', actorLabel: 'consent-presentation',
    action: 'consent.presentation_computed', objectType: 'contact', objectId: contactId, contactId,
    details: {
      master_signed: masterSigned,
      offered: offers.map((o) => o.kind),
      withheld: withheld.map((w) => w.kind),
      hilo_bridge: hilo.bridge,
    },
  });

  return { masterSigned, offers, withheld };
}

/**
 * Record the client's answer. A DECLINE is stored, not ignored — it is what stops
 * the same consent being offered at every subsequent onboarding step.
 */
/**
 * The §7216 texts as the client must see them: mandated statements intact, wet-signature
 * ruled lines stripped, Spanish included only once Brian has approved it.
 *
 * Returns null for a key whose template is missing, inactive, or still a placeholder —
 * the caller withholds that consent rather than presenting framing with nothing behind
 * it. The placeholder gate is the same one that blocks placeholder documents from
 * reaching any production client; a consent is exactly the wrong place to make an
 * exception.
 */
async function loadConsentTexts(
  app: FastifyInstance
): Promise<Record<string, { legalEn: string; legalEs: string | null; templateVersion: number } | null>> {
  const { rows } = await app.db.query<{
    key: string;
    body_en: string;
    body_es: string | null;
    version: number;
    needs_es_review: boolean;
  }>(
    `SELECT key, body_en, body_es, version, needs_es_review
       FROM templates
      WHERE key IN ('consent_7216_use', 'consent_7216_disclose')
        AND is_active AND NOT is_placeholder`
  );
  const out: Record<string, { legalEn: string; legalEs: string | null; templateVersion: number } | null> = {
    consent_7216_use: null,
    consent_7216_disclose: null,
  };
  for (const r of rows) {
    out[r.key] = {
      legalEn: stripWetSignatureLines(r.body_en),
      // Unapproved Spanish never ships — same rule the render path enforces.
      legalEs: r.body_es && !r.needs_es_review ? stripWetSignatureLines(r.body_es) : null,
      templateVersion: r.version,
    };
  }
  return out;
}

export async function recordConsentAnswer(
  app: FastifyInstance,
  contactId: string,
  kind: ConsentKind,
  granted: boolean,
  meta: { ip?: string | null; userAgent?: string | null } = {}
): Promise<{ status: 'signed' | 'declined' }> {
  const signedMaster = await app.db.query(
    `SELECT 1 FROM engagement_packets WHERE contact_id = $1 AND status = 'signed'`,
    [contactId]
  );
  if (signedMaster.rows.length === 0) {
    throw new AppError(
      409,
      'master_not_signed',
      'A §7216 consent cannot be captured before the Master is signed — that ordering is what keeps the consent valid.'
    );
  }
  const tpl = await app.db.query<{ key: string; version: number }>(
    `SELECT key, version FROM templates
     WHERE key = $1 AND is_active AND NOT is_placeholder`,
    [kind === '7216_use' ? 'consent_7216_use' : 'consent_7216_disclose']
  );
  if (!tpl.rows[0]) {
    throw new AppError(409, 'consent_text_not_final', 'The consent text is not final, so a consent cannot be captured.');
  }
  const policyVersion = `v3-t${tpl.rows[0].version}`;

  const status = granted ? 'signed' : 'declined';
  await app.db.query(
    `INSERT INTO consents (contact_id, type, status, method, policy_version, signed_at)
     VALUES ($1, $2::consent_type, $3::consent_status, 'portal_checkbox', $4,
             CASE WHEN $5 THEN now() END)`,
    [contactId, kind, status, policyVersion, granted]
  );

  // The rollup on contacts is what every existing §7216 gate reads, so it is
  // maintained the same way record7216Consent maintains it — with one guard: a
  // DECLINE never overwrites a status that is already 'signed'. Declining the
  // DISCLOSE consent must not revoke a USE consent the client actually gave.
  if (granted) {
    await app.db.query(`UPDATE contacts SET consent_7216_status = 'signed' WHERE id = $1`, [contactId]);
  } else {
    await app.db.query(
      `UPDATE contacts SET consent_7216_status = 'declined'
       WHERE id = $1 AND consent_7216_status <> 'signed'`,
      [contactId]
    );
  }

  /*
   * Checklist step 3 completes here, in the same call that records the answer, so the
   * two can never disagree (finding #34).
   *
   * It stamps on ANSWER — `status` is 'signed' or 'declined' and both count. A step that
   * only completed on consent would make finishing setup depend on consenting, and §7216
   * is precisely a rule against conditioning service on consent. A client who declines
   * has done what was asked of them.
   */
  await app.db.query(
    `UPDATE portal_onboarding SET step_consent_at = COALESCE(step_consent_at, now())
      WHERE contact_id = $1 AND step_consent_at IS NULL`,
    [contactId]
  );

  await writeAudit(app.db, {
    actorType: 'client', actorId: contactId, actorLabel: 'consent answer',
    action: granted ? 'consent.granted' : 'consent.declined',
    objectType: 'contact', objectId: contactId, contactId,
    ip: meta.ip ?? null, userAgent: meta.userAgent ?? null,
    details: { kind, policy_version: policyVersion, method: 'portal_checkbox' },
  });
  return { status };
}
