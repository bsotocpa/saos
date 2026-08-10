// Docuseal adapter (self-hosted e-signature, sign.sotoaccounting.com).
// Two implementations behind one interface:
//   stub — dev/test: no Docuseal instance needed; deterministic ids +
//          synthetic signed PDFs
//   http — real instance via its REST API (X-Auth-Token)
// Selected by DOCUSEAL_MODE. In production the send path refuses stub mode at
// runtime (clear error) rather than silently pretending to send.

import type { Config } from '../../config.ts';
import { AppError } from '../../types.ts';

export interface DocusealAdapter {
  readonly mode: 'stub' | 'http';
  createSubmission(opts: {
    /** Docuseal template id (numeric string) — null for stub flows. */
    docusealTemplateId: string | null;
    envelopeId: string;
    recipientEmail: string;
    recipientName: string;
  }): Promise<{ submissionId: string }>;
  /**
   * Send a document SAOS generated, rather than a pre-built Docuseal template.
   * This is how engagement packets are sent: Master + only the schedules the
   * client's services require, §7216 consents excluded.
   *
   * Requires Docuseal PRO (`POST /api/templates/html`). Community edition returns
   * 404 "available in Pro Edition", which this surfaces as a named error rather
   * than a generic 502, because the fix is a licensing action and not a bug.
   */
  createSubmissionFromHtml(opts: {
    html: string;
    /** Template name in Docuseal — carries the packet id so it is traceable. */
    documentName: string;
    envelopeId: string;
    recipientEmail: string;
    recipientName: string;
  }): Promise<{ submissionId: string; generatedTemplateId: string | null }>;
  fetchSignedDocument(submissionId: string): Promise<{ buffer: Buffer; filename: string }>;
}

function stubAdapter(): DocusealAdapter {
  return {
    mode: 'stub',
    async createSubmission(opts) {
      return { submissionId: `stub-${opts.envelopeId}` };
    },
    async createSubmissionFromHtml(opts) {
      // Deterministic, and distinguishable from the template path so a test can
      // tell WHICH path a packet took.
      return { submissionId: `stub-doc-${opts.envelopeId}`, generatedTemplateId: null };
    },
    async fetchSignedDocument(submissionId) {
      return {
        buffer: Buffer.from(`%PDF-1.4 synthetic signed document for ${submissionId}\n%%EOF`),
        filename: `signed-${submissionId}.pdf`,
      };
    },
  };
}

function httpAdapter(config: Config): DocusealAdapter {
  const base = config.DOCUSEAL_URL.replace(/\/$/, '');
  const headers = { 'X-Auth-Token': config.DOCUSEAL_API_TOKEN ?? '', 'content-type': 'application/json' };
  return {
    mode: 'http',
    async createSubmission(opts) {
      if (!opts.docusealTemplateId) {
        throw new AppError(500, 'docuseal_template_missing', 'No Docuseal template id configured for this envelope type.');
      }
      const res = await fetch(`${base}/api/submissions`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          template_id: Number(opts.docusealTemplateId),
          send_email: true,
          submitters: [{ email: opts.recipientEmail, name: opts.recipientName, external_id: opts.envelopeId }],
        }),
      });
      if (!res.ok) throw new AppError(502, 'docuseal_error', `Docuseal submission failed (${res.status}).`);
      type SubmissionRef = { submission_id?: number; id?: number };
      const body = (await res.json()) as SubmissionRef[] | SubmissionRef;
      const first = Array.isArray(body) ? body[0] : body;
      const submissionId = String(first?.submission_id ?? first?.id ?? '');
      if (!submissionId) throw new AppError(502, 'docuseal_error', 'Docuseal returned no submission id.');
      return { submissionId };
    },
    async createSubmissionFromHtml(opts) {
      // 1. Turn the generated document into a Docuseal template. The signature and
      //    date fields are inline field tags in the HTML, so field placement is
      //    ours and does not depend on anyone dragging boxes in a UI.
      const tplRes = await fetch(`${base}/api/templates/html`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ name: opts.documentName, html: opts.html }),
      });
      if (tplRes.status === 404) {
        const body = await tplRes.text();
        if (/Pro Edition/i.test(body)) {
          throw new AppError(
            503,
            'docuseal_pro_required',
            'Docuseal PRO is not active on this instance, so a SAOS-generated packet cannot be sent. ' +
              'The community image accepts submissions only against templates built by hand in its UI — ' +
              'which is what bundled every schedule and both §7216 consents into one signature. ' +
              'Activate Pro on the docuseal container (license key + Pro image), then retry; nothing else changes.'
          );
        }
        throw new AppError(502, 'docuseal_error', `Docuseal template creation returned 404: ${body.slice(0, 200)}`);
      }
      if (!tplRes.ok) {
        throw new AppError(502, 'docuseal_error', `Docuseal template creation failed (${tplRes.status}).`);
      }
      const tpl = (await tplRes.json()) as { id?: number };
      if (tpl.id === undefined) {
        throw new AppError(502, 'docuseal_error', 'Docuseal returned no template id for the generated document.');
      }

      // 2. Submit it to the signer.
      const subRes = await fetch(`${base}/api/submissions`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          template_id: tpl.id,
          send_email: true,
          submitters: [{
            email: opts.recipientEmail, name: opts.recipientName, external_id: opts.envelopeId,
          }],
        }),
      });
      if (!subRes.ok) {
        throw new AppError(502, 'docuseal_error', `Docuseal submission failed (${subRes.status}).`);
      }
      type SubmissionRef = { submission_id?: number; id?: number };
      const body = (await subRes.json()) as SubmissionRef[] | SubmissionRef;
      const first = Array.isArray(body) ? body[0] : body;
      const submissionId = String(first?.submission_id ?? first?.id ?? '');
      if (!submissionId) throw new AppError(502, 'docuseal_error', 'Docuseal returned no submission id.');
      return { submissionId, generatedTemplateId: String(tpl.id) };
    },

    async fetchSignedDocument(submissionId) {
      const res = await fetch(`${base}/api/submissions/${submissionId}/documents`, { headers });
      if (!res.ok) throw new AppError(502, 'docuseal_error', `Docuseal documents fetch failed (${res.status}).`);
      const body = (await res.json()) as { documents?: Array<{ url: string; name?: string }> };
      const doc = body.documents?.[0];
      if (!doc) throw new AppError(502, 'docuseal_error', 'Docuseal returned no signed documents.');
      const file = await fetch(doc.url);
      if (!file.ok) throw new AppError(502, 'docuseal_error', `Signed document download failed (${file.status}).`);
      return { buffer: Buffer.from(await file.arrayBuffer()), filename: doc.name ?? `signed-${submissionId}.pdf` };
    },
  };
}

export function makeDocusealAdapter(config: Config): DocusealAdapter {
  return config.DOCUSEAL_MODE === 'http' ? httpAdapter(config) : stubAdapter();
}
