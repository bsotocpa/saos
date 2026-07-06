'use client';

// Document Center (MP): drag-drop/camera upload, categories, per-file status,
// portal-only policy enforced in copy. Uploads can fulfil request items.

import { useEffect, useRef, useState } from 'react';
import { api, getToken } from '../../lib/api';
import { useSession } from '../../lib/session';
import type { DictKey } from '../../lib/i18n';

interface Doc { id: string; category: string; status: string; filename: string; tax_year: number | null; uploaded_at: string }
interface RequestItem { id: string; labelEn: string; labelEs: string | null; status: string }
interface DocRequest { id: string; title_en: string; title_es: string | null; items: RequestItem[] }

const CATEGORIES = ['tax_documents', 'business_records', 'id_verification', 'irs_notices', 'other'] as const;

export default function DocumentsPage() {
  const { t, lang } = useSession();
  const [docs, setDocs] = useState<Doc[]>([]);
  const [requests, setRequests] = useState<DocRequest[]>([]);
  const [category, setCategory] = useState<string>('tax_documents');
  const [itemId, setItemId] = useState<string>('');
  const [busy, setBusy] = useState(false);
  const [uploaded, setUploaded] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const load = async () => {
    const [d, r] = await Promise.all([
      api<{ documents: Doc[] }>('/portal/documents'),
      api<{ requests: DocRequest[] }>('/portal/document-requests'),
    ]);
    setDocs(d.documents);
    setRequests(r.requests);
  };
  useEffect(() => {
    void load();
  }, []);

  const openItems = requests.flatMap((r) =>
    r.items.filter((i) => i.status === 'pending').map((i) => ({ ...i, requestTitle: lang === 'es' ? (r.title_es ?? r.title_en) : r.title_en }))
  );

  const upload = async (file: File) => {
    setBusy(true);
    setUploaded(false);
    try {
      const fd = new FormData();
      fd.append('category', category);
      if (itemId) fd.append('documentRequestItemId', itemId);
      fd.append('file', file, file.name);
      await api('/portal/documents', { method: 'POST', formData: fd });
      setUploaded(true);
      setItemId('');
      if (fileRef.current) fileRef.current.value = '';
      await load();
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <h1>{t('docs_title')}</h1>
      <p className="alert info">{t('docs_policy')}</p>

      <section className="card">
        <h2>{t('docs_upload')}</h2>
        {uploaded ? <p className="alert info">{t('docs_uploaded')}</p> : null}
        <label className="field">
          {t('docs_category')}
          <select value={category} onChange={(e) => setCategory(e.target.value)}>
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
          <input
            ref={fileRef}
            type="file"
            accept="application/pdf,image/*"
            capture="environment"
            disabled={busy}
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void upload(file);
            }}
          />
        </label>
      </section>

      <section className="card">
        <ul className="list">
          {docs.map((d) => (
            <li key={d.id}>
              <span className="grow">
                <strong className="small">{d.filename}</strong>
                <br />
                <span className="muted small">
                  {t(`cat_${d.category}` as DictKey)}
                  {d.tax_year ? ` · ${d.tax_year}` : ''}
                </span>
              </span>
              <span className={`badge ${d.status === 'needs_replacement' ? 'danger' : d.status === 'accepted' ? 'ok' : ''}`}>
                {t(`doc_status_${d.status}` as DictKey)}
              </span>
              <a
                className="btn ghost"
                href={`/api/portal/documents/${d.id}/download`}
                onClick={(e) => {
                  // Authenticated download: fetch with the bearer, then save.
                  e.preventDefault();
                  void (async () => {
                    const res = await fetch(`/api/portal/documents/${d.id}/download`, {
                      headers: { authorization: `Bearer ${getToken() ?? ''}` },
                    });
                    const blob = await res.blob();
                    const url = URL.createObjectURL(blob);
                    const a = document.createElement('a');
                    a.href = url;
                    a.download = d.filename;
                    a.click();
                    URL.revokeObjectURL(url);
                  })();
                }}
              >
                {t('download')}
              </a>
            </li>
          ))}
        </ul>
      </section>
    </>
  );
}
