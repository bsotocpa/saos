'use client';

// Document Center (MP): drag-drop/camera upload, categories, per-file status,
// portal-only policy enforced in copy. Uploads can fulfil request items.

import { useEffect, useRef, useState } from 'react';
import { api, ApiError } from '../../lib/api';
import { useSession } from '../../lib/session';
import { useAsk } from '../../components/ask';
import { docCategoryLabel, docStatusLabel, docStatusTone, type DictKey } from '../../lib/i18n';

/*
 * A row is whatever the firm or the client filed: the five client categories AND the staff-filed
 * ones (signed_authorizations, return_deliverable, mailing_receipts, ...). Its labels come from
 * docCategoryLabel()/docStatusLabel() in lib/i18n.ts, never from `t()` on an assembled key: that assertion is what threw on Brian's
 * account (R49, 2026-09-26). `filename` is typed as the API declares it; the render below still
 * reads it defensively, because a page that dies leaves the client with nothing.
 */
interface Doc {
  id: string; category: string; status: string; filename: string; tax_year: number | null; uploaded_at: string;
  /** R96: the checklist items this file counts as. */
  counts_as?: Array<{ itemId: string; labelEn: string; labelEs: string | null }>;
  /** R110: the return the file belongs to (filed against it, or answering its checklist), if any. */
  return_id?: string | null; return_year?: number | null; return_type?: string | null; return_business?: string | null;
}
interface RequestItem { id: string; labelEn: string; labelEs: string | null; status: string }
interface DocRequest { id: string; title_en: string; title_es: string | null; items: RequestItem[] }
/** One line per file the client just chose: its name and what happened to it (R47). */
interface UploadResult { name: string; ok: boolean; message: string }

const CATEGORIES = ['tax_documents', 'business_records', 'id_verification', 'irs_notices', 'other'] as const;

/** R83: the return's document checklist, as GET /portal/checklists returns it. */
interface ChecklistItem { id: string; docKey: string | null; labelEn: string; labelEs: string | null; status: 'pending' | 'received' | 'waived' }
interface Checklist { id: string; tax_year: number; return_type: string; items: ChecklistItem[] }

/** "1120s" → "1120-S", "990ez" → "990-EZ": the form number as the client reads it. */
function formNumber(returnType: string): string {
  if (returnType === 'w7_itin') return 'W-7';
  const m = /^([a-z]*)(\d+)([a-z]*)/.exec(returnType);
  if (!m) return returnType.toUpperCase();
  return `${m[1]!.toUpperCase()}${m[2]}${m[3] ? `-${m[3].toUpperCase()}` : ''}`;
}

/*
 * THE CHECKLIST CARD (Brian, 2026-09-27, R83). One card per open return with a checklist: each item
 * with its status and, while it is needed, its own upload slot. A slot's first file answers the item
 * (one answer per item, as the request rows hold); any further file in the same pick is filed beside
 * it. What happens next reads from the list: the count still missing, or that everything is in.
 */
