/*
 * STAFF MAIL LINKS TO THE OPS SIGN-IN PAGE (Brian, 2026-09-27, R71).
 *
 * Three messages reach a staff member's own inbox, never a client's, and each one names the place
 * to go next: the Ops sign-in page, built from OPS_URL (the env files carry it; production is
 * https://ops.sotoaccounting.com). Before R71 the reset-MFA mail said "at your next sign-in" and
 * left the reader to find the page.
 *
 *   staff_mfa_reset          the CEO pressed Reset MFA on the member's row (R65)
 *   staff_temp_password      a temporary password was issued (Add staff, or Regenerate). The
 *                            PASSWORD IS NEVER IN IT: it is handed over by the person who minted it,
 *                            as it always was; the mail says who will hand it over and where to sign in
 *   staff_mfa_recovery_used  the alert recipient (the CEO) is told a member signed in with a
 *                            recovery code; the task and the Ops alert are unchanged beside it
 *
 * Staff mail, so no automation toggle (CLAUDE.md: internal alerts are never gated); each function is
 * registered in comms/client-sends.ts with recipientClass 'staff'. A refused mail never undoes the
 * action that caused it: the caller gets { emailed, emailRefused } and says which.
 */
import type { FastifyInstance } from 'fastify';
import { sendTemplatedEmail } from '../templates/service.ts';

export interface StaffMailResult {
  emailed: boolean;
  emailRefused: string | null;
}

/** The Ops sign-in page every staff mail links to. */
export function opsSignInUrl(app: FastifyInstance): string {
  return new URL('/login', app.config.OPS_URL).toString();
}

function refused(app: FastifyInstance, err: unknown, templateKey: string, staffId: string): StaffMailResult {
  // The staff id, never the address: no personal data in the log line.
  app.log.warn({ err, staffId, templateKey }, `${templateKey} mail not sent`);
  return { emailed: false, emailRefused: err instanceof Error ? err.message : 'mail refused' };
}

/** R65 + R71: the member learns their authenticator is gone, and where to sign in to enrol again. */
export async function sendStaffMfaResetMail(
  app: FastifyInstance,
  member: { id: string; email: string; displayName: string },
  resetBy: string
): Promise<StaffMailResult> {
  try {
    await sendTemplatedEmail(app, {
      to: member.email,
      templateKey: 'staff_mfa_reset',
      language: 'en',
      vars: { display_name: member.displayName, reset_by: resetBy, ops_signin_url: opsSignInUrl(app) },
    });
    return { emailed: true, emailRefused: null };
  } catch (err) {
    return refused(app, err, 'staff_mfa_reset', member.id);
  }
}

/** R71: a temporary password was issued; who hands it over, and where to sign in. Never the password. */
export async function sendStaffTempPasswordMail(
  app: FastifyInstance,
  member: { id: string; email: string; displayName: string },
  issuedBy: string
): Promise<StaffMailResult> {
  try {
    await sendTemplatedEmail(app, {
      to: member.email,
      templateKey: 'staff_temp_password',
      language: 'en',
      vars: { display_name: member.displayName, issued_by: issuedBy, ops_signin_url: opsSignInUrl(app) },
    });
    return { emailed: true, emailRefused: null };
  } catch (err) {
    return refused(app, err, 'staff_temp_password', member.id);
  }
}

/** R65 + R71: the alert recipient is told a recovery code was used, with the way into Ops. */
export async function sendMfaRecoveryUsedMail(
  app: FastifyInstance,
  recipientStaffId: string,
  used: { memberName: string; remaining: number }
): Promise<StaffMailResult> {
  try {
    const { rows } = await app.db.query<{ email: string; display_name: string }>(
      `SELECT email, display_name FROM staff WHERE id = $1 AND is_active`,
      [recipientStaffId]
    );
    const to = rows[0];
    if (!to) return { emailed: false, emailRefused: 'the alert recipient is not an active staff member' };
    await sendTemplatedEmail(app, {
      to: to.email,
      templateKey: 'staff_mfa_recovery_used',
      language: 'en',
      vars: {
        display_name: to.display_name,
        member: used.memberName,
        remaining: String(used.remaining),
        ops_signin_url: opsSignInUrl(app),
      },
    });
    return { emailed: true, emailRefused: null };
  } catch (err) {
    return refused(app, err, 'staff_mfa_recovery_used', recipientStaffId);
  }
}
