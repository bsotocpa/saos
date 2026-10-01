'use client';

/*
 * A WITHDRAWN RETURN, IN ONE LINE (Brian, 2026-09-30, R108). "2025 1040 · Withdrawn on Sep 20, 2026",
 * and the reason recorded with the withdrawal when it is tapped open. No stepper, no badges, no
 * controls: there is nothing left to do on a withdrawn return, and a card that offers controls on one
 * invites work on a dead record. The client page and the business page render the same line.
 */
import { formatDate } from '../lib/dates';

export function WithdrawnReturnLine({ id, taxYear, returnType, withdrawnOn, reason, extra }: {
  id: string; taxYear: number; returnType: string; withdrawnOn: string | null; reason: string | null; extra?: string;
}): React.JSX.Element {
  return (
    <details className="withdrawn-line" data-testid={`withdrawn-return-${id}`}>
      <summary>
        <strong>{taxYear} {returnType.toUpperCase()}</strong>
        {extra ? <span className="muted small"> · {extra}</span> : null}
        <span className="muted small"> · Withdrawn{withdrawnOn ? ` on ${formatDate(withdrawnOn)}` : ''}</span>
      </summary>
      <p className="small muted" data-testid={`withdrawn-reason-${id}`}>{reason?.trim() ? reason : 'No reason was recorded with the withdrawal.'}</p>
    </details>
  );
}
