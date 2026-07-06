'use client';

// Sign Documents (MP): engagement letters, §7216 consents, 8879s. Docuseal
// emails the signing link when an envelope goes out; statuses live here.

import { useEffect, useState } from 'react';
import { api } from '../../lib/api';
import { useSession } from '../../lib/session';
import type { DictKey } from '../../lib/i18n';

interface Envelope {
  id: string;
  type: string;
  status: string;
  sent_at: string | null;
  completed_at: string | null;
}

function statusKey(status: string): DictKey {
  if (status === 'completed') return 'env_status_completed';
  if (status === 'sent' || status === 'viewed') return 'env_status_sent';
  if (status.startsWith('kba')) return 'env_status_kba';
  return 'env_status_draft';
}

export default function SignPage() {
  const { t } = useSession();
  const [envelopes, setEnvelopes] = useState<Envelope[]>([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    void api<{ envelopes: Envelope[] }>('/portal/signature-envelopes').then((r) => {
      setEnvelopes(r.envelopes);
      setLoaded(true);
    });
  }, []);

  return (
    <>
      <h1>{t('sign_title')}</h1>
      <p className="muted">{t('sign_intro')}</p>
      <section className="card">
        {loaded && envelopes.length === 0 ? <p className="muted">{t('sign_empty')}</p> : null}
        <ul className="list">
          {envelopes.map((e) => (
            <li key={e.id}>
              <span className="grow">{t(`env_${e.type}` as DictKey)}</span>
              <span className={`badge ${e.status === 'completed' ? 'ok' : e.status === 'draft' ? '' : 'warn'}`}>
                {t(statusKey(e.status))}
              </span>
            </li>
          ))}
        </ul>
      </section>
    </>
  );
}
