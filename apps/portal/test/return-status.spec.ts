// R84 (Brian, 2026-09-27): the portal return status. A filed return reads what each jurisdiction
// answered, never a deadline; the Extended badge goes once filed; the bar is the five phases.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { filedStatus, isFiled, phaseStates, type AnswerLine } from '../lib/return-status.ts';

const states = (stage: string) => phaseStates(stage)?.map((p) => `${p.phase}:${p.state}`).join(' ') ?? null;

test('the bar is the five phases, read from the stage', () => {
  assert.equal(states('intake_started'), 'engage:current prepare:ahead sign:ahead file:ahead close:ahead');
  assert.equal(states('pending_client_response'), 'engage:done prepare:current sign:ahead file:ahead close:ahead');
  assert.equal(states('client_review'), 'engage:done prepare:done sign:current file:ahead close:ahead');
  assert.equal(states('filed'), 'engage:done prepare:done sign:done file:current close:ahead');
  assert.equal(states('completed'), 'engage:done prepare:done sign:done file:done close:done', 'a completed return has every phase done');
  assert.equal(states('on_hold'), null, 'on hold sits on no phase: no bar');
});

test('filed or completed is filed: no deadline, no Extended badge', () => {
  assert.equal(isFiled('filed'), true);
  assert.equal(isFiled('completed'), true);
  assert.equal(isFiled('ready_to_file'), false);
  assert.equal(isFiled(null), false);
});

test('a filed return reads "Filed." and each answer, or that the answer is awaited', () => {
  const lines: AnswerLine[] = [
    { jurisdiction: 'federal', kind: 'accepted', answered_on: '2026-09-27' },
    { jurisdiction: 'IL', kind: 'mailed', answered_on: '2026-09-28' },
  ];
  const words = { filed: 'Filed.', waiting: 'Filed. Waiting for the acceptance.' };
  const say = (l: AnswerLine) => `${l.kind} ${l.jurisdiction} ${l.answered_on}.`;
  assert.equal(filedStatus(lines, words, say), 'Filed. accepted federal 2026-09-27. mailed IL 2026-09-28.');
  assert.equal(filedStatus([], words, say), 'Filed. Waiting for the acceptance.');
});
