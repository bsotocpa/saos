#!/usr/bin/env node
/*
 * NO FULL IDENTIFIER PERSISTS FROM AN ATX E-FILE EXPORT (Brian, 2026-09-26, R63, the guard half).
 *
 * The 2026-09-20 upload stored the firm's E-Files.csv verbatim: five hundred full SSNs and EINs in
 * efile_ack_reports.raw_text. R43 rebuilt the ingest so the file is masked before the INSERT
 * (maskIdentifiers, efile-ack.ts) and the per-row record carries the LAST FOUR only
 * (efile_acknowledgments.taxpayer_last4). That is a convention until something refuses the tree
 * that undoes it; this check is that refusal, in the root chain (`npm test`), before any receipt.
 *
 * Three rules, read from the source and the migrations, never from a running database:
 *
 *   (a) every INSERT or UPDATE that writes efile_ack_reports.raw_text binds it to a `$n`
 *       placeholder whose parameter is `maskIdentifiers(...)`. A raw_text written from anything
 *       else (the bare upload text, a SQL expression, a shape the check cannot read) is RED.
 *   (b) no INSERT or UPDATE into efile_acknowledgments names a column that would hold a full
 *       identifier (ssn, ein, tin, itin, taxpayer_*, identifier, id_number, social) other than
 *       taxpayer_last4.
 *   (c) no migration gives either table such a column: every CREATE TABLE column, ADD COLUMN and
 *       RENAME COLUMN target on efile_ack_reports / efile_acknowledgments is read, and one named
 *       like an identifier, other than taxpayer_last4, is RED.
 *
 * The check also goes RED when its anchors move: a source file missing, no raw_text write found at
 * all, a write whose parameters it cannot pair with the SQL, or a table whose CREATE TABLE it cannot
 * find — a guard that finds nothing is a guard on nothing.
 *
 * Output: one `RED <reason>` line per finding and exit 1; `ack-identifiers: ok (...)` and exit 0.
 * Sabotaged by scripts/sabotages/2026-09-26-g.mjs (the mask removed from the raw_text INSERT).
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, '..');

export const SOURCES = ['apps/api/src/modules/tax/efile-ack.ts', 'apps/api/src/modules/tax/efile-ack-routes.ts'];
export const MIGRATIONS_DIR = 'packages/db/migrations';
export const REPORTS = 'efile_ack_reports';
export const ACKS = 'efile_acknowledgments';
export const LAST_FOUR = 'taxpayer_last4';
export const MASK_CALL = 'maskIdentifiers(';
/** A column name that would hold a full identifier. taxpayer_last4 is exempted by name, nothing else is. */
export const IDENTIFIER_COLUMN = /(^|_)(ssn|ein|tin|itin)(_|$)|taxpayer|identifier|id_number|social/i;
const CONSTRAINT_WORDS = new Set(['UNIQUE', 'PRIMARY', 'CONSTRAINT', 'CHECK', 'FOREIGN', 'EXCLUDE', 'LIKE']);

const isIdentifierColumn = (name) => name.toLowerCase() !== LAST_FOUR && IDENTIFIER_COLUMN.test(name);

/** Whole-line slash-slash comments and block comments removed, so a backtick in prose is not read as SQL. */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' ')).replace(/^\s*\/\/.*$/gm, '');
}

/** Read a template literal starting at the backtick at `i`; returns [text, indexAfterClosingBacktick]. */
function readTemplate(src, i) {
  let j = i + 1;
  let depth = 0;
  let out = '';
  while (j < src.length) {
    const ch = src[j];
    if (ch === '\\') { out += ch + (src[j + 1] ?? ''); j += 2; continue; }
    if (depth === 0 && ch === '`') return [out, j + 1];
    if (ch === '$' && src[j + 1] === '{') { depth++; out += '${'; j += 2; continue; }
    if (depth > 0 && ch === '}') { depth--; out += ch; j++; continue; }
    out += ch; j++;
  }
  return [out, j];
}

/** Read a bracketed array literal starting at `[` at index i; returns [innerText, indexAfterClosingBracket]. */
function readArray(src, i) {
  let j = i + 1;
  let depth = 0;
  let quote = null;
  const start = j;
  while (j < src.length) {
    const ch = src[j];
    if (quote) {
      if (ch === '\\') { j += 2; continue; }
      if (ch === quote) quote = null;
      j++; continue;
    }
    if (ch === '\'' || ch === '"' || ch === '`') { quote = ch; j++; continue; }
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === '}') depth--;
    else if (ch === ']') { if (depth === 0) return [src.slice(start, j), j + 1]; depth--; }
    j++;
  }
  return [src.slice(start), j];
}

/** Split on commas at nesting depth zero (parentheses, brackets, braces, quotes respected). */
function splitTopLevel(text) {
  const parts = [];
  let depth = 0;
  let quote = null;
  let cur = '';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      cur += ch;
      if (ch === '\\') { cur += text[i + 1] ?? ''; i++; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '\'' || ch === '"' || ch === '`') { quote = ch; cur += ch; continue; }
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    if (ch === ')' || ch === ']' || ch === '}') depth--;
    if (ch === ',' && depth === 0) { parts.push(cur.trim()); cur = ''; continue; }
    cur += ch;
  }
  if (cur.trim()) parts.push(cur.trim());
  return parts;
}

