// MinIO storage layer. Buckets are private; bytes move ONLY through the API
// (auth + audit on every access — WISP). Streamed, not presigned: presigned
// URLs would bypass the audit path and require exposing MinIO publicly.

import { Client as MinioClient } from 'minio';
import { randomUUID } from 'node:crypto';
import type { Config } from '../../config.ts';

/** Bucket per document family (created by the compose minio-init job). */
export const BUCKET_BY_CATEGORY: Record<string, string> = {
  tax_documents: 'saos-documents',
  business_records: 'saos-documents',
  id_verification: 'saos-documents',
  irs_notices: 'saos-documents',
  other: 'saos-documents',
  financial_statements: 'saos-documents', // books-close statements (v4.3 flow 5)
  signed_authorizations: 'saos-signed-docs',
  return_deliverable: 'saos-returns',
  recording: 'saos-recordings',
};

/** Accepted upload types — documents, photos, spreadsheets, and session audio. */
export const ALLOWED_MIME_TYPES = new Set([
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/heic',
  'image/heif',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'text/csv',
  'text/plain',
  // Meeting recordings (M17): MediaRecorder/voice-memo formats.
  'audio/webm',
  'audio/mp4',
  'audio/mpeg',
  'audio/wav',
  'audio/x-wav',
  'audio/ogg',
  'video/mp4',
  'video/webm',
]);

export function makeMinioClient(config: Config): MinioClient {
  return new MinioClient({
    endPoint: config.MINIO_ENDPOINT,
    port: config.MINIO_PORT,
    useSSL: config.MINIO_USE_SSL,
    accessKey: config.MINIO_ROOT_USER,
    secretKey: config.MINIO_ROOT_PASSWORD,
  });
}

/** Object key: per-contact prefix, collision-proof, original name preserved (sanitized). */
export function objectKey(contactId: string, category: string, filename: string): string {
  const safe = filename.replace(/[^\w.\-]+/g, '_').slice(-100);
  return `${contactId}/${category}/${randomUUID()}-${safe}`;
}
