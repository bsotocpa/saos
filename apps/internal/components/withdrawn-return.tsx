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
 *
 * R118 (2026-10-02): the one exception to "no controls". Opened, the line offers the CEO alone (the
 * session holding engagements.tax.withdrawal_kind.correct by name) "Correct the kind…": a withdrawal
 * recorded with the wrong button is put right, with a reason, audited before and after. Our own record
 * leaves the client's portal; the client's work ended comes back to it. A change order's kind is the
 * agreement's and offers nothing.
 */
import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { formatDate } from '../lib/dates';
import { useAsk } from './ask';
import { me } from './return-controls';

export const CORRECT_WITHDRAWAL_KIND_PERMISSION = 'engagements.tax.withdrawal_kind.correct';

export function WithdrawnReturnLine({ id, taxYear, returnType, withdrawnOn, reason, kind, extra, onChanged }: {
  id: string; taxYear: number; returnType: string; withdrawnOn: string | null; reason: string | null;
  kind?: string | null; extra?: string; onChanged?: () => void | Promise<void>;
}): React.JSX.Element {
  const hidden = kind === 'firm_record';
  const ask = useAsk();
  const [canCorrect, setCanCorrect] = useState(false);
  useEffect(() => {
    let alive = true;
    if (kind !== 'client' && kind !== 'firm_record') return;
    me().then((m) => { if (alive) setCanCorrect(m.permissions.includes(CORRECT_WITHDRAWAL_KIND_PERMISSION)); }).catch(() => undefined);
    return () => { alive = false; };
  }, [kind]);

  const correct = async () => {
    const to = hidden ? 'client' : 'firm_record';
    const done = await ask({
      title: hidden ? "Correct the kind: the client's work ended?" : 'Correct the kind: our own record?',
      body: hidden ? (
        <p>The client&apos;s portal will show this return again, as one line: withdrawn, with the fixed sentence.</p>
      ) : (
        <p>A duplicate, a migration leftover or an import error. The return leaves the client&apos;s portal entirely; it stays here.</p>
      ),
      reason: { label: 'Why is the kind being corrected?', required: true },
      choices: [{ key: to, label: hidden ? "Correct to: the client's work ended" : 'Correct to: our own record', tone: 'primary' }],
      run: async (r) => { await api(`/tax-engagements/${id}/withdrawal-kind`, { method: 'POST', body: { kind: to, reason: r.reason } }); },
    });
    if (done) await onChanged?.();
  };

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
      {canCorrect ? (
        <button type="button" className="btn ghost small" data-testid={`withdrawal-kind-correct-${id}`} onClick={() => void correct()}>
          Correct the kind…
        </button>
      ) : null}
    </details>
  );
}
