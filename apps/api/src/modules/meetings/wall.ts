/*
 * THE §7216 WALL, SESSIONS (phase 2, 2026-09-12, Brian's ruling 2 on Jaqueline's grants).
 *
 * `meetings.read` opens the session routes, SCOPED: a reader sees a session when they are its
 * named participant or the session is a Hilo session. `meetings.read.all` lifts the scope
 * (tax_preparer; the CEO through '*'). A CPA session with a Soto client is return-adjacent and
 * stays behind the wall for everyone else, transcript, summary, recap and detail alike.
 *
 * What the data can say today, and what this module therefore means by its two words:
 *
 *   named participant  meetings.staff_id — the staffer who recorded or uploaded the session. It
 *                      is the only staff column a session has; a second attendee is not recorded
 *                      anywhere, so a session someone else uploaded with Jaqueline in the room is
 *                      NOT hers by this rule. Reported as a limit, not hidden.
 *   Hilo session       the client is a Hilo participant and not a Soto client (the pipeline's own
 *                      pro-bono test, pipeline.ts), OR the session was recorded by the Hilo
 *                      Executive Director (role ed_coo). A meeting with no client and no staffer
 *                      (a Zoom webhook row) is neither, and stays unscoped-only.
 *
 * Applied in every read: the client's session list, the transcript, the detail, the recap queue,
 * recap drafting, and the Hilo dashboard's recent summaries. Fail closed: out of scope is the
 * same 404 as nonexistent.
 */
import type { AuthedStaff } from '../../types.ts';
import { holds } from '../../plugins/auth.ts';

export const MEETING_READ_GATE = 'meetings.read';
export const MEETING_READ_ALL = 'meetings.read.all';

export function meetingsUnscoped(staff: AuthedStaff): boolean {
  return holds(staff, MEETING_READ_ALL);
}

/**
 * SQL: is the session aliased `m` a Hilo session. Self-contained (EXISTS), so it drops into any
 * query that has `meetings m` in scope without changing its joins.
 */
export function hiloSessionSql(m = 'm'): string {
  return `(EXISTS (SELECT 1 FROM contacts wc WHERE wc.id = ${m}.contact_id AND wc.hilo_status <> 'none' AND wc.soto_status = 'none')
        OR EXISTS (SELECT 1 FROM staff ws JOIN roles wr ON wr.id = ws.role_id WHERE ws.id = ${m}.staff_id AND wr.key = 'ed_coo'))`;
}

/**
 * The scope predicate for a reader, as an ` AND (...)` fragment, with the parameter it needs.
 * Unscoped readers get an empty clause and no parameter.
 */
export function meetingScope(
  staff: AuthedStaff,
  nextParamIndex: number,
  m = 'm'
): { clause: string; params: unknown[] } {
  if (meetingsUnscoped(staff)) return { clause: '', params: [] };
  return {
    clause: ` AND (${m}.staff_id = $${nextParamIndex} OR ${hiloSessionSql(m)})`,
    params: [staff.id],
  };
}

/** The same rule on a row already in hand (staff_id plus the client's two statuses). */
export function inMeetingScope(
  staff: AuthedStaff,
  row: { staff_id: string | null; hilo_status: string | null; soto_status: string | null; uploader_role: string | null }
): boolean {
  if (meetingsUnscoped(staff)) return true;
  if (row.staff_id !== null && row.staff_id === staff.id) return true;
  if (row.uploader_role === 'ed_coo') return true;
  return row.hilo_status !== null && row.hilo_status !== 'none' && row.soto_status === 'none';
}