const lineOf = (src, index) => src.slice(0, index).split('\n').length;

/**
 * Every `.query(` call in a source: its SQL template literal and its parameter array (null when the
 * call carries no array literal, or the SQL is not a template literal right there).
 */
function queryCalls(src) {
  const calls = [];
  const re = /\.query\s*(?:<[^()]*?>)?\s*\(/g;
  let m;
  while ((m = re.exec(src))) {
    let i = m.index + m[0].length;
    while (i < src.length && /\s/.test(src[i])) i++;
    if (src[i] !== '`') { calls.push({ line: lineOf(src, m.index), sql: null, params: null }); continue; }
    const [sql, after] = readTemplate(src, i);
    let k = after;
    while (k < src.length && /\s/.test(src[k])) k++;
    let params = null;
    if (src[k] === ',') {
      k++;
      while (k < src.length && /\s/.test(src[k])) k++;
      if (src[k] === '[') params = splitTopLevel(readArray(src, k)[0]);
    }
    calls.push({ line: lineOf(src, m.index), sql, params });
  }
  return calls;
}

/** The statements in a SQL text that INSERT into or UPDATE one of the two tables. */
function writesIn(sql) {
  const out = [];
  const re = new RegExp(String.raw`\b(INSERT\s+INTO|UPDATE)\s+(${REPORTS}|${ACKS})\b`, 'gi');
  let m;
  while ((m = re.exec(sql))) out.push({ kind: /^INSERT/i.test(m[1]) ? 'INSERT' : 'UPDATE', table: m[2].toLowerCase(), at: m.index });
  return out;
}

/** The `$n` a bare placeholder (with an optional cast) names, else null. */
const placeholderIndex = (value) => {
  const m = /^\$(\d+)(?:::[\w\s]+)?$/.exec(value.trim());
  return m ? Number(m[1]) : null;
};

/** INSERT (cols) VALUES (vals): the two lists, or null when the statement is not that shape. */
function insertLists(sql, at) {
  const m = /^\s*INSERT\s+INTO\s+\w+\s*\(([^)]*)\)\s*VALUES\s*\(([\s\S]*?)\)/i.exec(sql.slice(at));
  if (!m) return null;
  return { columns: m[1].split(',').map((c) => c.trim()).filter(Boolean), values: splitTopLevel(m[2]) };
}

/** UPDATE t SET a = x, b = y WHERE ...: the SET assignments as [target, value] pairs. */
function updateAssignments(sql, at) {
  const rest = sql.slice(at);
  const m = /^\s*UPDATE\s+\w+\s+SET\s+([\s\S]*?)(\s+WHERE\b|\s+RETURNING\b|$)/i.exec(rest);
  if (!m) return null;
  return splitTopLevel(m[1]).map((piece) => {
    const eq = /^(\w+)\s*=\s*([\s\S]*)$/.exec(piece.trim());
    return eq ? [eq[1], eq[2].trim()] : [piece.trim(), ''];
  });
}

