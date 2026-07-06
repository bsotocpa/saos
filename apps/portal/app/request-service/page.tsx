'use client';

// Request a Service (MP): → CRM opportunity, 24-hour response commitment.

import { useState } from 'react';
import { api } from '../../lib/api';
import { useSession } from '../../lib/session';
import type { DictKey } from '../../lib/i18n';

const SERVICES = ['tax', 'bookkeeping', 'advisory', 'entity', 'irs_notice_help', 'other'] as const;

export default function RequestServicePage() {
  const { t } = useSession();
  const [service, setService] = useState<string>('tax');
  const [notes, setNotes] = useState('');
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);

  return (
    <>
      <h1>{t('req_title')}</h1>
      <p className="muted">{t('req_intro')}</p>
      <section className="card">
        {sent ? (
          <p className="alert info">{t('req_sent')}</p>
        ) : (
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              setBusy(true);
              try {
                await api('/portal/service-requests', { method: 'POST', body: { service, notes: notes || undefined } });
                setSent(true);
              } finally {
                setBusy(false);
              }
            }}
          >
            <label className="field">
              {t('req_service')}
              <select value={service} onChange={(e) => setService(e.target.value)}>
                {SERVICES.map((s) => (
                  <option key={s} value={s}>
                    {t(`svc_${s}` as DictKey)}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              {t('req_notes')}
              <textarea rows={4} value={notes} onChange={(e) => setNotes(e.target.value)} />
            </label>
            <button className="btn" type="submit" disabled={busy}>
              {t('req_send')}
            </button>
          </form>
        )}
      </section>
    </>
  );
}
