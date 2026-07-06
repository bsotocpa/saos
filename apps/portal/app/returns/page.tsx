'use client';

// My Returns (MP): every filed year, final PDF delivered here — replaces
// Dropbox links. Download any time.

import { useEffect, useState } from 'react';
import { api, getToken } from '../../lib/api';
import { useSession } from '../../lib/session';

interface Ret { id: string; filename: string; tax_year: number | null; uploaded_at: string }

export default function ReturnsPage() {
  const { t } = useSession();
  const [returns, setReturns] = useState<Ret[]>([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    void api<{ returns: Ret[] }>('/portal/returns').then((r) => {
      setReturns(r.returns);
      setLoaded(true);
    });
  }, []);

  return (
    <>
      <h1>{t('returns_title')}</h1>
      <p className="muted">{t('returns_intro')}</p>
      <section className="card">
        {loaded && returns.length === 0 ? <p className="muted">{t('returns_empty')}</p> : null}
        <ul className="list">
          {returns.map((r) => (
            <li key={r.id}>
              <span className="grow">
                <strong>{r.tax_year ?? '—'}</strong>
                <br />
                <span className="muted small">{r.filename}</span>
              </span>
              <button
                type="button"
                className="btn"
                onClick={() => {
                  void (async () => {
                    const res = await fetch(`/api/portal/documents/${r.id}/download`, {
                      headers: { authorization: `Bearer ${getToken() ?? ''}` },
                    });
                    const blob = await res.blob();
                    const url = URL.createObjectURL(blob);
                    const a = document.createElement('a');
                    a.href = url;
                    a.download = r.filename;
                    a.click();
                    URL.revokeObjectURL(url);
                  })();
                }}
              >
                {t('download')}
              </button>
            </li>
          ))}
        </ul>
      </section>
    </>
  );
}
