// FINDING #14 — the rescan job.
//
// Brian's ruling: "Dead clamd → skipped → scheduled auto-rescan until clean, then
// file. No upload refusal at any point."
//
// This is what makes that true. Intake never refuses and never blocks, so a wedged
// scanner leaves documents sitting at 'skipped' (or 'pending_scan' if even the
// bookkeeping failed). Without this job those documents would sit unfiled forever and
// a client would be chased for a document they already sent — the worst of both
// worlds. With it, a scanner outage costs time and nothing else.
//
// Deliberately NOT gated by isAutomationEnabled(): nothing here sends anything to a
// client. It resolves internal state and completes a filing the client already
// earned by uploading. The client-facing consequence of a clean verdict is that we
// STOP chasing them, which is not an outbound message.

import type { FastifyInstance } from 'fastify';
import type { Client as MinioClient } from 'minio';
import { recordScan, fulfillRequestItem, mayFile } from './service.ts';

export interface RescanSummary {
  considered: number;
  clean: number;
  infected: number;
  stillSkipped: number;
  filed: number;
  unreadable: number;
}

/**
 * Bounded per run: this pulls whole files into memory to stream them at clamd, and it
 * shares a 16GB box with Whisper and Ollama. 100 documents per tick clears a
 * thirteen-hour outage in a few ticks without ever holding more than one file.
 */
const BATCH = 100;

export async function runDocumentRescanJob(
  app: FastifyInstance,
  minio: MinioClient
): Promise<RescanSummary> {
  const summary: RescanSummary = {
    considered: 0,
    clean: 0,
    infected: 0,
    stillSkipped: 0,
    filed: 0,
    unreadable: 0,
  };

  // Oldest first: the document someone has been waiting on longest gets resolved
  // first. Matches the index created in migration 0045.
  const { rows } = await app.db.query<{
    id: string;
    contact_id: string;
    minio_bucket: string;
    minio_key: string;
    pending_request_item_id: string | null;
  }>(
    `SELECT id, contact_id, minio_bucket, minio_key, pending_request_item_id
       FROM documents
      WHERE scan_status IN ('pending_scan', 'skipped')
      ORDER BY created_at
      LIMIT $1`,
    [BATCH]
  );
  summary.considered = rows.length;
  if (rows.length === 0) return summary;

  for (const doc of rows) {
    let buffer: Buffer;
    try {
      buffer = await readObject(minio, doc.minio_bucket, doc.minio_key);
    } catch (err) {
      // The row says there are bytes and there are not. That is a real problem, but
      // it is a STORAGE problem, not a scan verdict — do not mark it clean, do not
      // mark it infected, and do not silently drop it from the count.
      summary.unreadable += 1;
      app.log.error(
        { err, documentId: doc.id, bucket: doc.minio_bucket },
        'rescan could not read object from storage'
      );
      continue;
    }

    const status = await recordScan(app, doc.id, buffer, doc.contact_id, {
      type: 'system',
      label: 'rescan job',
    });

    if (mayFile(status)) {
      summary.clean += 1;
      // The deferred filing, finally. fulfillRequestItem re-checks that the item
      // belongs to this contact, so a request deleted or reassigned in the meantime
      // simply does not fulfil.
      if (doc.pending_request_item_id) {
        await fulfillRequestItem(app, doc.pending_request_item_id, doc.id, doc.contact_id);
        await app.db.query(`UPDATE documents SET pending_request_item_id = NULL WHERE id = $1`, [
          doc.id,
        ]);
        summary.filed += 1;
      }
    } else if (status === 'infected') {
      // recordScan already quarantined it and raised the task for Brian. The pending
      // filing target stays on the row: it documents what this file was supposed to
      // satisfy, which is exactly what he needs to know when asking for a replacement.
      summary.infected += 1;
    } else {
      summary.stillSkipped += 1;
    }
  }

  if (summary.stillSkipped > 0) {
    app.log.warn(
      { job: 'document_rescan', ...summary },
      'documents still unscanned — scanner likely still unreachable'
    );
  }
  return summary;
}

async function readObject(minio: MinioClient, bucket: string, key: string): Promise<Buffer> {
  const stream = await minio.getObject(bucket, key);
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}
