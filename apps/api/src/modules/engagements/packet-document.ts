// The SAOS-GENERATED PACKET DOCUMENT.
//
// v3's architecture always specified this: one Master Engagement Agreement plus
// ONLY the Service Schedules the client's services require, variables filled, and
// the §7216 consents NOT in the signing document — they are presented separately
// and optionally after the signature, which is what keeps them valid.
//
// The static Docuseal template (one PDF of the entire package, one signature) was a
// first-boot artifact. Signing it would have meant a tax-only client physically
// accepting bookkeeping and entity terms the database says they never accepted, and
// §7216 consent captured by the same signature that engages the service — the exact
// conditioning §7216 prohibits.
//
// This module is deliberately VENDOR-AGNOSTIC. It produces the document and a
// manifest of what is in it and what was left out; how that document gets signed is
// a separate decision (Docuseal Pro's HTML/PDF template API, or a portal-native
// E-SIGN capture). Everything here is needed either way.
//
// THREE INVARIANTS, all asserted by tests:
//   1. Exactly the packet's schedule_codes appear — no more, no fewer.
//   2. No §7216 consent appears, ever, under any code path.
//   3. No unfilled {{variable}} and no blank ____ run reaches a signer.

import type { FastifyInstance } from 'fastify';
import { AppError } from '../../types.ts';
import { renderMasterForPacket } from './packet.ts';

export interface PacketSection {
  kind: 'master' | 'schedule';
  code: string | null;
  title: string;
  templateKey: string;
  templateVersion: number;
  body: string;
}

export interface PacketDocument {
  packetId: string;
  contactId: string;
  language: 'en' | 'es';
  sections: PacketSection[];
  /** Named so a reader can see the omission was deliberate, not an oversight. */
  deliberatelyExcluded: Array<{ templateKey: string; reason: string }>;
  html: string;
}

const CONSENT_EXCLUSION_REASON =
  '§7216 consents are presented separately in the portal AFTER the engagement signature, ' +
  'and are optional. Including one in the signing document would condition service on it, ' +
  'which invalidates the consent (and contradicts the package’s own instructions).';

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** Plain text → HTML paragraphs, preserving the blank-line structure of the legal text. */
function toParagraphs(text: string): string {
  return text
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter((block) => block.length > 0)
    .map((block) => `<p>${escapeHtml(block).replace(/\n/g, '<br />')}</p>`)
    .join('\n');
}

export async function buildPacketDocument(
  app: FastifyInstance,
  packetId: string,
  language: 'en' | 'es' = 'en'
): Promise<PacketDocument> {
  const packetRow = await app.db.query<{
    contact_id: string; schedule_codes: string[]; master_template_key: string; status: string;
    first_name: string; last_name: string;
  }>(
    `SELECT p.contact_id, p.schedule_codes, p.master_template_key, p.status,
            c.first_name, c.last_name
     FROM engagement_packets p JOIN contacts c ON c.id = p.contact_id
     WHERE p.id = $1`,
    [packetId]
  );
  const p = packetRow.rows[0];
  if (!p) throw new AppError(404, 'not_found', 'Packet not found.');

  // The Master, with the attached-schedule sentence filled from the packet itself.
  const master = await renderMasterForPacket(app, packetId, language);
  const masterMeta = await app.db.query<{ name: string; version: number }>(
    `SELECT name, version FROM templates WHERE key = $1`,
    [p.master_template_key]
  );

  const sections: PacketSection[] = [{
    kind: 'master',
    code: null,
    title: masterMeta.rows[0]?.name ?? 'Master Engagement Agreement',
    templateKey: p.master_template_key,
    templateVersion: masterMeta.rows[0]?.version ?? 1,
    body: master.body,
  }];

  // Only the schedules this packet carries, in schedule order.
  const scheduleRows = await app.db.query<{
    schedule_code: string; title: string; template_key: string; version: number;
    kind: string; is_placeholder: boolean;
  }>(
    `SELECT s.schedule_code, s.title, s.template_key, t.version, t.kind::text AS kind, t.is_placeholder
     FROM service_schedules s JOIN templates t ON t.key = s.template_key
     WHERE s.schedule_code = ANY($1) AND t.is_active
     ORDER BY s.sort_order`,
    [p.schedule_codes]
  );
  if (scheduleRows.rows.length !== p.schedule_codes.length) {
    const found = scheduleRows.rows.map((r) => r.schedule_code);
    throw new AppError(
      500,
      'schedule_missing',
      `Packet lists schedule(s) ${p.schedule_codes.filter((c) => !found.includes(c)).join(', ')} with no active template.`
    );
  }

  for (const s of scheduleRows.rows) {
    if (s.is_placeholder) {
      throw new AppError(
        409,
        'schedule_not_final',
        `Schedule ${s.schedule_code} is flagged PLACEHOLDER and cannot be put in front of a client.`
      );
    }
    // Schedule F carries the per-engagement Addendum, whose blanks are the agreed
    // terms — filled from attest_addenda, never left as underscores.
    let body: string;
    if (s.schedule_code === 'F') {
      const { renderScheduleF } = await import('./packet.ts');
      body = (await renderScheduleF(app, p.contact_id, language)).body;
    } else {
      const { renderTemplate } = await import('../templates/service.ts');
      body = (await renderTemplate(app, s.template_key, language, {})).body;
    }
    sections.push({
      kind: 'schedule', code: s.schedule_code, title: s.title,
      templateKey: s.template_key, templateVersion: s.version, body,
    });
  }

  // INVARIANT 2, enforced rather than assumed: nothing of kind 'consent' can be
  // here, because only master + service_schedules rows are ever added above. This
  // check exists so a future edit that widens the query fails loudly.
  const consentKeys = await app.db.query<{ key: string }>(
    `SELECT key FROM templates WHERE kind = 'consent' AND is_active`
  );
  const includedKeys = new Set(sections.map((s) => s.templateKey));
  for (const c of consentKeys.rows) {
    if (includedKeys.has(c.key)) {
      throw new AppError(
        500,
        'consent_in_signing_document',
        `${c.key} was about to be included in a signing document. ${CONSENT_EXCLUSION_REASON}`
      );
    }
  }

  const clientName = `${p.first_name} ${p.last_name}`.trim();
  const body = sections
    .map((s) => `<section class="doc" data-template="${escapeHtml(s.templateKey)}" data-version="${s.templateVersion}">
<h2>${escapeHtml(s.title)}</h2>
${toParagraphs(s.body)}
</section>`)
    .join('\n');

  const html = `<article class="saos-packet" data-packet="${escapeHtml(packetId)}" lang="${language}">
${body}
<section class="doc signature-block" data-signature-block="client">
<h2>Acceptance</h2>
<p>By signing below you accept the Master Engagement Agreement and every Service Schedule included above.</p>
<p>Client: ${escapeHtml(clientName)}</p>
</section>
</article>`;

  return {
    packetId,
    contactId: p.contact_id,
    language,
    sections,
    deliberatelyExcluded: consentKeys.rows.map((c) => ({
      templateKey: c.key, reason: CONSENT_EXCLUSION_REASON,
    })),
    html,
  };
}
