/*
 * ATX "E-Files" export rows for the specs (R43, 2026-09-26). The header and the value vocabularies are
 * the real export's, as documented in test/fixtures/atx/README.md; the committed fixture there is the
 * whole shape. Every identifier a spec writes starts with 900, which the SSA never issues.
 */
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

export const ATX_HEADER =
  'Return Name,Client #,Complete,SSN/EIN,E-file ID,Jurisdiction,Type,Sub Type,Status,Status Date,PIN Status,Refund Amount,Refund Type,Signature,EIC Indicator,Processing Site';

export type AtxStatus =
  | 'Accepted' | 'AcceptedWithMessages' | 'Created' | 'Held' | 'TransmittedToAgency'
  | 'RejectedByAgency' | 'RejectedByEfc' | 'RejectedByUser';

let seq = 0;

/**
 * One row. `id` is the nine-digit SSN/EIN as the export prints it (optionally with the leading
 * apostrophe); `last4` builds a synthetic 900-prefixed identifier ending in those digits instead.
 * `when` is the Central status date, "M/D/YYYY h:mm:ss AM/PM" (default 9/19/2026 5:00:00 PM).
 */
export function atxRow(o: {
  name: string;
  id?: string;
  last4?: string;
  jurisdiction: 'Federal' | string;
  type: string;
  subType?: 'Federal' | 'Return' | 'Extension' | 'Amended';
  status: AtxStatus;
  when?: string;
  efileId?: string;
}): string {
  const id = o.id ?? `90000${(o.last4 ?? '0000').padStart(4, '0')}`;
  const sub = o.subType ?? (o.jurisdiction === 'Federal' ? 'Federal' : 'Return');
  const efileId = o.efileId ?? `${String(++seq).padStart(4, '0')}syn${Math.random().toString(36).slice(2, 12)}`;
  const q = (s: string) => (/[",]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  return [q(o.name), '', '', id, efileId, o.jurisdiction, o.type, sub, o.status, o.when ?? '9/19/2026 5:00:00 PM', 'TBD', '0', 'Zero Balance', '', '0', 'Ogden'].join(',');
}

/** A whole export: the header (with the BOM the real file carries) and the rows. */
export function atxReport(rows: string[]): string {
  return `﻿${ATX_HEADER}\n${rows.join('\n')}\n`;
}

/** The committed synthetic fixture, as the real file is: UTF-8 with BOM. */
export function atxFixture(): string {
  return readFileSync(resolve(here, 'fixtures', 'atx', 'ATX_EFiles_synthetic.csv'), 'utf8');
}
