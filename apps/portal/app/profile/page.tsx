'use client';

// My Info (Form 4 step 1): confirm/update contact details; the language
// preference persists to the contact record and drives all outbound comms.

import { useEffect, useState } from 'react';
import { api } from '../../lib/api';
import { useSession } from '../../lib/session';
import type { DictKey } from '../../lib/i18n';

export default function ProfilePage() {
  const { t, me, lang, setLang, refresh } = useSession();
  const [form, setForm] = useState({
    firstName: '', lastName: '', phone: '', addressLine1: '', city: '', state: '', zip: '',
    preferredContactMethod: 'email',
  });
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (me) {
      setForm({
        firstName: me.first_name,
        lastName: me.last_name,
        phone: me.phone ?? '',
        addressLine1: me.address_line1 ?? '',
        city: me.city ?? '',
        state: me.state ?? '',
        zip: me.zip ?? '',
        preferredContactMethod: me.preferred_contact_method ?? 'email',
      });
    }
  }, [me]);

  const set = (key: keyof typeof form) => (e: { target: { value: string } }) =>
    setForm((f) => ({ ...f, [key]: e.target.value }));

  return (
    <>
      <h1>{t('prof_title')}</h1>
      <p className="muted">{t('prof_intro')}</p>
      <section className="card">
        {saved ? <p className="alert info">{t('prof_saved')}</p> : null}
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            try {
              await api('/portal/me', {
                method: 'PATCH',
                body: {
                  firstName: form.firstName, lastName: form.lastName, phone: form.phone || undefined,
                  addressLine1: form.addressLine1 || undefined, city: form.city || undefined,
                  state: form.state || undefined, zip: form.zip || undefined,
                  preferredContactMethod: form.preferredContactMethod,
                },
              });
              await api('/portal/onboarding/steps/confirm_info/complete', { method: 'POST' });
              await refresh();
              setSaved(true);
            } finally {
              setBusy(false);
            }
          }}
        >
          <div className="grid2">
            <label className="field">
              {t('prof_first')}
              <input value={form.firstName} onChange={set('firstName')} required />
            </label>
            <label className="field">
              {t('prof_last')}
              <input value={form.lastName} onChange={set('lastName')} required />
            </label>
          </div>
          <label className="field">
            {t('prof_phone')}
            <input value={form.phone} onChange={set('phone')} />
          </label>
          <label className="field">
            {t('prof_method')}
            <select value={form.preferredContactMethod} onChange={set('preferredContactMethod')}>
              {(['text', 'email', 'phone', 'portal'] as const).map((m) => (
                <option key={m} value={m}>
                  {t(`method_${m}` as DictKey)}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            {t('prof_address')}
            <input value={form.addressLine1} onChange={set('addressLine1')} />
          </label>
          <div className="grid2">
            <label className="field">
              {t('prof_city')}
              <input value={form.city} onChange={set('city')} />
            </label>
            <label className="field">
              {t('prof_zip')}
              <input value={form.zip} onChange={set('zip')} />
            </label>
          </div>
          <label className="field">
            {t('prof_language')}
            <select value={lang} onChange={(e) => setLang(e.target.value === 'es' ? 'es' : 'en')}>
              <option value="en">English</option>
              <option value="es">Español</option>
            </select>
          </label>
          <button className="btn" type="submit" disabled={busy}>
            {t('prof_save')}
          </button>
        </form>
      </section>
    </>
  );
}
