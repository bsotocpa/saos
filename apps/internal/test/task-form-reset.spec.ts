/*
 * THE TASK FORM KEEPS WHAT WAS TYPED (receipt run 21, 2026-09-27).
 *
 * The harness's phone walk typed a subject into Create Task and pressed Save; the form refused
 * "Subject is required." with the box empty. The form is filled by its useState initializer, and an
 * effect refilled it on mount as well — after paint, so on a slow phone the refill landed after the
 * typing and wiped it. The effect now refills only when the record or the person changes. Checked in
 * the source, because the front end has no render harness here (the harness walk is the live proof).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const form = readFileSync(new URL('../app/tasks/task-form.tsx', import.meta.url), 'utf8');

test('the form refills only when the task or the person changes, never on mount', () => {
  const effect = /useEffect\(\(\) => \{\s*if \(shownFor\.current\.task === props\.task && shownFor\.current\.meId === props\.meId\) return;\s*shownFor\.current = \{ task: props\.task, meId: props\.meId \};\s*setForm\(fromTask\(props\.task, props\.meId\)\);\s*\}, \[props\.task, props\.meId\]\);/;
  assert.match(form, effect, 'the refill is guarded by what the form was last filled for');
  assert.match(form, /const shownFor = useRef\(\{ task: props\.task, meId: props\.meId \}\);/, 'starting from what the initializer filled');
  assert.match(form, /useState<FormState>\(\(\) => fromTask\(props\.task, props\.meId\)\)/, 'the initializer fills it on mount');
});
