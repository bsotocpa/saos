'use client';

// Hilo events, staff side (M27): the list, the door (check-in), and close-out.
//
// The check-in view is the one that gets used under pressure — a room filling up
// while someone holds a phone — so it is a big list with one tap per person and no
// nesting. Everything else is secondary.

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { api, isAuthed } from '../../lib/api';

interface EventRow {
  slug: string;
  title_en: string;
  program: string | null;
  starts_at: string;
  capacity: number;
  status: string;
  confirmed: number;
  waitlisted: number;
  attended: number;
}
interface Registration {
  id: string;
  first_name: string;
  last_name: string;
  email: string;
  phone: string | null;
  language: string;
  status: string;
  seat_number: number | null;
  checked_in_at: string | null;
  in_crm: boolean;
}
interface Impact {
  registered: number; attended: number; no_shows: number; waitlisted: number;
  surveys_answered: number; avg_satisfaction: string | null; avg_nps: string | null;
}

export default function EventsPage() {
  const router = useRouter();
  const [events, setEvents] = useState<EventRow[]>([]);
  const [open, setOpen] = useState<string>('');
  const [regs, setRegs] = useState<Registration[]>([]);
  const [impact, setImpact] = useState<Impact | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setEvents((await api<{ events: EventRow[] }>('/events')).events);
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  const openEvent = useCallback(async (slug: string) => {
    setOpen(slug);
    setError('');
    try {
      const [list, imp] = await Promise.all([
        api<{ registrations: Registration[] }>(`/events/${slug}/check-in`),
        api<Impact>(`/events/${slug}/impact`),
      ]);
      setRegs(list.registrations);
      setImpact(imp);
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  useEffect(() => {
    if (!isAuthed()) {
      router.replace('/login');
      return;
    }
    void load();
  }, [router, load]);

  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError('');
    try {
      await fn();
      if (open) await openEvent(open);
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <h1>Hilo events</h1>
      {error ? <div className="alert error">{error}</div> : null}

      {open ? (
        <>
          <div className="chipbar">
            <button type="button" className="chip" onClick={() => { setOpen(''); setRegs([]); setImpact(null); }}>
              ← All events
            </button>
            <button
              type="button"
              className="btn ghost"
              disabled={busy}
              onClick={() =>
                void act(() => api(`/events/${open}/complete`, { method: 'POST' }))
              }
              title="Records no-shows, sends the out-survey, raises the follow-up task"
            >
              Close out the event
            </button>
          </div>

          {impact ? (
            <section className="card" style={{ marginBottom: 12 }}>
              <h2>{open}</h2>
              <p className="small">
                {impact.registered} registered · {impact.attended} attended · {impact.no_shows} no-shows ·{' '}
                {impact.waitlisted} waitlisted
              </p>
              <p className="muted small">
                {impact.surveys_answered} survey {impact.surveys_answered === 1 ? 'reply' : 'replies'}
                {impact.avg_satisfaction ? ` · satisfaction ${impact.avg_satisfaction}/5` : ''}
                {impact.avg_nps ? ` · NPS ${impact.avg_nps}/10` : ''}
                {' — these are the funder-report figures.'}
              </p>
            </section>
          ) : null}

          <section className="card">
            <h2>Door list</h2>
            {regs.length === 0 ? <p className="muted">Nobody registered yet.</p> : null}
            {regs.map((r) => (
              <div className="quote-line" key={r.id}>
                <span className="name">
                  {r.seat_number !== null ? <span className="badge">#{r.seat_number}</span> : (
                    <span className="badge warn">waitlist</span>
                  )}{' '}
                  {r.first_name} {r.last_name}
                  {r.language === 'es' ? <span className="muted small"> · ES</span> : null}
                  {!r.in_crm ? <span className="muted small"> · not in CRM</span> : null}
                </span>
                <span className="muted small" style={{ flex: '1 1 100%', overflowWrap: 'anywhere' }}>
                  {r.email}
                  {r.phone ? ` · ${r.phone}` : ''}
                </span>
                <span className="amt">
                  {r.checked_in_at ? (
                    <span className="badge ok">here</span>
                  ) : r.seat_number !== null ? (
                    <button
                      type="button"
                      className="btn accent"
                      disabled={busy}
                      onClick={() =>
                        void act(() => api(`/event-registrations/${r.id}/check-in`, { method: 'POST' }))
                      }
                    >
                      Check in
                    </button>
                  ) : (
                    <span className="muted small">no seat</span>
                  )}
                </span>
              </div>
            ))}
          </section>
        </>
      ) : (
        <>
          {events.length === 0 ? (
            <section className="card"><p className="muted">No events yet.</p></section>
          ) : (
            events.map((e) => (
              <section className="card" key={e.slug} style={{ marginBottom: 10 }}>
                <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'flex-start' }}>
                  <span style={{ flex: 1, minWidth: 200 }}>
                    <strong>{e.title_en}</strong>{' '}
                    <span className={`badge ${e.status === 'published' ? 'ok' : e.status === 'completed' ? '' : 'warn'}`}>
                      {e.status}
                    </span>
                    {e.program ? <span className="badge">{e.program}</span> : null}
                    <br />
                    <span className="muted small">
                      {e.starts_at.slice(0, 16).replace('T', ' ')} · {e.confirmed}/{e.capacity} seats
                      {e.waitlisted > 0 ? ` · ${e.waitlisted} waitlisted` : ''}
                      {e.attended > 0 ? ` · ${e.attended} attended` : ''}
                    </span>
                  </span>
                  <span className="chipbar" style={{ marginBottom: 0 }}>
                    {e.status === 'draft' ? (
                      <button
                        type="button"
                        className="chip"
                        disabled={busy}
                        onClick={() => void act(() => api(`/events/${e.slug}/publish`, { method: 'POST' }))}
                      >
                        Publish
                      </button>
                    ) : null}
                    <button type="button" className="btn ghost" onClick={() => void openEvent(e.slug)}>
                      Door list
                    </button>
                  </span>
                </div>
              </section>
            ))
          )}
        </>
      )}
    </>
  );
}
