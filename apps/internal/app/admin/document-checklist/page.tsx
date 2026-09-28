'use client';

/*
 * ADMIN → DOCUMENT CHECKLIST (Brian, 2026-09-27, R83). Per price-book item, the documents a client owes
 * for it. Acceptance of a tax quote builds the return's checklist from its lines, and the portal shows
 * one upload slot per document. Edited here with no deploy: the English and Spanish words, the order,
 * on or off, and a new document for an item. A row is never deleted: switching it off stops it
 * reaching the next checklist; a checklist already opened keeps its own words.
 */
import { useEffect, useMemo, useState } from 'react';
import { api } from '../../../lib/api';

interface Row {
  id: string; item_code: string; item_name: string | null; doc_key: string;
  label_en: string; label_es: string; sort_order: number; active: boolean;
  updated_by: string | null;
}
interface Draft { labelEn: string; labelEs: string; sortOrder: string; active: boolean }

export default function DocumentChecklistAdminPage() {
  const [rows, setRows] = useState<Row[]>([]);
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [message, setMessage] = useState('');
  const [inlineErr, setInlineErr] = useState<{ at: string; message: string } | null>(null);
  const errAt = (at: string) => (inlineErr?.at === at ? <p className="field-error" role="alert">{inlineErr.message}</p> : null);
  const [adding, setAdding] = useState({ itemCode: '', docKey: '', labelEn: '', labelEs: '' });

  const load = async () => {
    const res = await api<{ items: Row[] }>('/admin/document-checklist');
    setRows(res.items);
  };
  useEffect(() => { void load(); }, []);

  const byItem = useMemo(() => {
    const m = new Map<string, Row[]>();
    for (const r of rows) m.set(r.item_code, [...(m.get(r.item_code) ?? []), r]);
    return [...m.entries()];
  }, [rows]);

  const draftOf = (r: Row): Draft => drafts[r.id] ?? { labelEn: r.label_en, labelEs: r.label_es, sortOrder: String(r.sort_order), active: r.active };
  const setDraft = (r: Row, patch: Partial<Draft>) => setDrafts((d) => ({ ...d, [r.id]: { ...draftOf(r), ...patch } }));

  const save = async (r: Row) => {
    const d = drafts[r.id];
    if (!d) return;
    setInlineErr(null);
    try {
      await api(`/admin/document-checklist/${r.id}`, {
        method: 'PATCH',
        body: { labelEn: d.labelEn, labelEs: d.labelEs, sortOrder: Number(d.sortOrder), active: d.active },
      });
      setMessage(`${r.item_code} · ${r.doc_key} saved (old → new recorded in the audit log). The next checklist uses it.`);
      setDrafts((all) => { const next = { ...all }; delete next[r.id]; return next; });
      await load();
    } catch (err) {
      setInlineErr({ at: r.id, message: err instanceof Error && err.message ? err.message : 'The request was refused.' });
    }
  };

  const add = async () => {
    setInlineErr(null);
    try {
      await api('/admin/document-checklist', { method: 'POST', body: { ...adding, itemCode: adding.itemCode.trim().toUpperCase() } });
      setMessage(`${adding.itemCode.trim().toUpperCase()} · ${adding.docKey} added. The next checklist for that item asks for it.`);
      setAdding({ itemCode: '', docKey: '', labelEn: '', labelEs: '' });
      await load();
    } catch (err) {
      setInlineErr({ at: 'add', message: err instanceof Error && err.message ? err.message : 'The request was refused.' });
    }
  };

  return (
    <>
      <h1>Document checklist</h1>
      <p className="muted small">
        What a client is asked to upload for each line of an accepted tax quote. Two lines asking for the same document ask once.
        Changes apply to the next checklist; one already opened keeps its words.
      </p>
      {message ? <p className="alert info" data-testid="checklist-admin-message">{message}</p> : null}
      {byItem.map(([itemCode, items]) => (
        <section className="card" key={itemCode} data-testid="checklist-item" data-item={itemCode}>
          <h2 className="small">{items[0]?.item_name ?? itemCode} <span className="muted">· {itemCode}</span></h2>
          {items.map((r) => {
            const d = draftOf(r);
            return (
              <div key={r.id} style={{ display: 'grid', gap: 6, borderTop: '1px solid var(--border)', paddingTop: 8, marginTop: 8 }} data-testid="checklist-row" data-doc={r.doc_key}>
                <span className="muted small">{r.doc_key}{r.active ? '' : ' · off'}{r.updated_by ? ` · last edited by ${r.updated_by}` : ''}</span>
                <label className="small">English
                  <textarea rows={2} value={d.labelEn} onChange={(e) => setDraft(r, { labelEn: e.target.value })} />
                </label>
                <label className="small">Spanish
                  <textarea rows={2} value={d.labelEs} onChange={(e) => setDraft(r, { labelEs: e.target.value })} />
                </label>
                <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
                  <label className="small">Order
                    <input type="number" style={{ width: 90 }} value={d.sortOrder} onChange={(e) => setDraft(r, { sortOrder: e.target.value })} />
                  </label>
                  <label className="small"><input type="checkbox" checked={d.active} onChange={(e) => setDraft(r, { active: e.target.checked })} /> Asked for</label>
                  {drafts[r.id] ? <button className="btn" type="button" onClick={() => void save(r)}>Save</button> : null}
                </div>
                {errAt(r.id)}
              </div>
            );
          })}
        </section>
      ))}
      <section className="card">
        <h2 className="small">Add a document to an item</h2>
        <div style={{ display: 'grid', gap: 6 }}>
          <label className="small">Price-book item code
            <input value={adding.itemCode} placeholder="IND_BASE_SINGLE" onChange={(e) => setAdding({ ...adding, itemCode: e.target.value })} />
          </label>
          <label className="small">Document key
            <input value={adding.docKey} placeholder="brokerage_statements" onChange={(e) => setAdding({ ...adding, docKey: e.target.value })} />
          </label>
          <label className="small">English
            <textarea rows={2} value={adding.labelEn} onChange={(e) => setAdding({ ...adding, labelEn: e.target.value })} />
          </label>
          <label className="small">Spanish
            <textarea rows={2} value={adding.labelEs} onChange={(e) => setAdding({ ...adding, labelEs: e.target.value })} />
          </label>
          <div><button className="btn" type="button" onClick={() => void add()}>Add document</button></div>
          {errAt('add')}
        </div>
      </section>
    </>
  );
}
