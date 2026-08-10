#!/usr/bin/env node
// CLAUDE.md hard rule: "Tasks link to SOPs: task types carry an optional 'how to
// do this' link into the knowledge base; building a task-generating feature
// without its SOP hook is incomplete."
//
// "Incomplete" needs teeth, or it degrades into a comment nobody reads. This
// scans the API source for every `sourceType: '...'` literal — i.e. every task
// the system can generate — and fails the build if one is missing from
// TASK_TYPE_SOPS. The registry allows `sop: null`, so the rule is not "write an
// SOP for everything"; it is "decide, in writing, whether this needs one".
//
// Run via `npm run check:sops` (wired into `npm test`).

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SRC = join(ROOT, 'apps', 'api', 'src');
const REGISTRY = join(SRC, 'modules', 'sops', 'task-types.ts');

function* walk(dir) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) yield* walk(full);
    else if (/\.ts$/.test(entry)) yield full;
  }
}

// Registered keys, read straight out of the registry file so this check needs no
// TypeScript loader and cannot drift from what the app imports.
const registrySource = readFileSync(REGISTRY, 'utf8');
const registryBody = registrySource.slice(
  registrySource.indexOf('TASK_TYPE_SOPS'),
  registrySource.indexOf('/** Every registered task type. */')
);
const registered = new Set(
  [...registryBody.matchAll(/^\s{2}([a-z][a-z0-9_]*)\s*:\s*\{/gm)].map((m) => m[1])
);

if (registered.size === 0) {
  console.error('✖ Could not parse TASK_TYPE_SOPS — the checker needs updating alongside the registry.');
  process.exit(1);
}

// Every task type the code actually emits.
const emitted = new Map(); // type -> first file that emits it
for (const file of walk(SRC)) {
  if (file === REGISTRY) continue;
  const text = readFileSync(file, 'utf8');
  for (const m of text.matchAll(/sourceType:\s*'([a-z][a-z0-9_]*)'/g)) {
    if (!emitted.has(m[1])) emitted.set(m[1], relative(ROOT, file));
  }
}

const missing = [...emitted.entries()].filter(([type]) => !registered.has(type));
// A registry entry with no emitter is stale, not dangerous — report it, don't fail.
const unused = [...registered].filter((type) => !emitted.has(type) && type !== 'manual');

if (missing.length > 0) {
  console.error('✖ Task types generated in code but not registered in TASK_TYPE_SOPS.');
  console.error('  Each needs an SOP slug, or sop: null WITH a reason (see CLAUDE.md).\n');
  for (const [type, file] of missing) console.error(`  ${type}  —  first emitted in ${file}`);
  process.exit(1);
}

console.log(`✓ All ${emitted.size} generated task types are registered with an SOP decision.`);
if (unused.length > 0) {
  console.log(`  (note: ${unused.length} registered but not currently emitted: ${unused.join(', ')})`);
}
