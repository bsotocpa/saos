// Minimal RFC 4180 CSV reader for the M22 legacy imports. Handles quoted
// fields, escaped quotes (""), embedded commas/newlines, CRLF, and a UTF-8
// BOM. No dependency: the export files are trusted operator input, but the
// parsing still has to be exact — a shifted column in a client import is a
// data-integrity incident.

export function parseCsv(text: string): string[][] {
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      row.push(field);
      field = '';
      rows.push(row);
      row = [];
    } else {
      field += ch;
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  // Drop fully-empty trailing lines (editors love adding them).
  return rows.filter((r) => r.some((c) => c.trim() !== ''));
}

/** Rows as objects keyed by the header row. Duplicate headers keep the first. */
export function parseCsvObjects(text: string): Array<Record<string, string>> {
  const rows = parseCsv(text);
  const header = rows[0];
  if (!header) return [];
  return rows.slice(1).map((cells) => {
    const obj: Record<string, string> = {};
    header.forEach((name, i) => {
      const key = name.trim();
      if (key !== '' && !(key in obj)) obj[key] = (cells[i] ?? '').trim();
    });
    return obj;
  });
}
