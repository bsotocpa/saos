'use client';

// Browser-based session recorder (MP Meeting Intelligence): no app install —
// Jackson taps record on her iPhone for a phone call or in-person session;
// on stop, the recording uploads into the pipeline (transcript, summary,
// tasks, referral queue, suggested time entry).

import { useRef, useState } from 'react';
import { api } from '../../lib/api';

interface Contact { id: string; first_name: string; last_name: string }

export default function RecorderPage() {
  const [search, setSearch] = useState('');
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [contact, setContact] = useState<Contact | null>(null);
  const [type, setType] = useState<'phone' | 'in_person'>('in_person');
  const [recording, setRecording] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const startedAtRef = useRef(0);

  const findContacts = async () => {
    const res = await api<{ contacts: Contact[] }>(`/contacts?search=${encodeURIComponent(search)}`);
    setContacts(res.contacts);
  };

  const start = async () => {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const recorder = new MediaRecorder(stream);
    chunksRef.current = [];
    recorder.ondataavailable = (e) => chunksRef.current.push(e.data);
    recorder.onstop = async () => {
      stream.getTracks().forEach((t) => t.stop());
      const blob = new Blob(chunksRef.current, { type: recorder.mimeType || 'audio/webm' });
      const durationSeconds = Math.max(1, Math.round((Date.now() - startedAtRef.current) / 1000));
      setStatus('Uploading…');
      const fd = new FormData();
      fd.append('contactId', contact!.id);
      fd.append('type', type);
      fd.append('durationSeconds', String(durationSeconds));
      fd.append('file', blob, `session-${Date.now()}.webm`);
      await api('/meetings/upload', { method: 'POST', formData: fd });
      setStatus('Uploaded — transcript, summary, tasks, and a suggested time entry are on the way.');
    };
    recorderRef.current = recorder;
    startedAtRef.current = Date.now();
    recorder.start();
    setRecording(true);
    setStatus(null);
  };

  const stop = () => {
    recorderRef.current?.stop();
    setRecording(false);
  };

  return (
    <>
      <h1>Session recorder</h1>
      <section className="card" style={{ maxWidth: 520 }}>
        {status ? <p className="alert info">{status}</p> : null}
        {!contact ? (
          <>
            <label className="field">
              Who is this session with?
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && void findContacts()}
                placeholder="Search clients — press Enter"
              />
            </label>
            {contacts.map((c) => (
              <p key={c.id}>
                <button className="btn ghost" type="button" onClick={() => setContact(c)}>
                  {c.first_name} {c.last_name}
                </button>
              </p>
            ))}
          </>
        ) : (
          <>
            <p>
              Session with <strong>{contact.first_name} {contact.last_name}</strong>
            </p>
            <label className="field">
              Session type
              <select value={type} onChange={(e) => setType(e.target.value as 'phone' | 'in_person')} disabled={recording}>
                <option value="in_person">In person</option>
                <option value="phone">Phone</option>
              </select>
            </label>
            {recording ? (
              <p>
                <span className="rec-dot" /> Recording…
              </p>
            ) : null}
            {recording ? (
              <button className="btn danger" type="button" onClick={stop}>
                Stop + upload
              </button>
            ) : (
              <button className="btn accent" type="button" onClick={() => void start()}>
                ● Start recording
              </button>
            )}
          </>
        )}
      </section>
    </>
  );
}
