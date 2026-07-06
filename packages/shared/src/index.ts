// Shared vocabulary for SAOS apps. These mirror the PostgreSQL enums created in
// packages/db/migrations — if a value changes here it changes there via a
// migration, never independently.

/** Client-facing languages. Every client-facing string ships in both. */
export type Language = 'en' | 'es';
export const LANGUAGES: readonly Language[] = ['en', 'es'] as const;

/** Tax pipeline stages (MP: Tax Operations → Pipeline). Order matters. */
export const TAX_PIPELINE_STAGES = [
  'intake_started',
  'scheduled',
  'documents_requested',
  'pending_client_response',
  'in_preparation',
  'internal_review',
  'client_review',
  'ready_to_file',
  'filed',
  'completed',
  'on_hold',
  'withdrawn',
] as const;
export type TaxPipelineStage = (typeof TAX_PIPELINE_STAGES)[number];

/** Service lines an engagement can carry (MP: The Business → Services). */
export const SERVICE_LINES = [
  'tax',
  'bookkeeping',
  'payroll',
  'sales_tax',
  'advisory',
  'coo',
  'entity',
  'attest',
  'specialized_cpa',
  'nonprofit_cfo',
] as const;
export type ServiceLine = (typeof SERVICE_LINES)[number];

/** Return types SAOS tracks (prep itself happens in ATX). */
export const RETURN_TYPES = [
  '1040',
  '1065',
  '1120s',
  '1120',
  '990',
  '990ez',
  '1120c',
  '1120f',
  '1120h',
  '1120pol',
  'w7_itin',
] as const;
export type ReturnTypeCode = (typeof RETURN_TYPES)[number];

/** Portal document-upload categories (MP: Client Portal → Document Center). */
export const DOCUMENT_CATEGORIES = [
  'tax_documents',
  'business_records',
  'id_verification',
  'irs_notices',
  'signed_authorizations',
  'return_deliverable',
  'other',
] as const;
export type DocumentCategory = (typeof DOCUMENT_CATEGORIES)[number];
