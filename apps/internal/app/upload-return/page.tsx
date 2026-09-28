'use client';

// Return delivery (MP ATX handoff): preparer finishes in ATX, exports the
// PDF, and uploads it here — it lands in the client's My Returns, the stage
// moves to Client Review, and the client is notified in their language.
// One manual step; everything else is automatic (M10 backend).

import { useState } from 'react';
import { api } from '../../lib/api';
import { clientChipType } from '../../lib/labels';
import { ClientChipBody } from '../../components/client-chip';

interface Contact { id: string; first_name: string; last_name: string; email: string | null; business_name?: string | null; business_matched?: boolean }
interface TaxEngagement { id: string; tax_year: number; return_type: string; stage: string }

export default function UploadReturnPage() {
  const [search, setSearch] = useState('');
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [contact, setContact] = useState<Contact | null>(null);
  const [engagements, setEngagements] = useState<TaxEngagement[]>([]);
  const [engagementId, setEngagementId] = useState('');
  const [taxYear, setTaxYear] = useState('');
  const [done, setDone] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // THE ERROR STAYS WITH THE CONTROL (Brian, 2026-09-19, defect 2): a refused search under the
  // search box, a refused pick beside that client's button, a refused delivery beside the file control.
  const [inlineErr, setInlineErr] = useState<{ key: string; message: string } | null>(null);
  const errAt = (key: string) => (inlineErr?.key === key ? <p className="field-error" role="alert">{inlineErr.message}</p> : null);
  const refused = (err: unknown) => (err instanceof Error && err.message ? err.message : 'The request was refused.');

  const findContacts = async () => {
    setInlineErr(null);
    try {
      const res = await api<{ contacts: Contact[] }>(`/contacts?search=${encodeURIComponent(search)}`);
      setContacts(res.contacts);
    } catch (err) {
      setInlineErr({ key: 'search', message: refused(err) });
    }
  };

  const pickContact = async (c: Contact) => {
    setInlineErr(null);
    setDone(null);
    try {
      const res = await api<{ taxEngagements: TaxEngagement[] }>(`/tax-engagements`);
      const own = res.taxEngagements.filter((t: TaxEngagement & { contact_id?: string }) => (t as { contact_id?: string }).contact_id === c.id);
      // The matches clear only once the pick succeeded, so a refusal has a button to sit beside.
      setContact(c);
      setContacts([]);
      setEngagements(own);
      if (own[0]) {
        setEngagementId(own[0].id);
        setTaxYear(String(own[0].tax_year));
      }
    } catch (err) {
      setInlineErr({ key: `pick:${c.id}`, message: refused(err) });
    }
  };

  const upload = async (file: File) => {
    if (!contact) return;
    setBusy(true);
    setInlineErr(null);
    setDone(null);
    try {
      const fd = new FormData();
      fd.append('contactId', contact.id);
      fd.append('category', 'return_deliverable');
      if (engagementId) fd.append('taxEngagementId', engagementId);
      if (taxYear) fd.append('taxYear', taxYear);
      fd.append('file', file, file.name);
      const res = await api<{ stageMoved: boolean; notice: { emailed: boolean; reason: 'sent' | 'automation_off' | 'no_email' } | null }>(
        '/documents', { method: 'POST', formData: fd }
      );
      /*
       * THE CONFIRMATION STATES WHAT HAPPENED (Brian, 2026-09-26, R48). This used to say "the client was
       * notified" from the stage move alone, while no return-delivered notice was armed anywhere. The
       * server now says whether the client was emailed and, if not, why; the words here are its answer.
       */
      const emailed = res.notice?.emailed
        ? 'The client was emailed.'
        : res.notice?.reason === 'no_email'
          ? 'The client was not emailed because the contact has no email address.'
          : 'The client was not emailed because that notice is switched off.';
      const stage = res.stageMoved ? 'The stage moved to Client Review.' : 'The stage is unchanged: its position does not allow the move.';
      setDone(`The return is on the portal. ${emailed} ${stage}`);
    } catch (err) {
      // A failed delivery says so, beside the file control — it used to say nothing.
      setInlineErr({ key: 'upload', message: refused(err) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <h1>Deliver a return</h1>
      <section className="card" style={{ maxWidth: 560 }}>
        {done ? <p className="alert info" data-testid="delivery-result">{done}</p> : null}
        <label className="field">
          Find the client
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && void findContacts()}
            placeholder="Name, business, email, or phone — press Enter"
          />
          {errAt('search')}
        </label>
        {contacts.map((c) => (
          <div key={c.id} style={{ margin: '8px 0' }}>
            <button className="btn ghost" type="button" data-testid="client-chip" data-type={clientChipType(c)} onClick={() => void pickContact(c)}>
              <ClientChipBody r={c} /> <span className="muted small">{c.email}</span>
            </button>
            {errAt(`pick:${c.id}`)}
          </div>
        ))}
        {contact ? (
          <>
            <p>
              Delivering to: <strong>{contact.first_name} {contact.last_name}</strong>
            </p>
            {engagements.length > 0 ? (
              <label className="field">
                Tax engagement
                <select value={engagementId} onChange={(e) => setEngagementId(e.target.value)}>
                  {engagements.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.tax_year} {t.return_type.toUpperCase()} — {t.stage}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
            <label className="field">
              Tax year
              <input value={taxYear} onChange={(e) => setTaxYear(e.target.value)} inputMode="numeric" />
            </label>
            <label className="field">
              Final return PDF (from ATX)
              <input
                type="file"
                accept="application/pdf"
                disabled={busy}
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) void upload(f);
                }}
              />
              {errAt('upload')}
            </label>
          </>
        ) : null}
      </section>
    </>
  );
}
