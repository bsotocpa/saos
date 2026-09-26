'use client';

/*
 * E-FILE ACKNOWLEDGMENTS (2026-09-12; rebuilt for the real ATX export under R43, 2026-09-26). The
 * tax preparer's screen for ATX's "E-Files" export: upload it, read what SAOS made of every row,
 * hold anything that should not go, release. Nothing sends on upload. Release is the send decision
 * and it is hers, and it releases only matched accepted rows.
 *
 * The export is firm-wide, so most rows match nothing: they are listed under their own heading with
 * their count and masked identifiers, and they raise nothing. A matched row reads as accepted (will
 * send), pending (no action), rejected (its task), already recorded, or an extension proposal with a
 * Record extension control (the R12 door). The report itself can be withdrawn (void, re-uploadable)
 * and, when it was stored before the masking rule, purged of full identifiers.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../../lib/api';
import { dayOf, formatDate, formatDateTime } from '../../lib/dates';
import { useAsk } from '../../components/ask';

interface ReportSummary {
  id: string; filename: string; uploaded_at: string; released_at: string | null; withdrawn_at: string | null; withdrawn_reason: string | null;
  row_count: number; matched_count: number; task_count: number; unmatched_count: number; pending_count: number; extension_count: number;
  holds_identifiers: boolean; uploaded_by: string;
}
type Disposition = 'queued' | 'held' | 'sent' | 'suppressed' | 'task' | 'duplicate' | 'unmatched' | 'pending' | 'extension_proposed' | 'extension_recorded';
interface AckRow {
  id: string; row_index: number; jurisdiction: 'federal' | 'state'; state_code: string | null;
  status: 'accepted' | 'rejected' | 'pending' | 'other'; status_raw: string; accepted_with_messages: boolean; submission_id: string | null;
  acknowledged_on: string | null; status_at: string | null; reject_code: string | null; client_name_raw: string; taxpayer_last4: string | null;
  sub_type: string | null; extension_form: string | null; tax_year: number | null; return_type_raw: string | null; return_type: string | null;
  disposition: Disposition; disposition_note: string;
  task_id: string | null; sent_at: string | null; suppressed_at: string | null; tax_engagement_id: string | null; contact_id: string | null;
  client: string | null; language: 'en' | 'es' | null;
}
interface ReportView { report: ReportSummary & { released_by: string | null; withdrawn_by: string | null }; rows: AckRow[] }
interface UploadResult { reportId: string; rows: number; queued: number; tasks: number; duplicates: number; unmatched: number; pending: number; extensions: number; alreadyIngested: boolean; skipped: Array<{ rowIndex: number; why: string }> }

const DISPOSITION_LABEL: Record<Disposition, string> = {
  queued: 'Will send',
  held: 'Held',
  sent: 'Sent',
  suppressed: 'Held: automation was off at the time',
  task: 'Task raised',
  duplicate: 'Already recorded',
  unmatched: 'Not an SAOS return',
  pending: 'Pending at ATX',
  extension_proposed: 'Extension proposed',
  extension_recorded: 'Extension recorded',
};
const toneFor = (d: Disposition) =>
  d === 'sent' || d === 'extension_recorded' ? 'ok' : d === 'task' ? 'danger' : d === 'held' || d === 'suppressed' || d === 'extension_proposed' ? 'warn' : '';
/** The identifier as this screen ever shows it: the last four behind five dots. */
const maskedId = (last4: string | null) => (last4 ? `•••••${last4}` : '—');
const agencyOf = (r: AckRow) => (r.jurisdiction === 'federal' ? 'Federal' : r.state_code ?? '?');
const statusLabel = (r: AckRow) =>
  r.status === 'accepted' ? `Accepted${r.accepted_with_messages ? ' with messages' : ''}` : r.status === 'rejected' ? r.status_raw : r.status_raw;
