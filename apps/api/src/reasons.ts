/*
 * REASON TEXT IS WRITTEN FOR THE NEXT READER (2026-09-12, Brian's standing rule).
 *
 * A reason on a void, a withdrawal, a pause, a deposit transfer or a declined quote is the
 * record of why money or work moved. The person reading it will be a staff member a year from
 * now, an auditor, or the client. It must stand on its own.
 *
 * The 2026-09-10 walk found "duplicate accept — superseded by 6e474b1f (Brian's ruling 1)" on a
 * live engagement. A ruling number is a pointer into a chat; an eight-character id is a pointer
 * into a database. Neither is a reason. This refuses the shapes that were actually written, at
 * the door, with a message that says what to write instead.
 *
 * Applied to STAFF reasons only. A client's own free text (portal decline reasons, SMS opt-out
 * notes) is theirs and is not policed.
 */
import { z } from 'zod';

const CONVERSATION_ARTIFACTS: Array<{ re: RegExp; why: string }> = [
  { re: /\bruling\s*[0-9a-z]\b/i, why: 'a ruling number points into a conversation' },
  { re: /\bdecision\s*[0-9]\b/i, why: 'a decision number points into a conversation' },
  { re: /\bas (we )?discussed\b/i, why: '"as discussed" points into a conversation' },
  { re: /\bper (our |the )?(chat|call|thread|conversation)\b/i, why: 'that points into a conversation' },
  { re: /\bmigration\s*0?[0-9]{2,4}\b/i, why: 'a migration number is a fact about the code, not the client' },
  { re: /\bovernight batch\b/i, why: 'the batch that did it is on the audit log, not in the reason' },
  { re: /\b(dress )?rehearsal\b/i, why: 'the rehearsal is over; say what the row means now' },
  // A bare short hex id: 8 hex chars with at least one letter, on its own. Pure digits are left
  // alone (SOS file numbers, EINs, amounts).
  { re: /(?<![0-9a-f-])(?=[0-9a-f]{8}(?![0-9a-f-]))[0-9]*[a-f][0-9a-f]*(?![0-9a-f-])/i, why: 'a record id is not something a reader can look up; name the thing' },
  { re: /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i, why: 'a record id is not something a reader can look up; name the thing' },
];

export function conversationArtifact(text: string): string | null {
  for (const a of CONVERSATION_ARTIFACTS) if (a.re.test(text)) return a.why;
  return null;
}

/** A zod string for a staff-written reason: trimmed, bounded, and free of conversation artifacts. */
export function reasonText(min: number, max: number): z.ZodString {
  return z
    .string()
    .trim()
    .min(min, 'Say why in at least a few words — this is the record.')
    .max(max)
    .superRefine((t, ctx) => {
      const why = conversationArtifact(t);
      if (why) ctx.addIssue({ code: 'custom', message: `Write the reason for whoever reads this next: ${why}.` });
    }) as unknown as z.ZodString;
}
