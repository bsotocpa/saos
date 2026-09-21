#!/usr/bin/env node
/*
 * THE EDIT-DOOR INVENTORY (Brian, 2026-09-20, edit after create).
 *
 * Every entity Ops can create must be editable from Ops too, or say in writing why it is not. The
 * inventory is derived, not composed: the API's own route registrations (app.post / app.patch /
 * app.put under apps/api/src/modules) are joined with scripts/edit-doors.json, which names each
 * entity's create and update routes, the Ops file that calls each, and — for the entities that are
 * not edited — why ("immutable because …"). Tapped evidence comes from the harness's run record,
 * apps/e2e/.artifacts/last-run.json, the way scripts/walk-evidence.mjs reads it: a spec that taps an
 * edit control pushes
 *
 *   testInfo.annotations.push({ type: 'edit-door', description: '<entity>|<control>|<roles>|tap' })
 *
 * and a passing tap at a viewport is "yes (file:line)" in that viewport's column.
 *
 * Prints one ` | `-joined row per entity for scripts/report-table.mjs --from-log (optionally --run <last-run.json copy>):
 *   entity | create route | update route | UI caller (file) | tapped phone | tapped desk | immutable because
 *
 * scripts/check-edit-doors.mjs imports the same derivation and turns its findings into RED lines.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
export const root = resolve(here, '..');
const MODULES = resolve(root, 'apps', 'api', 'src', 'modules');
const OPS = ['apps/internal/app', 'apps/internal/components', 'apps/internal/lib'].map((d) => resolve(root, d));

function* walk(dir, test) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = resolve(dir, e.name);
    if (e.isDirectory()) yield* walk(p, test);
    else if (test(e.name)) yield p;
  }
}

/** Every POST/PATCH/PUT registration in the API, as 'METHOD /path' with where it is registered. */
export function routeRegistrations() {
  const out = [];
  const re = /app\.(post|patch|put)(?:<[^>]*>)?\(\s*(['"`])([^'"`]+)\2/g;
  for (const f of walk(MODULES, (n) => n.endsWith('.ts'))) {
    const text = readFileSync(f, 'utf8');
    for (const m of text.matchAll(re)) {
      const line = text.slice(0, m.index).split('\n').length;
      out.push({ key: `${m[1].toUpperCase()} ${m[3]}`, method: m[1].toUpperCase(), path: m[3], file: `${relative(root, f).replace(/\\/g, '/')}:${line}` });
    }
  }
  return out;
}

/** The registry, read fresh each call so a sabotage on the file is seen. */
export function registry() {
  return JSON.parse(readFileSync(resolve(here, 'edit-doors.json'), 'utf8'));
}

/** A regex for the route's path as Ops writes it: `:id` becomes a `${…}` interpolation. */
function pathPattern(path) {
  const esc = path.split('/').map((seg) => (seg.startsWith(':') ? '\\$\\{[^}]+\\}' : seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))).join('/');
  return new RegExp(`(['"\`])${esc}\\1|\`${esc}(?:[?\`])`);
}

/** Whether `file` calls the route: the path literal, with the method named within the same api( call. */
export function fileCalls(file, key) {
  const [method, path] = key.split(' ');
  const abs = resolve(root, file);
  if (!existsSync(abs)) return false;
  const text = readFileSync(abs, 'utf8');
  const pat = pathPattern(path);
  let from = 0;
  for (;;) {
    const m = pat.exec(text.slice(from));
    if (!m) return false;
    const at = from + m.index;
    const window = text.slice(at, at + 400);
    if (new RegExp(`method:\\s*['"]${method}['"]`).test(window)) return true;
    from = at + 1;
  }
}

/** Every Ops file that calls the route (for checking a "no create control" claim). */
export function opsCallers(key) {
  const out = [];
  for (const d of OPS) for (const f of walk(d, (n) => /\.tsx?$/.test(n))) {
    const rel = relative(root, f).replace(/\\/g, '/');
    if (fileCalls(rel, key)) out.push(rel);
  }
  return out;
}

/** Passing edit-door taps from the last harness run, by entity and viewport. */
export function tapped() {
  // --run <file>: a kept copy of a run record, for a run another run has since overwritten (2026-09-20).
  const runIx = process.argv.indexOf('--run');
  const runFile = runIx > 0 ? resolve(process.argv[runIx + 1]) : resolve(root, 'apps', 'e2e', '.artifacts', 'last-run.json');
  const found = new Map();
  if (!existsSync(runFile)) return found;
  const run = JSON.parse(readFileSync(runFile, 'utf8'));
  const visit = (suite, file) => {
    for (const spec of suite.specs ?? []) {
      for (const test of spec.tests ?? []) {
        const status = test.results?.[test.results.length - 1]?.status ?? test.status;
        for (const a of test.annotations ?? []) {
          if (a.type !== 'edit-door') continue;
          const [entity, , , how] = String(a.description).split('|').map((s) => s.trim());
          if (how !== 'tap' || status !== 'passed') continue;
          if (!found.has(entity)) found.set(entity, {});
          found.get(entity)[test.projectName] = `yes (${file}:${spec.line})`;
        }
      }
    }
    for (const s of suite.suites ?? []) visit(s, file);
  };
  for (const s of run.suites ?? []) visit(s, `apps/e2e/tests/${s.file}`);
  return found;
}

/** The derivation: rows for the table and problems for the check. */
export function derive() {
  const reg = registry();
  const routes = routeRegistrations();
  const byKey = new Map(routes.map((r) => [r.key, r]));
  const problems = [];
  const rows = [];
  const taps = tapped();

  const classified = new Set([...reg.computations, ...reg.actions]);
  for (const e of reg.entities) { classified.add(e.create); if (e.update) classified.add(e.update); }
  for (const r of routes) {
    if (r.method !== 'POST') continue;
    if (Object.keys(reg.excluded).some((p) => r.path.startsWith(p))) continue;
    if (!classified.has(r.key)) problems.push(`${r.key} (${r.file}) is a POST route scripts/edit-doors.json does not classify: name its entity (create + update or immutable because …), or list it as an action or a computation`);
  }
  for (const k of [...reg.computations, ...reg.actions]) if (!byKey.has(k)) problems.push(`${k} is listed in scripts/edit-doors.json but no route registers it`);

  for (const e of reg.entities) {
    const create = byKey.get(e.create);
    if (!create) problems.push(`${e.entity}: create route ${e.create} is not registered`);
    const update = e.update ? byKey.get(e.update) : null;
    if (e.update && !update) problems.push(`${e.entity}: update route ${e.update} is not registered`);
    if (e.createUi && !fileCalls(e.createUi, e.create)) problems.push(`${e.entity}: ${e.createUi} does not call ${e.create}; the create control the registry names is not there`);
    if (e.noCreateControl) {
      const callers = opsCallers(e.create);
      if (callers.length) problems.push(`${e.entity}: the registry says no Ops screen creates one, but ${callers.join(', ')} calls ${e.create}`);
    }
    if (!e.createUi && !e.noCreateControl) problems.push(`${e.entity}: say where Ops creates one (createUi) or that nothing does (noCreateControl)`);
    let updateUiOk = false;
    if (e.updateUi) {
      updateUiOk = Boolean(update) && fileCalls(e.updateUi, e.update);
      if (!updateUiOk) problems.push(`${e.entity}: ${e.updateUi} does not call ${e.update}; the edit control the registry names is not there`);
    }
    if (e.createUi && !e.immutable && !updateUiOk) {
      problems.push(`${e.entity}: Ops creates one (${e.createUi}) and cannot edit it — no update route with a UI caller, and no "immutable because …" entry`);
    }
    const t = taps.get(e.entity) ?? {};
    const why = e.immutable ? `immutable because ${e.immutable}` : e.noCreateControl ? `no create control in Ops: ${e.noCreateControl}` : '';
    rows.push([
      e.entity,
      `${e.create}${create ? ` (${create.file})` : ' (NOT REGISTERED)'}`,
      e.update ? `${e.update}${update ? ` (${update.file})` : ' (NOT REGISTERED)'}` : '—',
      e.updateUi ?? (e.createUi ? `create only: ${e.createUi}` : '—'),
      e.updateUi ? (t.phone ?? 'no') : '—',
      e.updateUi ? (t.desk ?? 'no') : '—',
      why,
    ]);
  }
  return { rows, problems };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { rows } = derive();
  const header = ['entity', 'create route', 'update route', 'UI caller (file)', 'tapped phone', 'tapped desk', 'immutable because'];
  process.stdout.write([header, ...rows].map((r) => r.map((c) => String(c ?? '').replace(/\|/g, '/')).join(' | ')).join('\n') + '\n');
}
