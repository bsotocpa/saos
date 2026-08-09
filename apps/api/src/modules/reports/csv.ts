// RFC 4180 CSV writer for report export. Zero dependencies (MP vendor rule: no
// library gets added for something this small).
//
// Two choices worth stating:
//
//  · MONEY IS EMITTED AS DECIMAL DOLLARS, not cents. Internally every amount is
//    an integer number of cents, which is right for arithmetic and wrong for a
//    spreadsheet: a raw cents integer under a column headed "Collected" reads as
//    a figure a hundred times larger to whoever opens the file. The header keeps
//    its plain label and the value is divided down to two decimal places.
//
//  · A LEADING =, +, -, @, TAB or CR IN A TEXT CELL IS PREFIXED WITH A SINGLE
//    QUOTE. Excel and Sheets treat those as formulas, so a client note starting
//    with "=" becomes executable content in the recipient's spreadsheet. Client
//    names and notes reach these files, so the export sanitizes rather than
//    trusting that no client is ever called "-Smith".

import type { ReportColumn } from './service.ts';

const FORMULA_TRIGGERS = /^[=+\-@\t\r]/;

function cell(value: unknown, type: ReportColumn['type']): string {
  if (value === null || value === undefined) return '';

  if (type === 'money') {
    const cents = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(cents)) return '';
    return (cents / 100).toFixed(2);
  }
  if (type === 'int') {
    const n = typeof value === 'number' ? value : Number(value);
    return Number.isFinite(n) ? String(n) : '';
  }

  let s = String(value);
  if (FORMULA_TRIGGERS.test(s)) s = `'${s}`;
  return s;
}

function quote(s: string): string {
  // Quote when the field contains a delimiter, quote, or newline; double any
  // embedded quotes. Fields are otherwise emitted bare.
  return /[",\r\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}

export function toCsv(
  columns: ReportColumn[],
  rows: Array<Record<string, unknown>>
): string {
  const lines: string[] = [];
  lines.push(columns.map((c) => quote(c.label)).join(','));
  for (const row of rows) {
    lines.push(columns.map((c) => quote(cell(row[c.key], c.type))).join(','));
  }
  // CRLF per RFC 4180, plus a trailing newline so the file ends cleanly.
  return `${lines.join('\r\n')}\r\n`;
}

/** Safe, descriptive download name: report key + the range it covers. */
export function csvFilename(key: string, from: string, to: string, snapshot: boolean): string {
  const scope = snapshot ? `asof-${to}` : `${from}_to_${to}`;
  return `saos-${key.replaceAll('_', '-')}-${scope}.csv`;
}
