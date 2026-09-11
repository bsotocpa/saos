'use client';

// Task create/edit modal (v4.5): the form renders from the tasks.layout
// app_setting — field order, sections, and required flags are admin-editable
// without a deploy ("Edit Page Layout"). Dual Contact + Business lookups,
// Reminder, Repeat, Tags, Save and New.

import { ModalShell } from '../../components/modal-shell';
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { api } from '../../lib/api';
import { PRIORITIES, RECUR_FREQS, STATUSES } from './lib';
import type { StaffEntry, Task, TaskStatus } from './lib';

export interface LayoutField { key: string; label: string; required: boolean }
export interface LayoutSection { title: string; fields: LayoutField[] }
export interface TaskLayout { sections: LayoutSection[] }

export const FALLBACK_LAYOUT: TaskLayout = {
  sections: [
    {
      title: 'Task Information',
      fields: [
        { key: 'assignedStaffId', label: 'Task Owner', required: false },
        { key: 'title', label: 'Subject', required: true },
        { key: 'dueDate', label: 'Due Date', required: false },
        { key: 'contactId', label: 'Contact', required: false },
        { key: 'businessId', label: 'Business', required: false },
        { key: 'status', label: 'Status', required: false },
        { key: 'priority', label: 'Priority', required: false },
        { key: 'remindAt', label: 'Reminder', required: false },
        { key: 'recurFreq', label: 'Repeat', required: false },
        { key: 'tags', label: 'Tags', required: false },
      ],
    },
    { title: 'Description Information', fields: [{ key: 'description', label: 'Description', required: false }] },
  ],
};

interface FormState {
  title: string;
  description: string;
  assignedStaffId: string;
  contactId: string;
  contactName: string;
  businessId: string;
  businessName: string;
  dueDate: string;
  status: TaskStatus;
  priority: number;
  clientVisible: boolean;
  remindAt: string;        // datetime-local value
  recurFreq: string;
  recurInterval: number;
  tags: string;            // comma-separated in the input
}

function fromTask(t: Task | null, meId: string): FormState {
  if (!t) {
    return {
      title: '', description: '', assignedStaffId: meId, contactId: '', contactName: '',
      businessId: '', businessName: '', dueDate: '', status: 'not_started', priority: 0,
      clientVisible: false, remindAt: '', recurFreq: '', recurInterval: 1, tags: '',
    };
  }
  return {
    title: t.title,
    description: t.description ?? '',
    assignedStaffId: t.assigned_staff_id ?? '',
    contactId: t.contact_id ?? '',
    contactName: t.client_name ?? '',
    businessId: t.business_id ?? '',
    businessName: t.business_name ?? '',
    dueDate: t.due_date ?? '',
    status: t.status,
    priority: t.priority,
    clientVisible: t.client_visible,
    remindAt: t.remind_at ? toLocalInput(t.remind_at) : '',
    recurFreq: t.recur_freq ?? '',
    recurInterval: t.recur_interval,
    tags: t.tags.join(', '),
  };
}

