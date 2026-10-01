/*
 * A WITHDRAWN RETURN, IN ONE LINE (Brian, 2026-09-30, R108). A withdrawn return renders "Withdrawn on
 * <date>" with its reason on tap — no stepper, no controls — in Ops and the portal. The day and the
 * reason are the stage history's withdrawn row (the transition, or the engagement close that withdrew
 * it); a return withdrawn before the history carried one reads its engagement's end day and reason.
 * Aliases: te = tax_engagements, e = its engagement.
 */
import { chicagoDayOf } from '../../chicago-day.ts';

const latestWithdrawn = (col: string) =>
  `(SELECT ${col} FROM engagement_stage_history h WHERE h.tax_engagement_id = te.id AND h.stage = 'withdrawn' ORDER BY h.entered_at DESC LIMIT 1)`;

/** The Chicago day the return was withdrawn (text), or null when it is not withdrawn. */
export const WITHDRAWN_ON_SQL = `CASE WHEN te.stage = 'withdrawn' THEN COALESCE(${latestWithdrawn(`${chicagoDayOf('h.entered_at')}::text`)}, e.ended_on::text) END`;
/** The reason recorded with the withdrawal (staff words: Ops only), or null. */
export const WITHDRAWN_REASON_SQL = `CASE WHEN te.stage = 'withdrawn' THEN COALESCE(NULLIF(${latestWithdrawn('h.note')}, ''), e.close_reason) END`;
/**
 * What the client reads as the reason (R108, the portal): never the staff's words, which are written
 * for the firm. 'change_order' when an updated agreement replaced the return, 'closed' otherwise.
 */
export const WITHDRAWN_KIND_SQL = `CASE WHEN te.stage = 'withdrawn' THEN CASE WHEN COALESCE(${latestWithdrawn('h.note')}, e.close_reason, '') ILIKE 'superseded by change order%' THEN 'change_order' ELSE 'closed' END END`;
