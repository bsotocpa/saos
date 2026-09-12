'use client';

/*
 * E-FILE ACKNOWLEDGMENTS (2026-09-12). The tax preparer's screen for the ATX report:
 * upload it, read what SAOS made of every row, hold anything that should not go, release.
 * Nothing sends on upload. Release is the send decision and it is hers.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../../lib/api';
import { formatDate, formatDateTime } from '../../lib/dates';
import { useAsk } from '../../components/ask';

interface ReportSummary {
  id: string; filename: string; uploaded_at: string; released_at: string | null;
  row_count: number; matched_count: number; task_count: number; uploaded_by: string;
}
interface AckRow {
  id: string; row_index: number; jurisdiction: 'federal' | 'state'; state_code: string | null;
  status: 'accepted' | 'rejected' | 'other'; status_raw: string; submission_id: string | null;
  acknowledged_on: string | null; reject_code: string | null; client_name_raw: string;
  tax_year: number | null; return_type_raw: string | null;
  disposition: 'queued' | 'held' | 'sent' | 'suppressed' | 'task' | 'duplicate'; disposition_note: string;
  task_id: string | null; sent_at: string | null; tax_engagement_id: string | null; contact_id: string | null;
  client: string | null; language: 'en' | 'es' | null;
}
interface ReportView { report: ReportSummary & { released_by: string | null }; rows: AckRow[] }

const DISPOSITION_LABEL: Record<AckRow['disposition'], string> = {
  queued: 'Will send',
  held: 'Held',
  sent: 'Sent',
  suppressed: 'Held by the automation (off)',
  task: 'Task raised',
  duplicate: 'Already recorded',
};
const toneFor = (d: AckRow['disposition']) => (d === 'sent' ? 'ok' : d === 'task' ? 'danger' : d === 'held' || d === 'suppressed' ? 'warn' : '');

export default function EfileAcksPage() {
  const ask = useAsk();
  const [reports, setReports] = useState<ReportSummary[]>([]);
  const [open, setOpen] = useState<ReportView | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);

  const loadList = useCallback(async () => {
    const r = await api<{ reports: ReportSummary[] }>('/efile-acks');
    setReports(r.reports);
  }, []);
  const loadReport = useCallback(async (id: string) => {
    setOpen(await api<ReportView>(`/efile-acks/${id}`));
  }, []);
  useEffect(() => { void loadList(); }, [loadList]);

  const upload = async (file: File) => {
    setBusy(true); setErr(''); setMsg('');
    try {
      const fd = new FormData();
      fd.append('file', file, file.name);
      const r = await api<{ reportId: string; rows: number; queued: number; tasks: number; duplicates: number; alreadyIngested: boolean; skipped: Array<{ rowIndex: number; why: string }> }>('/efile-acks', { method: 'POST', formData: fd });
      setMsg(
        (r.alreadyIngested ? 'This exact report was already uploaded. ' : '') +
        `${r.rows} row${r.rows === 1 ? '' : 's'}: ${r.queued} will send, ${r.tasks} task${r.tasks === 1 ? '' : 's'} raised, ${r.duplicates} already recorded` +
        (r.skipped.length ? `, ${r.skipped.length} line${r.skipped.length === 1 ? '' : 's'} skipped (${r.skipped.map((s) => `row ${s.rowIndex}: ${s.why}`).join('; ')})` : '') +
        '. Nothing has been sent — review below, then release.'
      );
      await loadList();
      await loadReport(r.reportId);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'The report could not be read.');
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const hold = async (row: AckRow, on: boolean) => {
    if (!open) return;
    setBusy(true); setErr('');
    try {
      await api(`/efile-acks/rows/${row.id}/${on ? 'hold' : 'unhold'}`, { method: 'POST' });
      await loadReport(open.report.id);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not change that row.');
    } finally { setBusy(false); }
  };

  const release = async () => {
    if (!open) return;
    const willSend = open.rows.filter((r) => r.disposition === 'queued');
    const held = open.rows.filter((r) => r.disposition === 'held');
    const a = await ask({
      title: `Release ${willSend.length} confirmation${willSend.length === 1 ? '' : 's'} to clients?`,
      body: (
        <>
          <p>Each client below is emailed, in their language, that their return was accepted — federal and state as separate messages.</p>
          <ul className="list small">
            {willSend.map((r) => <li key={r.id}>{r.client} · {r.tax_year} {r.return_type_raw?.toUpperCase()} · {r.jurisdiction === 'federal' ? 'Federal' : r.state_code}</li>)}
          </ul>
          {held.length ? <p className="muted small">{held.length} held row{held.length === 1 ? '' : 's'} will not send.</p> : null}
          <p className="small">If the automation is not armed in Admin, every one is recorded as held by it and nothing goes out.</p>
        </>
      ),
      choices: [{ key: 'go', label: `Release ${willSend.length}`, tone: 'primary' }],
    });
    if (!a) return;
    setBusy(true); setErr('');
    try {
      const r = await api<{ enqueued: number; held: number }>(`/efile-acks/${open.report.id}/release`, { method: 'POST' });
      setMsg(`Released: ${r.enqueued} queued to send, ${r.held} held.`);
      await loadList();
      await loadReport(open.report.id);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Release failed.');
    } finally { setBusy(false); }
  };

  return (
    <>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', marginBottom: 10 }}>
        <h1 style={{ margin: 0 }}>E-file acknowledgments</h1>
        <span style={{ flex: 1 }} />
        <label className="btn accent" style={{ cursor: busy ? 'wait' : 'pointer' }}>
          Upload ATX report
          <input ref={fileRef} type="file" accept=".csv,.txt,.tsv,text/csv,text/plain" hidden disabled={busy}
            onChange={(e) => { const f = e.target.files?.[0]; if (f) void upload(f); }} />
        </label>
      </div>
      {msg ? <p className="alert ok" role="status">{msg}</p> : null}
      {err ? <p className="alert error" role="alert">{err}</p> : null}

      <section className="card">
        <h2>Reports</h2>
        {reports.length === 0 ? <p className="muted small">No report uploaded yet. Export the acknowledgment report from ATX as CSV and upload it here.</p> : null}
        <ul className="list">
          {reports.map((r) => (
            <li key={r.id}>
              <span className="grow">
                <strong>{r.filename}</strong> · uploaded {formatDateTime(r.uploaded_at)} by {r.uploaded_by}
                <br />
                <span className="muted small">
                  {r.row_count} rows · {r.matched_count} to send · {r.task_count} tasks ·{' '}
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
            {open.report.released_at ? (
              <span className="badge ok">released {formatDateTime(open.report.released_at)} by {open.report.released_by}</span>
            ) : (
              <button className="btn accent" type="button" disabled={busy || !open.rows.some((r) => r.disposition === 'queued')} onClick={() => void release()}>
                Release {open.rows.filter((r) => r.disposition === 'queued').length} to clients
              </button>
            )}
          </div>
          <p className="muted small" style={{ marginTop: 6 }}>
            Every row and what SAOS did with it. Hold anything that should not go. Rejections and anything SAOS could not match never send; they are tasks.
          </p>
          <div className="tablewrap">
            <table className="dense">
              <thead>
                <tr><th>#</th><th>Client on report</th><th>Return</th><th>Agency</th><th>Status</th><th>Ack date</th><th>Matched to</th><th>What SAOS did</th><th></th></tr>
              </thead>
              <tbody>
                {open.rows.map((r) => (
                  <tr key={r.id}>
                    <td>{r.row_index}</td>
                    <td>{r.client_name_raw}</td>
                    <td>{r.tax_year ?? '?'} {r.return_type_raw?.toUpperCase() ?? '?'}</td>
                    <td>{r.jurisdiction === 'federal' ? 'Federal' : r.state_code}</td>
                    <td>
                      <span className={`badge ${r.status === 'accepted' ? 'ok' : r.status === 'rejected' ? 'danger' : 'warn'}`}>
                        {r.status === 'accepted' ? 'Accepted' : r.status === 'rejected' ? `Rejected${r.reject_code ? ` ${r.reject_code}` : ''}` : r.status_raw}
                      </span>
                    </td>
                    <td>{r.acknowledged_on ? formatDate(r.acknowledged_on) : '—'}</td>
                    <td>{r.client ? <a href={`/clients/${r.contact_id}`}>{r.client}</a> : <span className="muted">not matched</span>}</td>
                    <td>
                      <span className={`badge ${toneFor(r.disposition)}`}>{DISPOSITION_LABEL[r.disposition]}</span>{' '}
                      <span className="muted small">{r.disposition_note}</span>
                      {r.task_id ? <> <a className="small" href={`/tasks?open=${r.task_id}`}>task</a></> : null}
                    </td>
                    <td>
                      {r.disposition === 'queued' ? <button className="chip" type="button" disabled={busy} onClick={() => void hold(r, true)}>Hold</button> : null}
                      {r.disposition === 'held' ? <button className="chip" type="button" disabled={busy} onClick={() => void hold(r, false)}>Unhold</button> : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}
    </>
  );
}
