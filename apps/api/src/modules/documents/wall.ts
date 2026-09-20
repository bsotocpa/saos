/*
 * THE §7216 WALL, DOCUMENTS (phase 2, 2026-09-12, Brian's ruling 4: "category and field filtering").
 *
 * `documents.read` opens the document routes. WHICH categories a reader sees is a second,
 * named grant, and the grants are checked in the query and in the download, never in the UI:
 *
 *   documents.read.all           every category (tax_preparer, bookkeeper; the CEO through '*')
 *   documents.read.entity        entity filings only: formation papers, SOS filings, EIN letters,
 *                                annual reports (va_entity, Laura)
 *   documents.read.relationship  everything that is not return-adjacent (ed_coo, Jaqueline): not
 *                                tax documents, not IRS notices, not signed authorizations, not
 *                                return deliverables — and not recordings, because a recording IS
 *                                a session and sessions are governed by the meetings wall.
 *
 * documents.read with no scope grant reads nothing. Fail closed: a document outside the reader's
 * categories is the same 404 as a document that does not exist.
 */
import type { AuthedStaff } from '../../types.ts';
import { holds } from '../../plugins/auth.ts';

/** Every value of the document_category enum (migrations 0004, 0009, 0024, 0094, 0113). */
export const DOCUMENT_CATEGORY_VALUES = [
  'tax_documents',
  'business_records',
  'id_verification',
  'irs_notices',
  'signed_authorizations',
  'return_deliverable',
  'other',
  'recording',
  'financial_statements',
  'entity_filings',
  // 0113: the receipt for a paper filing's certified mailing (ruling 15).
  'mailing_receipts',
] as const;
export type DocumentCategoryValue = (typeof DOCUMENT_CATEGORY_VALUES)[number];

/** Return-adjacent: the §7216 wall proper. */
export const RETURN_ADJACENT_CATEGORIES: readonly DocumentCategoryValue[] = [
  // A mailing receipt is proof of a FILING: it names the return, the year and the agency, which is
  // return-adjacent by the same reasoning as the signed authorization it travelled with.
  'tax_documents', 'irs_notices', 'signed_authorizations', 'return_deliverable', 'mailing_receipts',
];
export const ENTITY_CATEGORIES: readonly DocumentCategoryValue[] = ['entity_filings'];
export const RELATIONSHIP_CATEGORIES: readonly DocumentCategoryValue[] = DOCUMENT_CATEGORY_VALUES.filter(
  (c) => !RETURN_ADJACENT_CATEGORIES.includes(c) && c !== 'recording'
);

export const DOCUMENT_READ_GATE = 'documents.read';
export const DOCUMENT_SCOPE_GRANTS = {
  all: 'documents.read.all',
  entity: 'documents.read.entity',
  relationship: 'documents.read.relationship',
} as const;

/**
 * The categories this reader may see. `null` means unrestricted; an empty array means the gate
 * was passed with no scope grant behind it, and every query below must return nothing.
 */
export function readableCategories(staff: AuthedStaff): readonly DocumentCategoryValue[] | null {
  if (holds(staff, DOCUMENT_SCOPE_GRANTS.all)) return null;
  const out = new Set<DocumentCategoryValue>();
  if (holds(staff, DOCUMENT_SCOPE_GRANTS.entity)) for (const c of ENTITY_CATEGORIES) out.add(c);
  if (holds(staff, DOCUMENT_SCOPE_GRANTS.relationship)) for (const c of RELATIONSHIP_CATEGORIES) out.add(c);
  return [...out];
}

export function canReadCategory(staff: AuthedStaff, category: string): boolean {
  const cats = readableCategories(staff);
  return cats === null || (cats as readonly string[]).includes(category);
}
