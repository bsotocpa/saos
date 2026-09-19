'use client';

// Return delivery (MP ATX handoff): preparer finishes in ATX, exports the
// PDF, and uploads it here — it lands in the client's My Returns, the stage
// moves to Client Review, and the client is notified in their language.
// One manual step; everything else is automatic (M10 backend).

import { useState } from 'react';
import { api } from '../../lib/api';

interface Contact { id: string; first_name: string; last_name: string; email: string | null }
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
      const res = await api<{ stageMoved: boolean }>('/documents', { method: 'POST', formData: fd });
      setDone(
        res.stageMoved
          ? 'Delivered — stage moved to Client Review and the client was notified.'
          : 'Delivered — client notified. (Stage unchanged: pipeline position doesn’t allow the auto-move.)'
      );
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
        {done ? <p className="alert info">{done}</p> : null}
        <label className="field">
          Find the client
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && void findContacts()}
            placeholder="Name, email, or phone — press Enter"
          />
          {errAt('search')}
        </label>
        {contacts.map((c) => (
          <div key={c.id} style={{ margin: '8px 0' }}>
            <button className="btn ghost" type="button" onClick={() => void pickContact(c)}>
              {c.first_name} {c.last_name} <span className="muted small">{c.email}</span>
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
