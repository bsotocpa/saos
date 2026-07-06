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
  fetchSignedDocument(submissionId: string): Promise<{ buffer: Buffer; filename: string }>;
}

function stubAdapter(): DocusealAdapter {
  return {
    mode: 'stub',
    async createSubmission(opts) {
      return { submissionId: `stub-${opts.envelopeId}` };
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
