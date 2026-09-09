'use client';

// Client notice view (M28, wireframe customer step 8): "you see it's handled — in
// plain language."
//
// The tone here is the whole point. A letter from the IRS is frightening, and the
// wireframe's promise is that the client stops having to ask whether we got it. So
// this page states what we have, what it is about, when the response is due, and
// that we are handling it — and never shows the internal machinery (who owns the
// ticket, what escalation rung it is on, the service tier).

import { dayOf, formatDate, formatDateTime, formatTime } from '../../lib/dates';
import { useEffect, useState } from 'react';
import { api } from '../../lib/api';
import { useSession } from '../../lib/session';
import type { DictKey } from '../../lib/i18n';

interface Notice {
  id: string;
  noticeType: string;
  taxYear: number | null;
  responseDeadline: string | null;
  receivedAt: string | null;
  clientState: 'in_progress' | 'response_sent' | 'resolved';
}

const STATE_KEY: Record<Notice['clientState'], DictKey> = {
  in_progress: 'notice_state_working',
  response_sent: 'notice_state_sent',
  resolved: 'notice_state_resolved',
};

export default function NoticesPage() {
  const { t, lang } = useSession();
  const [notices, setNotices] = useState<Notice[]>([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    void api<{ notices: Notice[] }>('/portal/notices')
      .then((r) => setNotices(r.notices))
      .catch(() => setNotices([]))
      .finally(() => setLoaded(true));
  }, []);

  return (
    <>
      <h1>{t('notices_title')}</h1>
      {!loaded ? <p className="muted">{t('loading')}</p> : null}

      {loaded && notices.length === 0 ? (
        <section className="card">
          <p>{t('notices_none')}</p>
          <p className="muted small">{t('notices_none_hint')}</p>
        </section>
      ) : null}

      {notices.map((n) => (
        <section className="card" key={n.id} style={{ marginBottom: 10 }}>
          <h2>
            {n.noticeType}
            {n.taxYear ? ` · ${n.taxYear}` : ''}
          </h2>
          <p className="small">
            <strong>{t(STATE_KEY[n.clientState])}</strong>
          </p>
          {n.responseDeadline && n.clientState !== 'resolved' ? (
            <p className="muted small">
              {t('notice_response_due')} {n.responseDeadline}
            </p>
          ) : null}
          {n.receivedAt ? (
            <p className="muted small">
              {t('notice_received')} {dayOf(n.receivedAt, lang)}
            </p>
          ) : null}
        </section>
      ))}

      {loaded && notices.length > 0 ? (
        <section className="card">
          <p className="muted small">{t('notices_upload_hint')}</p>
        </section>
      ) : null}
    </>
  );
}
