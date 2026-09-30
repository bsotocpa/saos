'use client';

/*
 * THE LIST BEHIND ONE "OPEN RETURNS BY STAGE" ROW (Brian, 2026-09-26, R52).
 *
 * The executive view counted returns per stage and offered nowhere to go; a count you cannot open
 * is a number, not a view. Each row now lands here with its stage in the address, and this page
 * lists the returns in it: the client, the business, the form and year, the preparer, and the days
 * the return has sat in the stage. The same grant as the view it opens from (dashboards.executive);
 * test clients are left out of both, so the count and the list agree.
 *
 * R102 (2026-09-30): the same list for the returns naming no preparer (?preparer=none), behind the
 * executive view's "Returns with no preparer" count; the days column counts from when each opened.
 */

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { api, isAuthed } from '../../lib/api';
import { taxStageLabel } from '../../lib/labels';

interface Row {
  id: string; tax_year: number; return_type: string; stage: string;
  contact_id: string; first_name: string; last_name: string; business_name: string | null;
  preparer_id: string | null; preparer_name: string | null; days_in_stage: number;
}

const formLabel = (r: Row): string => `${r.return_type.toUpperCase()} · ${r.tax_year}`;
const daysLabel = (n: number): string => (n === 0 ? 'today' : n === 1 ? '1 day' : `${n} days`);

export default function OpenReturnsPage() {
  const router = useRouter();
  // Read from location rather than useSearchParams to keep this page prerenderable — and read it in an
  // effect, not a state initializer: on a client-side navigation the App Router commits the new URL
  // after the first render, so a render-time read still sees the page the link was on. `undefined`
  // is "not read yet"; null is "no stage in the address".
  const [stage, setStage] = useState<string | null | undefined>(undefined);
  const [noPreparer, setNoPreparer] = useState(false);
  const [rows, setRows] = useState<Row[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isAuthed()) { router.replace('/login'); return; }
    const params = new URLSearchParams(window.location.search);
    const wanted = params.get('stage');
    setNoPreparer(params.get('preparer') === 'none');
    setStage(params.get('preparer') === 'none' ? 'no_preparer' : wanted && /^[a-z_]+$/.test(wanted) ? wanted : null);
  }, [router]);

  useEffect(() => {
    if (!stage) return;
    api<{ returns: Row[] }>(stage === 'no_preparer' ? '/dashboards/open-returns?preparer=none' : `/dashboards/open-returns?stage=${encodeURIComponent(stage)}`)
      .then((r) => setRows(r.returns))
      .catch((err: unknown) => setError(err instanceof Error && err.message ? err.message : 'The list could not be read.'));
  }, [stage]);

  if (stage === undefined) {
    return (
      <>
        <h1>Open returns</h1>
        <section className="card"><p className="muted">Loading…</p></section>
      </>
    );
  }
  if (!stage) {
    return (
      <>
        <h1>Open returns</h1>
        <section className="card">
          <p className="muted">Open this list from a stage row on the <Link href="/">executive view</Link>.</p>
        </section>
      </>
    );
  }
  return (
    <>
      <h1>{noPreparer ? 'Returns with no preparer' : `Open returns — ${taxStageLabel(stage)}`}</h1>
      <p className="muted small"><Link href="/">← Executive view</Link></p>
      {error ? <p className="alert error" role="alert">{error}</p> : null}
      {rows === null ? (
        error ? null : <section className="card"><p className="muted">Loading…</p></section>
      ) : rows.length === 0 ? (
        <section className="card"><p className="muted" data-testid="open-returns-empty">{noPreparer ? 'Every open return names a preparer.' : 'No open returns in this stage.'}</p></section>
      ) : (
        <>
          {/* Desktop: table. */}
          <section className="card desk-only">
            <table data-testid="open-returns-table">
              <thead>
                <tr><th>Client</th><th>Business</th><th>Form</th><th>{noPreparer ? 'Stage' : 'Preparer'}</th><th>{noPreparer ? 'Days open' : 'Days in stage'}</th></tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} data-testid={`open-return-row-${r.id}`}>
                    <td><Link href={`/clients/${r.contact_id}`}>{r.first_name} {r.last_name}</Link></td>
                    <td className="muted small">{r.business_name ?? '—'}</td>
                    <td>{formLabel(r)}</td>
                    <td className="muted small">{noPreparer ? taxStageLabel(r.stage) : r.preparer_name ?? 'Unassigned'}</td>
                    <td>{daysLabel(r.days_in_stage)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
          {/* 390px: one card per return, the whole card clickable. */}
          <section className="phone-only" data-testid="open-returns-cards">
            {rows.map((r) => (
              <Link key={r.id} href={`/clients/${r.contact_id}`} className="card lead-card-link" style={{ display: 'block', marginBottom: 8 }} data-testid={`open-return-card-${r.id}`}>
                <strong>{r.first_name} {r.last_name}</strong>
                {r.business_name ? <><br /><span className="small">{r.business_name}</span></> : null}
                <br />
                <span className="muted small">{formLabel(r)} · {noPreparer ? `${taxStageLabel(r.stage)} · open ${daysLabel(r.days_in_stage)}` : `${r.preparer_name ?? 'Unassigned'} · ${daysLabel(r.days_in_stage)} in stage`}</span>
              </Link>
            ))}
          </section>
        </>
      )}
    </>
  );
}
