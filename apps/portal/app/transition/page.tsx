'use client';

// Form 3 (OF): the Hilo → Soto transition. Everything Hilo knows is
// pre-filled; the entrepreneur confirms, never re-types. The referral-
// integrity disclosure is a REQUIRED screen — no acknowledgement, no submit.
// Target: under 60 seconds tap-to-submitted.

import { Suspense, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { useSession } from '../../lib/session';
import type { DictKey } from '../../lib/i18n';

interface Prefill {
  language: 'en' | 'es';
  contact: { firstName: string; lastName: string; email: string | null; phone: string | null };
  business: { name: string; industry: string | null } | null;
  preCheckedServices: string[];
  disclosure: string;
  policyVersion: string;
}

const SERVICES = ['tax_personal', 'tax_business', 'bookkeeping', 'payroll', 'sales_tax', 'entity', 'cfo_advisory'] as const;
const SERVICE_LABELS: Record<string, [string, string]> = {
  tax_personal: ['Tax prep – personal', 'Impuestos – personales'],
  tax_business: ['Tax prep – business', 'Impuestos – de negocio'],
  bookkeeping: ['Bookkeeping', 'Contabilidad'],
  payroll: ['Payroll', 'Nómina'],
  sales_tax: ['Sales tax', 'Impuesto sobre ventas'],
  entity: ['Entity formation or conversion', 'Formación o conversión de entidad'],
  cfo_advisory: ['CFO–advisory', 'CFO–asesoría'],
};

function TransitionInner() {
  const { t, lang, setLang } = useSession();
  const params = useSearchParams();
  const rt = params.get('rt') ?? '';
  const [prefill, setPrefill] = useState<Prefill | null>(null);
  const [invalid, setInvalid] = useState(false);
  const [services, setServices] = useState<string[]>([]);
  const [ack, setAck] = useState(false);
  const [comm, setComm] = useState(false);
  const [esign, setEsign] = useState(false);
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!rt) {
      setInvalid(true);
      return;
    }
    void (async () => {
      const res = await fetch(`/api/public/transition?rt=${encodeURIComponent(rt)}`);
      if (!res.ok) {
        setInvalid(true);
        return;
      }
      const data = (await res.json()) as Prefill;
      setPrefill(data);
      setServices(data.preCheckedServices);
      setLang(data.language);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rt]);

  if (invalid) return <p className="alert error">{t('trans_invalid')}</p>;
  if (done)
    return (
      <div className="card" style={{ maxWidth: 480, margin: '40px auto', textAlign: 'center' }}>
        <h1>{t('trans_done_title')}</h1>
        <p className="muted">{t('trans_done_body')}</p>
      </div>
    );
  if (!prefill) return <p>{t('loading')}</p>;

  return (
    <div style={{ maxWidth: 520, margin: '0 auto' }}>
      <h1>{t('trans_title')}</h1>
      <p className="muted">{t('trans_intro')}</p>

      <section className="card">
        <h2>{t('trans_your_info')}</h2>
        <p>
          <strong>
            {prefill.contact.firstName} {prefill.contact.lastName}
          </strong>
          <br />
          <span className="muted small">
            {prefill.contact.email} · {prefill.contact.phone}
          </span>
          {prefill.business ? (
            <>
              <br />
              <span className="muted small">{prefill.business.name}</span>
            </>
          ) : null}
        </p>
      </section>

      <section className="card">
        <h2>{t('trans_services')}</h2>
        {SERVICES.map((s) => (
          <label key={s} className="field" style={{ display: 'flex', gap: 8, alignItems: 'center', fontWeight: 400 }}>
            <input
              type="checkbox"
              style={{ width: 'auto', margin: 0 }}
              checked={services.includes(s)}
              onChange={(e) =>
                setServices((prev) => (e.target.checked ? [...prev, s] : prev.filter((x) => x !== s)))
              }
            />
            {SERVICE_LABELS[s]![lang === 'es' ? 1 : 0]}
          </label>
        ))}
      </section>

      <section className="card" style={{ borderColor: 'var(--electric)' }} data-testid="disclosure-block">
        <h2>{t('trans_disclosure_title')}</h2>
        <p className="small">{prefill.disclosure}</p>
        <label className="field" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <input
            type="checkbox"
            style={{ width: 'auto', margin: 0 }}
            checked={ack}
            onChange={(e) => setAck(e.target.checked)}
            data-testid="disclosure-ack"
          />
          {t('trans_disclosure_ack')}
        </label>
      </section>

      <section className="card">
        <label className="field" style={{ display: 'flex', gap: 8, alignItems: 'center', fontWeight: 400 }}>
          <input type="checkbox" style={{ width: 'auto', margin: 0 }} checked={comm} onChange={(e) => setComm(e.target.checked)} />
          {t('trans_comm_consent')}
        </label>
        <label className="field" style={{ display: 'flex', gap: 8, alignItems: 'center', fontWeight: 400 }}>
          <input type="checkbox" style={{ width: 'auto', margin: 0 }} checked={esign} onChange={(e) => setEsign(e.target.checked)} />
          {t('trans_esign_consent')}
        </label>
        <button
          type="button"
          className="btn accent block"
          disabled={busy || !ack || !comm || !esign || services.length === 0}
          onClick={async () => {
            setBusy(true);
            try {
              const res = await fetch('/api/public/transition/submit', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({
                  rt,
                  services,
                  disclosureAcknowledged: ack,
                  communicationConsent: comm,
                  esignConsent: esign,
                }),
              });
              if (res.ok) setDone(true);
            } finally {
              setBusy(false);
            }
          }}
        >
          {t('trans_submit')}
        </button>
      </section>
    </div>
  );
}

export default function TransitionPage() {
  return (
    <Suspense>
      <TransitionInner />
    </Suspense>
  );
}