function ChecklistCard({ c, onChanged }: { c: Checklist; onChanged: () => Promise<void> }) {
  const { t, lang } = useSession();
  const [busyItem, setBusyItem] = useState('');
  const [itemResults, setItemResults] = useState<Record<string, UploadResult[]>>({});
  const received = c.items.filter((i) => i.status !== 'pending').length;
  const missing = c.items.length - received;
  const upload = async (item: ChecklistItem, files: File[]) => {
    setBusyItem(item.id);
    const lines: UploadResult[] = [];
    let answer: string = item.id;
    try {
      for (const file of files) {
        try {
          const fd = new FormData();
          fd.append('category', 'tax_documents');
          if (answer) fd.append('documentRequestItemId', answer);
          fd.append('file', file, file.name);
          await api('/portal/documents', { method: 'POST', formData: fd });
          lines.push({ name: file.name, ok: true, message: t('docs_file_uploaded') });
          answer = '';
        } catch (err) {
          lines.push({ name: file.name, ok: false, message: err instanceof ApiError ? err.message : t('error_generic') });
        }
      }
      setItemResults((r) => ({ ...r, [item.id]: lines }));
      await onChanged();
    } finally {
      setBusyItem('');
    }
  };
  return (
    <section className="card" data-testid="checklist" data-return={`${c.tax_year}-${c.return_type}`}>
      <h2>{t('cl_title').replace('{{year}}', String(c.tax_year)).replace('{{form}}', formNumber(c.return_type))}</h2>
      <p className="small" data-testid="checklist-next" data-missing={missing}>
        <strong>{t('returns_next_title')}:</strong>{' '}
        <span data-testid="checklist-progress">{t('cl_progress').replace('{{received}}', String(received)).replace('{{total}}', String(c.items.length))}</span>.{' '}
        {missing > 0 ? t('cl_next_missing') : t('cl_next_done')}
      </p>
      <ul className="list">
        {c.items.map((i) => (
          /* R105 (2026-09-30): the item's name on its own full-width line with its status beside it, the
             upload control full width beneath — never squeezed into one row with the two. */
          <li key={i.id} className="cl-item" data-testid="checklist-item" data-doc={i.docKey ?? ''} data-status={i.status}>
            <span className="cl-head">
              <span className="cl-name" data-testid="checklist-item-name">{lang === 'es' ? (i.labelEs ?? i.labelEn) : i.labelEn}</span>
              <span className={`badge ${i.status === 'pending' ? 'warn' : 'ok'}`}>
                {t(i.status === 'pending' ? 'cl_needed' : i.status === 'received' ? 'cl_received' : 'cl_waived')}
              </span>
            </span>
            {(itemResults[i.id] ?? []).map((r) => (
              <span key={r.name} className={`small ${r.ok ? 'muted' : 'field-error'}`} style={{ display: 'block' }} data-testid="checklist-result" data-ok={r.ok ? 'true' : 'false'}>
                {r.name}: {r.message}
              </span>
            ))}
            {i.status === 'pending' ? (
              <label className="btn ghost cl-upload" style={{ cursor: 'pointer' }}>
                {t('cl_upload')}
                {/* No `capture` (R47): iOS offers Photo Library, Take Photo and Files. */}
                <input
                  type="file"
                  accept="image/*,application/pdf"
                  multiple
                  hidden
                  data-testid="checklist-upload"
                  disabled={busyItem !== ''}
                  onChange={(e) => {
                    const files = Array.from(e.target.files ?? []);
                    e.target.value = '';
                    if (files.length > 0) void upload(i, files);
                  }}
                />
              </label>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}

export default function DocumentsPage() {
  const { t, lang } = useSession();
  const ask = useAsk();
  const [docs, setDocs] = useState<Doc[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [requests, setRequests] = useState<DocRequest[]>([]);
  const [checklists, setChecklists] = useState<Checklist[]>([]);
  // R47: the category starts UNSELECTED. A file chosen before one is picked is refused here, inline.
  const [category, setCategory] = useState<string>('');
  const [itemId, setItemId] = useState<string>('');
  const [busy, setBusy] = useState(false);
  const [uploaded, setUploaded] = useState(false);
  const [uploadError, setUploadError] = useState('');
  const [results, setResults] = useState<UploadResult[]>([]);
  // Keyed by document id so a failed download says so on ITS row, not at the page top.
  const [downloadError, setDownloadError] = useState<{ id: string; message: string } | null>(null);
  /** R96: the item a file already sent is for, picked on its row; the refusal beside it. */
  const [countsPick, setCountsPick] = useState<Record<string, string>>({});
  const [countsErr, setCountsErr] = useState<{ id: string; message: string } | null>(null);
  // R96: the checklist items still pending, which a file already sent can count as.
  const checklistOpenItems = checklists.flatMap((c) => c.items.filter((i) => i.status === 'pending').map((i) => ({
    id: i.id, labelEn: i.labelEn, labelEs: i.labelEs, year: c.tax_year, form: formNumber(c.return_type),
  })));
  const fileRef = useRef<HTMLInputElement>(null);

  const load = async () => {
    const [d, r, cl] = await Promise.all([
      api<{ documents: Doc[] }>('/portal/documents'),
      api<{ requests: DocRequest[] }>('/portal/document-requests'),
      api<{ checklists: Checklist[] }>('/portal/checklists').catch(() => ({ checklists: [] as Checklist[] })),
    ]);
    setDocs(d.documents);
    setRequests(r.requests);
    setChecklists(cl.checklists);
    setLoaded(true);
  };
  useEffect(() => {
    void load();
  }, []);

  const openItems = requests.flatMap((r) =>
    r.items.filter((i) => i.status === 'pending').map((i) => ({ ...i, requestTitle: lang === 'es' ? (r.title_es ?? r.title_en) : r.title_en }))
  );

  /*
   * SEVERAL FILES AT ONCE (Brian, 2026-09-26, R47). The input is `multiple`; each file goes up on its
   * own and gets its own result line, so one refused file (too large, wrong type) does not hide the
   * others' success. A request item is fulfilled by the first file only — one answer per item.
   */
  const uploadAll = async (files: File[]) => {
    setUploaded(false);
    setUploadError('');
    setResults([]);
    if (!category) {
      // Refused here, before anything is sent: the control asked for a category first.
      setUploadError(t('docs_category_required'));
      if (fileRef.current) fileRef.current.value = '';
      return;
    }
    setBusy(true);
    const lines: UploadResult[] = [];
    let fulfilItem = itemId;
    try {
      for (const file of files) {
        try {
          const fd = new FormData();
          fd.append('category', category);
          if (fulfilItem) fd.append('documentRequestItemId', fulfilItem);
          fd.append('file', file, file.name);
          await api('/portal/documents', { method: 'POST', formData: fd });
          lines.push({ name: file.name, ok: true, message: t('docs_file_uploaded') });
          fulfilItem = '';
        } catch (err) {
          // The server's refusal, verbatim, on THIS file's line. The category and request
          // selections stay as they were so the client can fix and retry.
          lines.push({ name: file.name, ok: false, message: err instanceof ApiError ? err.message : t('error_generic') });
        }
        setResults([...lines]);
      }
      if (lines.some((l) => l.ok)) {
        setUploaded(true);
        setItemId('');
      }
      if (fileRef.current) fileRef.current.value = '';
      await load();
    } finally {
      setBusy(false);
    }
  };

  /** Authenticated by the httpOnly session cookie (same-origin). A failed response
   *  is an error to show on the row, never a body to save as the file. */
  const download = async (d: Doc) => {
    setDownloadError(null);
    try {
      const res = await fetch(`/api/portal/documents/${d.id}/download`);
      if (!res.ok) {
        const json = (await res.json().catch(() => ({}))) as { message?: string };
        setDownloadError({ id: d.id, message: json.message ?? t('error_generic') });
        return;
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = d.filename;
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      setDownloadError({ id: d.id, message: t('error_generic') });
    }
  };

  /** R110: the files by the return they belong to — individual returns, then a business's, newest year first — then the rest. */
  type Group = { key: string; year: number | null; form: string | null; business: string | null; docs: Doc[] };
  const groupsOf = (all: Doc[]): Group[] => {
    const byKey = new Map<string, Group>();
    for (const d of all) {
      const key = d.return_id ?? 'none';
      if (!byKey.has(key)) byKey.set(key, { key, year: d.return_year ?? null, form: d.return_type ? formNumber(d.return_type) : null, business: d.return_business ?? null, docs: [] });
      byKey.get(key)!.docs.push(d);
    }
    return [...byKey.values()].sort((a, b) => {
      if (a.key === 'none' || b.key === 'none') return a.key === 'none' ? 1 : -1;
      if (!!a.business !== !!b.business) return a.business ? 1 : -1;
      return (b.year ?? 0) - (a.year ?? 0) || (a.business ?? '').localeCompare(b.business ?? '');
    });
  };
  const groupTitle = (g: Group): string => {
    if (g.key === 'none' || g.year === null || g.form === null) return t('docs_group_none');
    const fill = (k: 'docs_group_return' | 'docs_group_business_return') =>
      t(k).replace('{{year}}', String(g.year)).replace('{{form}}', g.form ?? '').replace('{{business}}', g.business ?? '');
    return g.business ? fill('docs_group_business_return') : fill('docs_group_return');
  };

  return (
    <>
      <h1>{t('docs_title')}</h1>
      <p className="alert info">{t('docs_policy')}</p>
      {checklists.map((c) => <ChecklistCard key={c.id} c={c} onChanged={load} />)}

      {/*
        THE LIST, BY RETURN (Brian, 2026-09-30, R110). Each file sits under the return it belongs to —
        "Your 2025 Form 1040", "Soto Accounting LLC, 2025 Form 1120-S" — or under "Not tied to a return".
        Superseded files never reach this list (the API leaves them in Ops). The checklists above stay the
        way documents come in; the general upload follows the list as "Something else".
      */}
      <section className="card" data-testid="documents-list">
        <h2>{t('docs_list_title')}</h2>
        {/* R47: the list never sits empty without a word. */}
        {loaded && docs.length === 0 ? <p className="muted" data-testid="docs-empty">{t('docs_empty')}</p> : null}
        {groupsOf(docs).map((g) => (
          <div key={g.key} className="doc-group" data-testid="document-group" data-return={g.key}>
            <h3 className="doc-group-title">{groupTitle(g)}</h3>
            <ul className="list">
              {g.docs.map((d) => (
                /* R105 (2026-09-30): a stacked row at every width — the name and its status on top, what it is
                   and what it counts as beneath (in words, R110), the match control full width below 768, and
                   the actions in a row that wraps. Nothing shares a line it has to be squeezed to fit. */
                <li key={d.id} className="doc-row" data-testid="document-row" data-category={d.category}>
                  <span className="doc-head">
                    <strong className="doc-name">{d.filename ?? ''}</strong>
                    <span className={`badge ${docStatusTone(d.status)}`}>{docStatusLabel(lang, d.status)}</span>
                  </span>
                  <span className="muted small doc-line">
                    {docCategoryLabel(lang, d.category)}
                    {d.tax_year ? ` · ${d.tax_year}` : ''}
                  </span>
                  {(d.counts_as ?? []).length > 0 ? (
                    <span className="small doc-line" data-testid="doc-counts-as">
                      {t('doc_counts_as')}: {(d.counts_as ?? []).map((c) => (lang === 'es' ? c.labelEs || c.labelEn : c.labelEn)).join(', ')}
                    </span>
                  ) : (
                    <span className="muted small doc-line" data-testid="doc-counts-as-none">{t('doc_counts_as_none')}</span>
                  )}
                  {(d.counts_as ?? []).length === 0 && checklistOpenItems.length > 0 ? (
                    <span className="doc-match">
                      <select
                        aria-label={t('doc_counts_as_pick')}
                        data-testid="doc-counts-as-select"
                        value={countsPick[d.id] ?? ''}
                        onChange={(e) => setCountsPick((prev) => ({ ...prev, [d.id]: e.target.value }))}
                      >
                        <option value="">{t('doc_counts_as_pick')}</option>
                        {checklistOpenItems.map((it) => (
                          <option key={it.id} value={it.id}>{it.year} {it.form}: {lang === 'es' ? it.labelEs || it.labelEn : it.labelEn}</option>
                        ))}
                      </select>
                      <button
                        type="button"
                        className="btn ghost"
                        data-testid="doc-counts-as-save"
                        disabled={!countsPick[d.id]}
                        onClick={async () => {
                          setCountsErr(null);
                          try {
                            await api(`/portal/documents/${d.id}/counts-as`, { method: 'POST', body: { itemId: countsPick[d.id] } });
                            await load();
                          } catch (err) {
                            setCountsErr({ id: d.id, message: err instanceof Error && err.message ? err.message : t('error_generic') });
                          }
                        }}
                      >
                        {t('doc_counts_as_save')}
                      </button>
                      {countsErr?.id === d.id ? <p className="field-error" role="alert" style={{ flexBasis: '100%' }}>{countsErr.message}</p> : null}
                    </span>
                  ) : null}
                  <span className="doc-actions">
                    <a
                      className="btn ghost"
                      href={`/api/portal/documents/${d.id}/download`}
                      onClick={(e) => {
                        e.preventDefault();
                        void download(d);
                      }}
                    >
                      {t('download')}
                    </a>
                    {/* REMOVE = WITHDRAW, never delete (Brian's ruling, 2026-08-13). A client
                        who uploads the wrong file needs an undo; the record needs to keep the
                        fact that they sent it. So this hides the file, un-fulfils whatever it
                        was answering — the chase resumes — and leaves the row stamped with
                        who withdrew it. The confirm says exactly that, because "Remove" on its
                        own implies a deletion we are not doing.

                        The modal does the work (`run`): a refusal renders verbatim inside it
                        and it stays open; the row reloads only after the withdraw succeeded. */}
                    <button
                      className="btn ghost"
                      type="button"
                      disabled={busy}
                      onClick={async () => {
                        const r = await ask({
                          lang,
                          title: t('doc_withdraw_confirm'),
                          choices: [{ key: 'withdraw', label: t('doc_withdraw'), tone: 'danger' }],
                          run: async () => {
                            await api(`/portal/documents/${d.id}/withdraw`, { method: 'POST' });
                          },
                        });
                        if (!r) return;
                        await load();
                      }}
                    >
                      {t('doc_withdraw')}
                    </button>
                  </span>
                  {downloadError?.id === d.id ? <p className="field-error" role="alert">{downloadError.message}</p> : null}
                </li>
              ))}
            </ul>
          </div>
        ))}
      </section>

      <section className="card" data-testid="something-else">
        <h2>{t('docs_something_else')}</h2>
        <p className="muted small">{t('docs_something_else_hint')}</p>
        {uploaded ? <p className="alert info">{t('docs_uploaded')}</p> : null}
        <label className="field">
          {t('docs_category')}
          <select value={category} onChange={(e) => setCategory(e.target.value)} data-testid="docs-category">
            <option value="">{t('docs_category_placeholder')}</option>
            {CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {t(`cat_${c}` as DictKey)}
              </option>
            ))}
          </select>
        </label>
        {openItems.length > 0 ? (
          <label className="field">
            {t('docs_for_request')}
            <select value={itemId} onChange={(e) => setItemId(e.target.value)}>
              <option value="">—</option>
              {openItems.map((i) => (
                <option key={i.id} value={i.id}>
                  {i.requestTitle}: {lang === 'es' ? (i.labelEs ?? i.labelEn) : i.labelEn}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        <label className="field">
          {t('docs_choose')}
          {/*
            NO `capture` ATTRIBUTE (Brian, 2026-09-26, R47). `capture="environment"` told iOS Safari to
            open the rear camera directly, so "Choose File" offered no Photo Library and no Files. A
            plain file input with accept="image/*,application/pdf" is what makes iOS show its own sheet:
            Photo Library, Take Photo, Choose Files. `multiple` lets the client send several at once.
          */}
          <input
            ref={fileRef}
            type="file"
            accept="image/*,application/pdf"
            multiple
            disabled={busy}
            aria-invalid={uploadError ? true : undefined}
            onChange={(e) => {
              const files = Array.from(e.target.files ?? []);
              if (files.length > 0) void uploadAll(files);
            }}
          />
        </label>
        {uploadError ? <p className="field-error" role="alert">{uploadError}</p> : null}
        {results.length > 0 ? (
          <ul className="list" data-testid="upload-results">
            {results.map((r) => (
              <li key={r.name} data-testid="upload-result" data-ok={r.ok ? 'true' : 'false'}>
                <span className="grow small">{r.name}</span>
                <span className={`small ${r.ok ? 'muted' : 'field-error'}`}>{r.message}</span>
              </li>
            ))}
          </ul>
        ) : null}
      </section>

    </>
  );
}
