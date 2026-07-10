'use client';

// My Tasks (v4.4 view #1) — one list across every module — plus the team
// workload view (view #4) and quick task creation. Kanban boards live at
// /tasks/boards.

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { api, isAuthed } from '../../lib/api';

interface Task {
  id: string; title: string; description: string | null; status: string; priority: number;
  due_date: string | null; source_type: string | null; client_name: string | null;
  client_visible: boolean; sop_link: string | null; checklist_total: number; checklist_done: number;
}
interface Workload { id: string; full_name: string; role: string; open: number; in_progress: number; overdue: number }

const PRIORITY = ['—', 'high', 'URGENT'];

export default function TasksPage() {
  const router = useRouter();
  const [tasks, setTasks] = useState<Task[]>([]);
  const [workload, setWorkload] = useState<Workload[]>([]);
  const [includeDone, setIncludeDone] = useState(false);
  const [title, setTitle] = useState('');
  const [clientVisible, setClientVisible] = useState(false);

  const load = useCallback(async () => {
    const [mine, wl] = await Promise.all([
      api<{ tasks: Task[] }>(`/tasks/mine?includeDone=${includeDone}`),
      api<{ workload: Workload[] }>('/tasks/workload'),
    ]);
    setTasks(mine.tasks);
    setWorkload(wl.workload);
  }, [includeDone]);

  useEffect(() => {
    if (!isAuthed()) {
      router.replace('/login');
      return;
    }
    void load();
  }, [router, load]);

  const setStatus = async (id: string, status: string) => {
    await api(`/tasks/${id}/status`, { method: 'PATCH', body: { status } });
    await load();
  };

  return (
    <>
      <h1>
        My Tasks <Link className="btn ghost" href="/tasks/boards">Boards</Link>
      </h1>

      <section className="card">
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            if (!title.trim()) return;
            await api('/tasks', { method: 'POST', body: { title: title.trim(), clientVisible } });
            setTitle('');
            setClientVisible(false);
            await load();
          }}
          style={{ display: 'flex', gap: 8, alignItems: 'center' }}
        >
          <input placeholder="New task…" value={title} onChange={(e) => setTitle(e.target.value)} style={{ flex: 1 }} />
          <label className="small" style={{ whiteSpace: 'nowrap' }}>
            <input type="checkbox" checked={clientVisible} onChange={(e) => setClientVisible(e.target.checked)} /> client-visible
          </label>
          <button className="btn" type="submit">Add</button>
        </form>
      </section>

      <section className="card">
        <label className="small">
          <input type="checkbox" checked={includeDone} onChange={(e) => setIncludeDone(e.target.checked)} /> show completed
        </label>
        {tasks.length === 0 ? <p className="muted">Nothing on your list.</p> : null}
        <ul className="list">
          {tasks.map((tk) => (
            <li key={tk.id}>
              <span className="grow">
                <strong className="small">{tk.title}</strong>
                {tk.priority > 0 ? <span className={`badge ${tk.priority === 2 ? 'danger' : 'warn'}`}> {PRIORITY[tk.priority]}</span> : null}
                {tk.client_visible ? <span className="badge">client</span> : null}
                <br />
                <span className="muted small">
                  {tk.client_name ? `${tk.client_name} · ` : ''}
                  {tk.source_type ? `${tk.source_type.replace(/_/g, ' ')} · ` : ''}
                  {tk.due_date ? `due ${tk.due_date} · ` : ''}
                  {tk.checklist_total > 0 ? `checklist ${tk.checklist_done}/${tk.checklist_total} · ` : ''}
                  {tk.status}
                  {tk.sop_link ? <> · <a href={tk.sop_link} target="_blank" rel="noreferrer">how to do this</a></> : null}
                </span>
              </span>
              {tk.status === 'open' ? (
                <button className="btn ghost" type="button" onClick={() => void setStatus(tk.id, 'in_progress')}>Start</button>
              ) : null}
              {tk.status !== 'done' && tk.status !== 'cancelled' ? (
                <button className="btn" type="button" onClick={() => void setStatus(tk.id, 'done')}>Done</button>
              ) : null}
            </li>
          ))}
        </ul>
      </section>

      <section className="card">
        <h2>Team workload</h2>
        <table>
          <thead><tr><th>Person</th><th>Open</th><th>In progress</th><th>Overdue</th></tr></thead>
          <tbody>
            {workload.map((w) => (
              <tr key={w.id}>
                <td>{w.full_name}<br /><span className="muted small">{w.role}</span></td>
                <td>{w.open}</td>
                <td>{w.in_progress}</td>
                <td>{w.overdue > 0 ? <span className="badge danger">{w.overdue}</span> : 0}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </>
  );
}
