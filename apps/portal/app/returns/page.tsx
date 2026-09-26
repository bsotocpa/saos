'use client';

// My Returns (MP): every filed year, final PDF delivered here — replaces
// Dropbox links. Download any time.

import { useEffect, useState } from 'react';
import { api } from '../../lib/api';
import { useSession } from '../../lib/session';
import { hasDictKey, type DictKey } from '../../lib/i18n';

/*
 * `next_step` is the return's state folded into one key by GET /portal/returns (R48): what the
 * client should expect next, from delivery through the 8879 (the R53 "8879 sent" fields) to the
 * acknowledgments. Null when the copy hangs on no return, or on a state with no sentence yet.
 */
interface Ret { id: string; filename: string; tax_year: number | null; uploaded_at: string; next_step: string | null }

export default function ReturnsPage() {
  const { t } = useSession();
  const [returns, setReturns] = useState<Ret[]>([]);
  const [loaded, setLoaded] = useState(false);
  // Keyed by return id so a failed download says so on ITS row.
  const [downloadError, setDownloadError] = useState<{ id: string; message: string } | null>(null);

  useEffect(() => {
    void api<{ returns: Ret[] }>('/portal/returns').then((r) => {
      setReturns(r.returns);
      setLoaded(true);
    });
  }, []);

  /** Authenticated by the httpOnly session cookie (same-origin). A failed response
   *  used to be saved AS the PDF — an error body with the return's filename. Now it
   *  is an error on the row, with the server's message. */
  const download = async (r: Ret) => {
    setDownloadError(null);
    try {
      const res = await fetch(`/api/portal/documents/${r.id}/download`);
      if (!res.ok) {
        const json = (await res.json().catch(() => ({}))) as { message?: string };
        setDownloadError({ id: r.id, message: json.message ?? t('error_generic') });
        return;
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = r.filename;
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      setDownloadError({ id: r.id, message: t('error_generic') });
    }
  };

  return (
    <>
      <h1>{t('returns_title')}</h1>
      <p className="muted">{t('returns_intro')}</p>
      <section className="card">
        {loaded && returns.length === 0 ? <p className="muted">{t('returns_empty')}</p> : null}
        <ul className="list">
          {returns.map((r) => (
            <li key={r.id} data-testid="return-row">
              <span className="grow">
                <strong>{r.tax_year ?? '—'}</strong>
                <br />
                <span className="muted small">{r.filename}</span>
                {/* WHAT HAPPENS NEXT (R48): the key is rendered only when the dictionary carries it, so a
                    state the API learns before the portal does prints nothing rather than a raw key. */}
                {r.next_step && hasDictKey(`returns_next_${r.next_step}`) ? (
                  <span className="small" style={{ display: 'block', marginTop: 6 }} data-testid="returns-next" data-step={r.next_step}>
                    <strong>{t('returns_next_title')}:</strong> {t(`returns_next_${r.next_step}` as DictKey)}
                  </span>
                ) : null}
              </span>
              <span style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4 }}>
                <button type="button" className="btn" onClick={() => void download(r)}>
                  {t('download')}
                </button>
                {downloadError?.id === r.id ? <p className="field-error" role="alert">{downloadError.message}</p> : null}
              </span>
            </li>
          ))}
        </ul>
      </section>
    </>
  );
}