const statusTone = (r: AckRow) => (r.status === 'accepted' ? 'ok' : r.status === 'rejected' ? 'danger' : 'warn');
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export default function EfileAcksPage() {
  const ask = useAsk();
  const [reports, setReports] = useState<ReportSummary[]>([]);
  const [open, setOpen] = useState<ReportView | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  /* A refusal renders beside the control that caused it (Brian, 2026-09-19, defect 2). */
  const [inlineErr, setInlineErr] = useState<{ key: string; message: string } | null>(null);
  const errAt = (key: string) => (inlineErr?.key === key ? <p className="field-error" role="alert">{inlineErr.message}</p> : null);
  const fileRef = useRef<HTMLInputElement>(null);
  /*
   * WHO SEES THE UPLOAD (2026-09-19): efile.manage is the permission every /efile-acks route requires, so
   * the controls render only for a session that holds it — the tax preparer and the CEO. A role without it
   * reads why, in the server's own words, instead of a screen whose every control refuses.
   */
  const [canManage, setCanManage] = useState(false);

  const loadList = useCallback(async () => {
    try {
      const r = await api<{ reports: ReportSummary[] }>('/efile-acks');
      setReports(r.reports);
      setErr('');
    } catch (e) {
      setReports([]);
      setErr(e instanceof Error ? e.message : 'The report list could not be read.');
    }
  }, []);
  const loadReport = useCallback(async (id: string) => {
    setOpen(await api<ReportView>(`/efile-acks/${id}`));
  }, []);
  useEffect(() => { void loadList(); }, [loadList]);
  useEffect(() => {
    let alive = true;
    api<{ permissions: string[] }>('/auth/me')
      .then((m) => { if (alive) setCanManage(m.permissions.includes('*') || m.permissions.includes('efile.manage')); })
      .catch(() => { if (alive) setCanManage(false); });
    return () => { alive = false; };
  }, []);

  const summarize = (r: UploadResult) =>
    `${plural(r.rows, 'row')}: ${r.queued} will send, ${plural(r.tasks, 'task')} raised, ${r.pending} pending, ${plural(r.extensions, 'extension proposal')}, ` +
    `${r.duplicates} already recorded, ${r.unmatched} unmatched (not SAOS returns)` +
    (r.skipped.length ? `, ${plural(r.skipped.length, 'line')} skipped (${r.skipped.map((s) => `row ${s.rowIndex}: ${s.why}`).join('; ')})` : '') +
    '. Nothing has been sent — review below, then release.';

  const upload = async (file: File) => {
    setBusy(true); setInlineErr(null); setMsg('');
    try {
      const fd = new FormData();
      fd.append('file', file, file.name);
      const r = await api<UploadResult>('/efile-acks', { method: 'POST', formData: fd });
      setMsg((r.alreadyIngested ? 'This exact report was already uploaded. ' : '') + summarize(r));
      await loadList();
      await loadReport(r.reportId);
      // The chosen file is cleared only once it was taken; a refusal keeps it beside its message.
      if (fileRef.current) fileRef.current.value = '';
    } catch (e) {
      setInlineErr({ key: 'upload', message: e instanceof Error ? e.message : 'The report could not be read.' });
    } finally {
      setBusy(false);
    }
  };

  const rowAction = async (row: AckRow, path: string, key = `row:${row.id}`) => {
    if (!open) return;
    setBusy(true); setInlineErr(null);
    try {
      await api(`/efile-acks/rows/${row.id}/${path}`, { method: 'POST' });
      await loadReport(open.report.id);
    } catch (e) {
      setInlineErr({ key, message: e instanceof Error ? e.message : 'Could not change that row.' });
    } finally { setBusy(false); }
  };

  const recordExtension = async (row: AckRow) => {
    if (!open) return;
    const a = await ask({
      title: `Record a Form ${row.extension_form} extension on ${row.client}'s ${row.tax_year} ${row.return_type?.toUpperCase()}?`,
      body: (
        <>
          <p>The export says this extension was accepted on {row.acknowledged_on ? formatDate(row.acknowledged_on) : 'an unknown date'}. Recording it writes the form and that filed date on the return; the extended deadline derives from the return type and the fiscal year end.</p>
          <p className="small muted">Nothing is emailed.</p>
        </>
      ),
      choices: [{ key: 'record', label: 'Record extension', tone: 'primary' }],
      run: async () => { await api(`/efile-acks/rows/${row.id}/record-extension`, { method: 'POST' }); },
    });
    if (!a) return;
    setMsg(`Form ${row.extension_form} extension recorded on ${row.client}'s ${row.tax_year} ${row.return_type?.toUpperCase()}.`);
    await loadReport(open.report.id);
  };

  const release = async () => {
    if (!open) return;
    const willSend = open.rows.filter((r) => r.disposition === 'queued');
    const held = open.rows.filter((r) => r.disposition === 'held');
    const got: { r: { enqueued: number; held: number } | null } = { r: null };
    const a = await ask({
      title: `Release ${willSend.length} confirmation${willSend.length === 1 ? '' : 's'} to clients?`,
      body: (
        <>
          <p>Each client below is emailed, in their language, that their return was accepted — federal and state as separate messages. Only matched, accepted rows are released; unmatched, pending, rejected and extension rows send nothing.</p>
          <ul className="list small">
            {willSend.map((r) => <li key={r.id}>{r.client} · {r.tax_year} {r.return_type?.toUpperCase()} · {agencyOf(r)}</li>)}
          </ul>
          {held.length ? <p className="muted small">{held.length} held row{held.length === 1 ? '' : 's'} will not send.</p> : null}
          <p className="small">If the automation is not armed in Admin, every one is recorded as held on that date and nothing goes out.</p>
        </>
      ),
      choices: [{ key: 'go', label: `Release ${willSend.length}`, tone: 'primary' }],
      run: async () => { got.r = await api<{ enqueued: number; held: number }>(`/efile-acks/${open.report.id}/release`, { method: 'POST' }); },
    });
    if (!a) return;
    setBusy(true);
    setMsg(`Released: ${got.r?.enqueued ?? 0} queued to send, ${got.r?.held ?? 0} held.`);
    await loadList();
    await loadReport(open.report.id);
    setBusy(false);
  };

  const withdraw = async () => {
    if (!open) return;
    const a = await ask({
      title: `Withdraw ${open.report.filename}?`,
      body: (
        <>
          <p>The report is void: its rows stay on the record, nothing on it will send, and the same file can be uploaded again. Acceptances already applied to returns stay — they are facts.</p>
        </>
      ),
      reason: { label: 'Why it is withdrawn', required: true, placeholder: 'e.g. Exported with the wrong filter; re-uploading the corrected file.' },
      choices: [{ key: 'withdraw', label: 'Withdraw report', tone: 'danger' }],
      run: async (r) => { await api(`/efile-acks/${open.report.id}/withdraw`, { method: 'POST', body: { reason: r.reason } }); },
    });
    if (!a) return;
    setMsg(`${open.report.filename} withdrawn. Its file can be uploaded again.`);
    await loadList();
    await loadReport(open.report.id);
  };

  const purge = async () => {
    if (!open) return;
    const got: { r: { rawFileIdentifiers: number; ackRowsRewritten: number; tasksRewritten: number; auditRowsHoldingIdentifiers: number } | null } = { r: null };
    const a = await ask({
      title: 'Purge full identifiers from this report?',
      body: <p>This report was stored before SAOS masked identifiers at upload. Every full SSN or EIN in the stored file, on its rows and in the tasks it raised is rewritten to its last four. The counts go on the audit log.</p>,
      choices: [{ key: 'purge', label: 'Purge identifiers', tone: 'danger' }],
      run: async () => { got.r = await api(`/efile-acks/${open.report.id}/purge-identifiers`, { method: 'POST' }); },
    });
    if (!a) return;
    const p = got.r;
    setMsg(p ? `Purged: ${p.rawFileIdentifiers} in the stored file, ${p.ackRowsRewritten} row${p.ackRowsRewritten === 1 ? '' : 's'}, ${p.tasksRewritten} task${p.tasksRewritten === 1 ? '' : 's'} rewritten to last four.` : 'Purged.');
    await loadList();
    await loadReport(open.report.id);
  };

  const matched = open ? open.rows.filter((r) => r.disposition !== 'unmatched') : [];
  const unmatched = open ? open.rows.filter((r) => r.disposition === 'unmatched') : [];
  const withdrawn = Boolean(open?.report.withdrawn_at);

  return (
    <>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', marginBottom: 10 }}>
        <h1 style={{ margin: 0 }}>E-file acknowledgments</h1>
        <span style={{ flex: 1 }} />
        {canManage ? (
          <label className="btn accent" style={{ cursor: busy ? 'wait' : 'pointer' }}>
            Upload ATX report
            <input ref={fileRef} type="file" accept=".csv,.txt,.tsv,text/csv,text/plain" hidden disabled={busy}
              onChange={(e) => { const f = e.target.files?.[0]; if (f) void upload(f); }} />
          </label>
        ) : null}
      </div>
      {errAt('upload')}
      {msg ? <p className="alert ok" role="status" data-testid="ack-summary">{msg}</p> : null}
      {err ? <p className="alert error" role="alert">{err}</p> : null}

      <section className="card">
        <h2>Reports</h2>
        {reports.length === 0 && !err ? <p className="muted small">No report uploaded yet. In ATX, export the E-Files list as CSV and upload it here. Identifiers are kept as their last four only.</p> : null}
        <ul className="list">
          {reports.map((r) => (
            <li key={r.id}>
              <span className="grow">
                <strong>{r.filename}</strong> · uploaded {formatDateTime(r.uploaded_at)} by {r.uploaded_by}
                {r.withdrawn_at ? <> <span className="badge danger">withdrawn</span></> : null}
                <br />
                <span className="muted small">
                  {r.row_count} rows · {r.matched_count} to send · {r.task_count} tasks · {r.pending_count} pending · {r.extension_count} extension proposals · {r.unmatched_count} unmatched ·{' '}
                  {r.released_at ? `released ${formatDateTime(r.released_at)}` : 'not released'}
                </span>
              </span>
              <button className="btn ghost small" type="button" onClick={() => void loadReport(r.id)}>Open</button>
            </li>
          ))}
        </ul>
      </section>

      {open ? (
        <section className="card" style={{ marginTop: 12 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <h2 style={{ margin: 0 }}>{open.report.filename}</h2>
            <span style={{ flex: 1 }} />
            {withdrawn ? (
              <span className="badge danger" data-testid="report-withdrawn">withdrawn {formatDateTime(open.report.withdrawn_at!)}{open.report.withdrawn_by ? ` by ${open.report.withdrawn_by}` : ''}</span>
            ) : open.report.released_at ? (
              <span className="badge ok">released {formatDateTime(open.report.released_at)} by {open.report.released_by}</span>
            ) : (
              <button className="btn accent" type="button" disabled={busy || !open.rows.some((r) => r.disposition === 'queued')} onClick={() => void release()}>
                Release {open.rows.filter((r) => r.disposition === 'queued').length} to clients
              </button>
            )}
            {canManage && !withdrawn ? (
              <button className="btn ghost small" type="button" data-testid="withdraw-report" disabled={busy} onClick={() => void withdraw()}>Withdraw report</button>
            ) : null}
            {canManage && open.report.holds_identifiers ? (
              <button className="btn ghost small" type="button" data-testid="purge-identifiers" disabled={busy} onClick={() => void purge()}>Purge identifiers</button>
            ) : null}
          </div>
          {withdrawn && open.report.withdrawn_reason ? <p className="muted small" style={{ marginTop: 6 }}>Withdrawn: {open.report.withdrawn_reason}</p> : null}
          <p className="muted small" style={{ marginTop: 6 }} data-testid="report-counts">
            {open.report.row_count} rows · {open.report.matched_count} will send · {open.report.task_count} tasks · {open.report.pending_count} pending · {open.report.extension_count} extension proposals ·{' '}
            <span data-testid="ack-unmatched-count">{open.report.unmatched_count} unmatched</span>
            {open.report.holds_identifiers ? <> · <span className="badge danger">holds full identifiers</span></> : <> · identifiers kept as last four</>}
          </p>
          <p className="muted small">
            Matched rows and what SAOS did with each. Hold anything that should not go. A rejection is its task; a pending status needs nothing; an extension proposal is recorded here or left alone.
          </p>
          <div className="tablewrap" data-testid="ack-matched-rows">
            <table className="dense">
              <thead>
                <tr><th className="nosort">#</th><th className="nosort">On the export</th><th className="nosort">Return</th><th className="nosort">Agency</th><th className="nosort">Status</th><th className="nosort">Status date</th><th className="nosort">Matched to</th><th className="nosort">What SAOS did</th><th className="nosort"></th></tr>
              </thead>
              <tbody>
                {matched.length === 0 ? <tr><td colSpan={9} className="muted">No row on this export belongs to a return SAOS is tracking.</td></tr> : null}
                {matched.map((r) => (
                  <tr key={r.id}>
                    <td>{r.row_index}</td>
                    <td>{r.client_name_raw} <span className="muted small">{maskedId(r.taxpayer_last4)}</span></td>
                    <td>{r.tax_year ?? ''} {(r.return_type ?? r.return_type_raw ?? '?').toUpperCase()}{r.extension_form ? <span className="muted small"> · ext {r.extension_form}</span> : null}</td>
                    <td>{agencyOf(r)}</td>
                    <td><span className={`badge ${statusTone(r)}`}>{statusLabel(r)}</span></td>
                    <td>{r.acknowledged_on ? formatDate(r.acknowledged_on) : '—'}</td>
                    <td>{r.client ? <a href={`/clients/${r.contact_id}`}>{r.client}</a> : <span className="muted">—</span>}</td>
                    <td>
                      <span className={`badge ${toneFor(r.disposition)}`}>{r.disposition === 'suppressed' && r.suppressed_at ? `held on ${dayOf(r.suppressed_at)} — automation was off at the time` : DISPOSITION_LABEL[r.disposition]}</span>{' '}
                      <span className="muted small">{r.disposition_note}</span>
                      {r.task_id ? <> <a className="small" href={`/tasks?open=${r.task_id}`}>task</a></> : null}
                    </td>
                    <td>
                      {!withdrawn && r.disposition === 'queued' ? <button className="chip" type="button" disabled={busy} onClick={() => void rowAction(r, 'hold')}>Hold</button> : null}
                      {!withdrawn && r.disposition === 'held' ? <button className="chip" type="button" disabled={busy} onClick={() => void rowAction(r, 'unhold')}>Unhold</button> : null}
                      {!withdrawn && r.disposition === 'extension_proposed' ? <button className="chip" type="button" data-testid={`record-extension-${r.row_index}`} disabled={busy} onClick={() => void recordExtension(r)}>Record extension</button> : null}
                      {errAt(`row:${r.id}`)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <details style={{ marginTop: 12 }} data-testid="ack-unmatched-rows">
            <summary><strong>Unmatched rows ({unmatched.length})</strong> <span className="muted small">— not SAOS returns; listed and counted, no task, no send</span></summary>
            <div className="tablewrap">
              <table className="dense">
                <thead>
                  <tr><th className="nosort">#</th><th className="nosort">On the export</th><th className="nosort">Identifier</th><th className="nosort">Form</th><th className="nosort">Sub type</th><th className="nosort">Agency</th><th className="nosort">Status</th><th className="nosort">Status date</th><th className="nosort">Why</th></tr>
                </thead>
                <tbody>
                  {unmatched.map((r) => (
                    <tr key={r.id}>
                      <td>{r.row_index}</td>
                      <td>{r.client_name_raw}</td>
                      <td>{maskedId(r.taxpayer_last4)}</td>
                      <td>{r.return_type_raw ?? '?'}</td>
                      <td>{r.sub_type ?? ''}</td>
                      <td>{agencyOf(r)}</td>
                      <td><span className={`badge ${statusTone(r)}`}>{statusLabel(r)}</span></td>
                      <td>{r.acknowledged_on ? formatDate(r.acknowledged_on) : '—'}</td>
                      <td className="muted small">{r.disposition_note}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
        </section>
      ) : null}
    </>
  );
}