function toLocalInput(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Async record lookup (contacts or businesses) with a picked-value chip. */
function Lookup(props: {
  label: string;
  required: boolean;
  placeholder: string;
  value: { id: string; name: string };
  search: (q: string) => Promise<{ id: string; name: string }[]>;
  onPick: (v: { id: string; name: string }) => void;
}) {
  const [q, setQ] = useState('');
  const [results, setResults] = useState<{ id: string; name: string }[]>([]);
  const [open, setOpen] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const run = (text: string) => {
    setQ(text);
    if (timer.current) clearTimeout(timer.current);
    if (!text.trim()) {
      setResults([]);
      setOpen(false);
      return;
    }
    timer.current = setTimeout(async () => {
      try {
        setResults(await props.search(text.trim()));
        setOpen(true);
      } catch {
        setResults([]);
      }
    }, 250);
  };

  return (
    <label className="field lookup">
      {props.label}{props.required ? ' *' : ''}
      {props.value.id ? (
        <span style={{ display: 'flex', gap: 6, alignItems: 'center', marginTop: 3 }}>
          <span className="badge">{props.value.name}</span>
          <button type="button" className="chip" onClick={() => props.onPick({ id: '', name: '' })}>clear</button>
        </span>
      ) : (
        <>
          <input placeholder={props.placeholder} value={q} onChange={(e) => run(e.target.value)} onBlur={() => setTimeout(() => setOpen(false), 150)} />
          {open && results.length > 0 ? (
            <div className="results">
              {results.map((r) => (
                <button key={r.id} type="button" onMouseDown={() => { props.onPick(r); setQ(''); setOpen(false); }}>
                  {r.name}
                </button>
              ))}
            </div>
          ) : null}
        </>
      )}
    </label>
  );
}

/** v4.6 "Blocked by" management — shown when editing an existing task. */
function BlockersSection(props: { taskId: string; canManage: boolean }) {
  const [blockers, setBlockers] = useState<{ id: string; title: string; status: string }[]>([]);
  const [error, setError] = useState('');

  const load = async () => {
    const r = await api<{ blockers: { id: string; title: string; status: string }[] }>(`/tasks/${props.taskId}/dependencies`);
    setBlockers(r.blockers);
  };
  useEffect(() => { void load(); }, [props.taskId]); // eslint-disable-line react-hooks/exhaustive-deps

  const add = async (v: { id: string; name: string }) => {
    if (!v.id) return;
    setError('');
    try {
      await api(`/tasks/${props.taskId}/dependencies`, { method: 'POST', body: { blockerTaskId: v.id } });
      await load();
    } catch (err) {
      setError((err as Error).message);
    }
  };
  const remove = async (blockerId: string) => {
    await api(`/tasks/${props.taskId}/dependencies/${blockerId}`, { method: 'DELETE' });
    await load();
  };

  return (
    <section>
      <h2 style={{ marginTop: 10 }}>Blocked by</h2>
      {error ? <div className="alert error">{error}</div> : null}
      {blockers.length === 0 ? <p className="muted small">Not waiting on any task.</p> : null}
      {blockers.map((b) => (
        <p key={b.id} className="small" style={{ display: 'flex', gap: 8, alignItems: 'center', margin: '2px 0' }}>
          <span className={`badge ${b.status === 'completed' || b.status === 'cancelled' ? 'ok' : 'warn'}`}>{b.status.replace(/_/g, ' ')}</span>
          <span style={{ flex: 1 }}>{b.title}</span>
          {props.canManage ? <button type="button" className="chip" onClick={() => void remove(b.id)}>remove</button> : null}
        </p>
      ))}
      {props.canManage ? (
        <Lookup
          label="Add blocker" required={false} placeholder="Search open tasks…"
          value={{ id: '', name: '' }}
          search={async (q) => {
            const r = await api<{ tasks: { id: string; title: string }[] }>(`/tasks/search?q=${encodeURIComponent(q)}&limit=8`);
            return r.tasks.filter((t) => t.id !== props.taskId).map((t) => ({ id: t.id, name: t.title }));
          }}
          onPick={(v) => void add(v)}
        />
      ) : null}
    </section>
  );
}

export function TaskFormModal(props: {
  task: Task | null;            // null = create
  layout: TaskLayout | null;
  staff: StaffEntry[];
  meId: string;
  canEditLayout: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const layout = props.layout ?? FALLBACK_LAYOUT;
  const [form, setForm] = useState<FormState>(() => fromTask(props.task, props.meId));
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setForm(fromTask(props.task, props.meId));
  }, [props.task, props.meId]);

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) => setForm((f) => ({ ...f, [key]: value }));

  const searchContacts = async (q: string) => {
    const r = await api<{ contacts: { id: string; first_name: string; last_name: string }[] }>(
      `/contacts?search=${encodeURIComponent(q)}&limit=8`
    );
    return r.contacts.map((c) => ({ id: c.id, name: `${c.first_name} ${c.last_name}` }));
  };
  const searchBusinesses = async (q: string) => {
    const r = await api<{ businesses: { id: string; name: string }[] }>(
      `/businesses?search=${encodeURIComponent(q)}&limit=8`
    );
    return r.businesses.map((b) => ({ id: b.id, name: b.name }));
  };

  const save = async (andNew: boolean) => {
    setError('');
    const required = layout.sections.flatMap((s) => s.fields).filter((f) => f.required);
    for (const f of required) {
      if (f.key === 'title' && !form.title.trim()) { setError(`${f.label} is required.`); return; }
      if (f.key === 'dueDate' && !form.dueDate) { setError(`${f.label} is required.`); return; }
      if (f.key === 'contactId' && !form.contactId) { setError(`${f.label} is required.`); return; }
      if (f.key === 'businessId' && !form.businessId) { setError(`${f.label} is required.`); return; }
      if (f.key === 'assignedStaffId' && !form.assignedStaffId) { setError(`${f.label} is required.`); return; }
    }
    if (!form.title.trim()) { setError('Subject is required.'); return; }

    const tags = form.tags.split(',').map((t) => t.trim()).filter(Boolean);
    const remindAtIso = form.remindAt ? new Date(form.remindAt).toISOString() : null;
    setBusy(true);
    try {
      if (props.task) {
        await api(`/tasks/${props.task.id}`, {
          method: 'PATCH',
          body: {
            title: form.title.trim(),
            description: form.description || null,
            assignedStaffId: form.assignedStaffId || null,
            contactId: form.contactId || null,
            businessId: form.businessId || null,
            dueDate: form.dueDate || null,
            priority: form.priority,
            clientVisible: form.clientVisible,
            tags,
            remindAt: remindAtIso,
            recurFreq: form.recurFreq || null,
            recurInterval: form.recurInterval,
          },
        });
        if (form.status !== props.task.status) {
          await api(`/tasks/${props.task.id}/status`, { method: 'PATCH', body: { status: form.status } });
        }
      } else {
        await api('/tasks', {
          method: 'POST',
          body: {
            title: form.title.trim(),
            ...(form.description ? { description: form.description } : {}),
            ...(form.assignedStaffId ? { assignedStaffId: form.assignedStaffId } : {}),
            ...(form.contactId ? { contactId: form.contactId } : {}),
            ...(form.businessId ? { businessId: form.businessId } : {}),
            ...(form.dueDate ? { dueDate: form.dueDate } : {}),
            ...(form.status !== 'not_started' ? { status: form.status } : {}),
            priority: form.priority,
            clientVisible: form.clientVisible,
            ...(tags.length ? { tags } : {}),
            ...(remindAtIso ? { remindAt: remindAtIso } : {}),
            ...(form.recurFreq ? { recurFreq: form.recurFreq, recurInterval: form.recurInterval } : {}),
          },
        });
      }
      props.onSaved();
      if (andNew) setForm(fromTask(null, props.meId));
      else props.onClose();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const renderField = (f: LayoutField) => {
    switch (f.key) {
      case 'title':
        return (
          <label className="field" key={f.key} style={{ gridColumn: '1 / -1' }}>
            {f.label}{f.required ? ' *' : ''}
            <input value={form.title} onChange={(e) => set('title', e.target.value)} autoFocus={!props.task} />
          </label>
        );
      case 'assignedStaffId':
        return (
          <label className="field" key={f.key}>
            {f.label}{f.required ? ' *' : ''}
            <select value={form.assignedStaffId} onChange={(e) => set('assignedStaffId', e.target.value)}>
              <option value="">Unassigned</option>
              {props.staff.map((s) => <option key={s.id} value={s.id}>{s.full_name}</option>)}
            </select>
          </label>
        );
      case 'dueDate':
        return (
          <label className="field" key={f.key}>
            {f.label}{f.required ? ' *' : ''}
            <input type="date" value={form.dueDate} onChange={(e) => set('dueDate', e.target.value)} />
          </label>
        );
      case 'contactId':
        return (
          <Lookup
            key={f.key} label={f.label} required={f.required} placeholder="Search contacts…"
            value={{ id: form.contactId, name: form.contactName }}
            search={searchContacts}
            onPick={(v) => setForm((s) => ({ ...s, contactId: v.id, contactName: v.name }))}
          />
        );
      case 'businessId':
        return (
          <Lookup
            key={f.key} label={f.label} required={f.required} placeholder="Search businesses…"
            value={{ id: form.businessId, name: form.businessName }}
            search={searchBusinesses}
            onPick={(v) => setForm((s) => ({ ...s, businessId: v.id, businessName: v.name }))}
          />
        );
      case 'status':
        return (
          <label className="field" key={f.key}>
            {f.label}
            <select value={form.status} onChange={(e) => set('status', e.target.value as TaskStatus)}>
              {STATUSES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
            </select>
          </label>
        );
      case 'priority':
        return (
          <label className="field" key={f.key}>
            {f.label}
            <select value={form.priority} onChange={(e) => set('priority', Number(e.target.value))}>
              {PRIORITIES.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
            </select>
          </label>
        );
      case 'remindAt':
        return (
          <label className="field" key={f.key}>
            {f.label}
            <input type="datetime-local" value={form.remindAt} onChange={(e) => set('remindAt', e.target.value)} />
          </label>
        );
      case 'recurFreq':
        return (
          <label className="field" key={f.key}>
            {f.label}
            <span style={{ display: 'flex', gap: 6 }}>
              <select value={form.recurFreq} onChange={(e) => set('recurFreq', e.target.value)}>
                <option value="">None</option>
                {RECUR_FREQS.map((r) => <option key={r} value={r}>{r}</option>)}
              </select>
              {form.recurFreq ? (
                <input
                  type="number" min={1} max={365} style={{ width: 72 }}
                  title={form.recurFreq === 'custom' ? 'every N days' : 'every N periods'}
                  value={form.recurInterval}
                  onChange={(e) => set('recurInterval', Math.max(1, Number(e.target.value)))}
                />
              ) : null}
            </span>
          </label>
        );
      case 'tags':
        return (
          <label className="field" key={f.key}>
            {f.label}
            <input placeholder="comma, separated" value={form.tags} onChange={(e) => set('tags', e.target.value)} />
          </label>
        );
      case 'description':
        return (
          <label className="field" key={f.key} style={{ gridColumn: '1 / -1' }}>
            {f.label}
            <textarea rows={4} value={form.description} onChange={(e) => set('description', e.target.value)} />
          </label>
        );
      default:
        return null;
    }
  };

  return (
    <ModalShell
      id="task-form"
      title={props.task ? 'Edit Task' : 'Create Task'}
      onClose={props.onClose}
      heading={
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
          <h2 id="task-form-title">{props.task ? 'Edit Task' : 'Create Task'}</h2>
          {props.canEditLayout ? (
            <Link className="small" href="/admin" title="Field order, sections, and required flags live in the tasks.layout setting">
              Edit Page Layout
            </Link>
          ) : null}
        </div>
      }
    >
        {error ? <div className="alert error">{error}</div> : null}
        <form onSubmit={(e) => { e.preventDefault(); void save(false); }}>
          {layout.sections.map((section) => (
            <section key={section.title}>
              <h2 style={{ marginTop: 10 }}>{section.title}</h2>
              <div className="grid2">{section.fields.map(renderField)}</div>
            </section>
          ))}
          {props.task ? <BlockersSection taskId={props.task.id} canManage={true} /> : null}
          <label className="check small" style={{ display: 'flex', gap: 6, alignItems: 'center', fontWeight: 400 }}>
            <input type="checkbox" style={{ width: 'auto', margin: 0, display: 'inline' }} checked={form.clientVisible} onChange={(e) => set('clientVisible', e.target.checked)} />
            Client-visible (appears on the client&apos;s portal to-do list; arms the follow-up ladder)
          </label>
          <footer>
            <button type="button" className="btn ghost" onClick={props.onClose} disabled={busy}>Cancel</button>
            {!props.task ? (
              <button type="button" className="btn ghost" onClick={() => void save(true)} disabled={busy}>Save and New</button>
            ) : null}
            <button type="submit" className="btn" disabled={busy}>Save</button>
          </footer>
        </form>
    </ModalShell>
  );
}
