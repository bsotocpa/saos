/*
 * THE RETURN'S STATUS AS THE CLIENT READS IT (Brian, 2026-09-27, R84).
 *
 *   A filed or completed return reads "Filed. Accepted by the IRS on <date>. Accepted by Illinois on
 *   <date>." (or "Mailed to Illinois on <date>."): what each jurisdiction answered, never a deadline,
 *   and no Extended badge once it is filed.
 *   The progress bar is the five phases the firm works in (Engage, Prepare, Sign, File, Close, the
 *   Ops rail's R50 phases), read from the return's stage.
 *
 * No imports: the words come from the page's own dictionary, so this file is plain rules a test reads.
 */

export const PHASES = ['engage', 'prepare', 'sign', 'file', 'close'] as const;
export type Phase = (typeof PHASES)[number];

/** The stage's phase. On hold and anything unknown sit on no phase (no bar). */
const STAGE_PHASE: Record<string, Phase> = {
  intake_started: 'engage', scheduled: 'engage',
  documents_requested: 'prepare', pending_client_response: 'prepare', in_preparation: 'prepare', internal_review: 'prepare',
  client_review: 'sign',
  ready_to_file: 'file', filed: 'file', rejected: 'file',
  completed: 'close',
};

/** Per phase: done, current, or ahead. A completed return has every phase done. */
export function phaseStates(stage: string): Array<{ phase: Phase; state: 'done' | 'current' | 'ahead' }> | null {
  const at = STAGE_PHASE[stage];
  if (!at) return null;
  const i = PHASES.indexOf(at);
  return PHASES.map((phase, j) => ({
    phase,
    state: stage === 'completed' || j < i ? 'done' : j === i ? 'current' : 'ahead',
  }));
}

/** Filed or completed: the return's status is its answers, not a deadline, and it is no longer "extended". */
export function isFiled(stage: string | null): boolean {
  return stage === 'filed' || stage === 'completed';
}

export interface AnswerLine { jurisdiction: string; kind: 'accepted' | 'mailed'; answered_on: string }

/**
 * A filed return's status line from its answers: "Filed." then one sentence per answer, or the
 * waiting sentence while none has answered. `sentence` renders one answer in the reader's language.
 */
export function filedStatus(lines: readonly AnswerLine[], words: { filed: string; waiting: string }, sentence: (l: AnswerLine) => string): string {
  if (lines.length === 0) return words.waiting;
  return [words.filed, ...lines.map(sentence)].join(' ');
}
