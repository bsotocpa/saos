#!/usr/bin/env node
/*
 * BUILD GUARD: EVERY CREATE DOOR HAS AN EDIT DOOR, OR SAYS WHY NOT (Brian, 2026-09-20).
 *
 * The Businesses card could add a business and never correct one, and nothing failed: the API had
 * a PATCH, no screen called it, and the gap sat in the tree. This refuses that shape at build time.
 * scripts/edit-doors.mjs derives the inventory from the API's route registrations joined with
 * scripts/edit-doors.json; this prints one RED line per finding and exits non-zero:
 *
 *   - a POST route the registry does not classify (an entity, an action, a computation);
 *   - an entity Ops creates (createUi) with no update route that an Ops file calls (updateUi),
 *     unless it carries an "immutable because …" entry;
 *   - a claim the code contradicts: a createUi/updateUi file that does not call the route, a
 *     noCreateControl over a route some Ops screen calls, a route named here that is not registered.
 *
 * Run via `npm run check:edit-doors` (in the root `npm test` chain after check:task-inserts).
 */
import { derive } from './edit-doors.mjs';

const { rows, problems } = derive();
for (const p of problems) console.error(`RED ${p}`);
if (problems.length) process.exit(1);
console.log(`check:edit-doors — ${rows.length} entities: every create door has an edit door or says why not`);