export function checkSources(root = ROOT) {
  const red = [];
  let rawTextWrites = 0;
  let ackWrites = 0;
  for (const rel of SOURCES) {
    const path = resolve(root, rel);
    if (!existsSync(path)) { red.push(`${rel}: source file missing; the guard's anchor moved`); continue; }
    const src = stripComments(readFileSync(path, 'utf8'));
    const calls = queryCalls(src);
    const seenInCalls = new Set();
    for (const call of calls) {
      if (!call.sql) continue;
      for (const w of writesIn(call.sql)) {
        seenInCalls.add(`${call.line}:${w.at}`);
        const where = `${rel}:${call.line}`;
        if (w.table === REPORTS) {
          const mentionsRaw = /\braw_text\b/i.test(call.sql.slice(w.at));
          if (!mentionsRaw) continue;
          rawTextWrites++;
          let value = null;
          if (w.kind === 'INSERT') {
            const lists = insertLists(call.sql, w.at);
            if (!lists) { red.push(`${where}: INSERT into ${REPORTS} writes raw_text in a shape this check cannot read (not (columns) VALUES (...)); masking unproven`); continue; }
            const ix = lists.columns.findIndex((c) => c.toLowerCase() === 'raw_text');
            value = ix >= 0 ? (lists.values[ix] ?? '') : null;
          } else {
            const sets = updateAssignments(call.sql, w.at);
            if (!sets) { red.push(`${where}: UPDATE ${REPORTS} writes raw_text in a shape this check cannot read; masking unproven`); continue; }
            const hit = sets.find(([target]) => target.toLowerCase() === 'raw_text');
            value = hit ? hit[1] : null;
          }
          if (value === null) continue; // raw_text named only in WHERE/RETURNING: not a write of it
          const n = placeholderIndex(value);
          if (n === null) { red.push(`${where}: ${REPORTS}.raw_text is written from the SQL expression \`${value}\`, not from a maskIdentifiers(...) parameter`); continue; }
          const param = call.params?.[n - 1];
          if (param === undefined) { red.push(`${where}: ${REPORTS}.raw_text is bound to $${n} but no parameter array literal follows the SQL; masking unproven`); continue; }
          if (!param.includes(MASK_CALL)) red.push(`${where}: ${REPORTS}.raw_text is written whole — parameter $${n} is \`${param}\`, not maskIdentifiers(...)`);
        } else {
          ackWrites++;
          const columns = w.kind === 'INSERT'
            ? insertLists(call.sql, w.at)?.columns
            : updateAssignments(call.sql, w.at)?.map(([t]) => t);
          if (!columns) { red.push(`${where}: ${w.kind} on ${ACKS} in a shape this check cannot read; its columns are unproven`); continue; }
          for (const c of columns) if (isIdentifierColumn(c)) red.push(`${where}: ${w.kind} on ${ACKS} names column ${c}, which would hold a full identifier; only ${LAST_FOUR} may`);
        }
      }
    }
    // A write held outside any .query( call (a SQL constant, a helper) is one whose parameters cannot be paired.
    for (const [i, ch] of [...src].entries()) {
      if (ch !== '`') continue;
      const [text] = readTemplate(src, i);
      for (const w of writesIn(text)) {
        const line = lineOf(src, i);
        const inCall = calls.some((c) => c.sql === text);
        if (!inCall) red.push(`${rel}:${line}: ${w.kind} on ${w.table} sits outside a .query(sql, [params]) call; its parameters cannot be paired with the SQL`);
      }
    }
  }
  if (rawTextWrites === 0 && red.length === 0) red.push(`no write of ${REPORTS}.raw_text found in ${SOURCES.join(', ')}; the guard's anchor moved`);
  return { red, rawTextWrites, ackWrites };
}

export function checkMigrations(root = ROOT) {
  const red = [];
  const dir = resolve(root, MIGRATIONS_DIR);
  const found = { [REPORTS]: false, [ACKS]: false };
  let columns = 0;
  for (const f of readdirSync(dir).sort()) {
    if (!/\.(js|mjs|cjs|ts|sql)$/.test(f)) continue;
    const src = readFileSync(resolve(dir, f), 'utf8');
    if (!src.includes(REPORTS) && !src.includes(ACKS)) continue;
    for (const table of [REPORTS, ACKS]) {
      const create = new RegExp(String.raw`CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?${table}\s*\(`, 'gi');
      let m;
      while ((m = create.exec(src))) {
        found[table] = true;
        // The body up to the parenthesis that closes the column list.
        let depth = 1, j = m.index + m[0].length;
        const start = j;
        while (j < src.length && depth > 0) { if (src[j] === '(') depth++; else if (src[j] === ')') depth--; j++; }
        const body = src.slice(start, j - 1);
        for (const piece of splitTopLevel(body.replace(/--[^\n]*/g, ''))) {
          const name = /^\s*(\w+)/.exec(piece)?.[1];
          if (!name || CONSTRAINT_WORDS.has(name.toUpperCase())) continue;
          columns++;
          if (isIdentifierColumn(name)) red.push(`${MIGRATIONS_DIR}/${f}: CREATE TABLE ${table} declares column ${name}, which would hold a full identifier; only ${LAST_FOUR} may`);
        }
      }
      const alter = new RegExp(String.raw`ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?${table}\b([\s\S]*?);`, 'gi');
      while ((m = alter.exec(src))) {
        found[table] = true;
        const stmt = m[1];
        const adds = [...stmt.matchAll(/ADD\s+COLUMN\s+(?:IF\s+NOT\s+EXISTS\s+)?(\w+)/gi)].map((a) => a[1]);
        const renames = [...stmt.matchAll(/RENAME\s+(?:COLUMN\s+)?\w+\s+TO\s+(\w+)/gi)].map((a) => a[1]);
        for (const name of [...adds, ...renames]) {
          columns++;
          if (isIdentifierColumn(name)) red.push(`${MIGRATIONS_DIR}/${f}: ALTER TABLE ${table} adds column ${name}, which would hold a full identifier; only ${LAST_FOUR} may`);
        }
      }
    }
  }
  for (const table of [REPORTS, ACKS]) if (!found[table]) red.push(`${MIGRATIONS_DIR}: no CREATE TABLE or ALTER TABLE for ${table} found; the guard's anchor moved`);
  return { red, columns };
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const s = checkSources();
  const m = checkMigrations();
  const red = [...s.red, ...m.red];
  for (const r of red) console.log(`RED ${r}`);
  if (red.length > 0) process.exit(1);
  console.log(`ack-identifiers: ok (${s.rawTextWrites} raw_text write(s) masked, ${s.ackWrites} ${ACKS} write(s) with no identifier column, ${m.columns} migration column(s) read)`);
}
