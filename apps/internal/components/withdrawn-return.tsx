'use client';

/*
 * A WITHDRAWN RETURN, IN ONE LINE (Brian, 2026-09-30, R108). "2025 1040 · Withdrawn on Sep 20, 2026",
 * and the reason recorded with the withdrawal when it is tapped open. No stepper, no badges, no
 * controls: there is nothing left to do on a withdrawn return, and a card that offers controls on one
 * invites work on a dead record. The client page and the business page render the same line.
 *
 * R117 (2026-10-02): a withdrawal of the firm's own record (a duplicate, a migration leftover, an
 * import error) is hidden from the client's portal; the line says so, so nobody wonders why the client
 * cannot see it.
 */
import { formatDate } from '../lib/dates';

export function WithdrawnReturnLine({ id, taxYear, returnType, withdrawnOn, reason, kind, extra }: {
  id: string; taxYear: number; returnType: string; withdrawnOn: string | null; reason: string | null;
  kind?: string | null; extra?: string;
}): React.JSX.Element {
  const hidden = kind === 'firm_record';
  return (
    <details className="withdrawn-line" data-testid={`withdrawn-return-${id}`}>
      <summary>
        <strong>{taxYear} {returnType.toUpperCase()}</strong>
        {extra ? <span className="muted small"> · {extra}</span> : null}
        <span className="muted small"> · Withdrawn{withdrawnOn ? ` on ${formatDate(withdrawnOn)}` : ''}</span>
        {hidden ? <span className="muted small" data-testid={`withdrawn-hidden-${id}`}> · not on the client&apos;s portal</span> : null}
      </summary>
      {hidden ? (
        <p className="small muted">Withdrawn as the firm&apos;s own record (a duplicate, a migration leftover or an import error), so the client&apos;s portal does not show it.</p>
      ) : null}
      <p className="small muted" data-testid={`withdrawn-reason-${id}`}>{reason?.trim() ? reason : 'No reason was recorded with the withdrawal.'}</p>
    </details>
  );
}
