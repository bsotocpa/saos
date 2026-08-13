'use client';

// §7216 CONSENT — ITS OWN SCREEN, AND NOTHING ELSE ON IT.
//
// Rev. Proc. 2013-14: an electronic §7216 consent from a 1040-series client must be
// presented on a screen whose content pertains SOLELY to the consent. That is why
// this is a route rather than a card: no checklist, no progress bar, no nav, no
// thank-you residue from the signature, nothing else competing for the tap.
//
// Brian's finding, 2026-08-11: the consent used to render on /sign directly beneath
// the "Signed — thank you" panel, and he granted it six seconds after signing without
// registering it as a separate thing. The data was correct and the ordering was legal,
// but the presentation let a consent feel continuous with the engagement — precisely
// what the separate-screen rule exists to prevent.
//
// LAUNCH-GATE TIER (lessons.md): consent-screen isolation is not a style preference.
// Adding chrome to this page breaks the consent, not just the layout.

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { api, ApiError, isAuthed } from '../../lib/api';
import { useSession } from '../../lib/session';

interface ConsentOffer {
  kind: '7216_use' | '7216_disclose';
  headlineEn: string;
  bodyEn: string;
  legalEn: string;
  legalEs: string | null;
  templateVersion: number;
}

export default function ConsentPage() {
  const router = useRouter();
  const { t, lang } = useSession();
  const [offers, setOffers] = useState<ConsentOffer[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [answered, setAnswered] = useState<'yes' | 'no' | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await api<{ offers: ConsentOffer[] }>('/portal/consents');
      setOffers(r.offers);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('error_generic'));
      setOffers([]);
    }
  }, [t]);

  useEffect(() => {
    if (!isAuthed()) {
      router.replace('/login');
      return;
    }
    void load();
  }, [router, load]);

  const answer = async (granted: boolean) => {
    const offer = offers?.[0];
    if (!offer) return;
    setBusy(true);
    setError(null);
    try {
      await api('/portal/consents', { method: 'POST', body: { kind: offer.kind, granted } });
      setAnswered(granted ? 'yes' : 'no');
      // Re-read: if a second consent is genuinely owed (a Hilo-bridge client), it
      // gets its own screen too rather than appearing beside the first.
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('error_generic'));
    } finally {
      setBusy(false);
    }
  };

  if (offers === null) return <p className="muted">{t('loading')}</p>;

  // Nothing (or nothing left) to ask: acknowledge and hand them onward.
  if (offers.length === 0) {
    return (
      <>
        <h1>{answered ? t(answered === 'yes' ? 'consent_recorded_yes' : 'consent_recorded_no') : t('consent_none_title')}</h1>
        <p className="muted">{t('consent_done_body')}</p>
        <p>
          <button className="btn accent" type="button" onClick={() => router.push('/')}>
            {t('consent_continue')}
          </button>
        </p>
      </>
    );
  }

  const offer = offers[0]!;

  return (
    <>
      {/* SOLELY the consent from here down. */}
      <h1>{offer.headlineEn}</h1>

      <section className="card">
        <p style={{ whiteSpace: 'pre-wrap' }}>{offer.bodyEn}</p>

        {/* THE CONSENT ITSELF.
            This screen used to show only the framing above and capture an answer, while
            the consent row stamped a template version the client had never been shown.
            §7216 requires the mandated statements to be IN the consent, so they are here.

            Bilingual with English operative (Brian's ruling after attorney review):
            Spanish first when that is the client's language and the translation is
            approved, English always, and a line saying which one governs. */}
        {offer.legalEs ? (
          <>
            <p className="small" style={{ whiteSpace: 'pre-wrap' }}>{offer.legalEs}</p>
            <p className="muted small">{t('english_governs')}</p>
          </>
        ) : null}
        <p className="small" style={{ whiteSpace: 'pre-wrap' }}>{offer.legalEn}</p>

        <p className="small">
          <strong>{t('consent_duration_label')}</strong> {t('consent_duration_body')}
        </p>

        <p className="muted small">{t('consent_optional')}</p>

        {error ? <p className="alert error">{error}</p> : null}

        {/* Equal weight, deliberately. A decline that looks like the lesser button is
            a decline the client is being nudged out of, and a §7216 consent must not
            be nudged. Neither choice affects service. */}
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginTop: 12 }}>
          <button
            className="btn accent"
            type="button"
            disabled={busy}
            style={{ flex: '1 1 200px' }}
            onClick={() => void answer(true)}
          >
            {t('consent_yes')}
          </button>
          <button
            className="btn"
            type="button"
            disabled={busy}
            style={{ flex: '1 1 200px' }}
            onClick={() => void answer(false)}
          >
            {t('consent_no')}
          </button>
        </div>
      </section>
    </>
  );
}
