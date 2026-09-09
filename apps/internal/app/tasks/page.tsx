'use client';

// Task workspace (v4.5 — the Zoho screenshots in docs/reference are the
// benchmark). Views: List / Kanban / Calendar / Timeline behind one filter
// rail; saved views (private + shared); dense sortable list with inline edit,
// column chooser, and bulk operations; kanban groups by any picklist with
// column counts; create/edit form renders from the tasks.layout setting.

import { dayOf, formatDate, formatDateTime, formatMonth, formatTime } from '../../lib/dates';
import Link from 'next/link';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { api, isAuthed } from '../../lib/api';
import {
  ALL_COLUMNS, buildSearchQuery, DEFAULT_COLUMNS, EMPTY_FILTERS, GROUP_FIELDS, isOverdue,
  LADDER_LABEL, PRIORITIES, PRIORITY_LABEL, SOURCE_TYPES, STATUS_LABEL, STATUSES, todayStr,
} from './lib';
import type { Filters, SavedView, StaffEntry, Task, TaskStatus } from './lib';
import { TaskFormModal } from './task-form';
import type { TaskLayout } from './task-form';

type ViewType = 'list' | 'kanban' | 'calendar' | 'timeline';

/** Phone-width detection — drives the card list + filter bottom sheet. */
function useIsPhone(): boolean {
  const [isPhone, setIsPhone] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 767px)');
    const update = () => setIsPhone(mq.matches);
    update();
    mq.addEventListener('change', update);
    return () => mq.removeEventListener('change', update);
  }, []);
  return isPhone;
}

/** How many filters deviate from "nothing" — the n in "Filters · n". */
function activeFilterCount(f: Filters): number {
  let n = 0;
  if (f.q.trim()) n++;
  if (f.status.length) n++;
  if (f.priority.length) n++;
  if (f.assignee) n++;
  if (f.unassigned) n++;
  if (f.contactId) n++;
  if (f.businessId) n++;
  if (f.tag.trim()) n++;
  if (f.sourceType) n++;
  if (f.clientVisible) n++;
  if (f.due) n++;
  if (f.createdByMe) n++;
  if (f.delegatedByMe) n++;
  if (f.untouchedDays) n++;
  if (f.includeDone) n++;
  return n;
}

interface Me { id: string; fullName: string; permissions: string[] }
interface Workload {
  id: string; full_name: string; role: string;
  not_started: number; in_progress: number; waiting: number; deferred: number; overdue: number;
}

/** The source_type the July migration used for its "this contact is missing X" rows. */
const BACKLOG_SOURCE = 'enrichment';

export default function TasksPage() {
  const router = useRouter();
  const [me, setMe] = useState<Me | null>(null);
  const [staff, setStaff] = useState<StaffEntry[]>([]);
  const [layout, setLayout] = useState<TaskLayout | null>(null);
  const [views, setViews] = useState<SavedView[]>([]);
  const [activeViewId, setActiveViewId] = useState<string>('');

  const [filters, setFilters] = useState<Filters>({ ...EMPTY_FILTERS, assignee: 'me' });
  const [viewType, setViewType] = useState<ViewType>('list');
  const [groupBy, setGroupBy] = useState('status');
  const [columns, setColumns] = useState<string[]>(DEFAULT_COLUMNS);

  const [tasks, setTasks] = useState<Task[]>([]);
  // How much migration backlog exists, so the chip can say so rather than hiding it.
  const [backlogCount, setBacklogCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [editing, setEditing] = useState<Task | null>(null);
  const [creating, setCreating] = useState(false);
  const [showWorkload, setShowWorkload] = useState(false);
  const [workload, setWorkload] = useState<Workload[]>([]);
  const [error, setError] = useState('');
  const isPhone = useIsPhone();
  const [sheetOpen, setSheetOpen] = useState(false);

  // ── bootstrap ────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!isAuthed()) {
      router.replace('/login');
      return;
    }
    void (async () => {
      try {
        const [meRes, dir, lay, vw] = await Promise.all([
          api<Me>('/auth/me'),
          api<{ staff: StaffEntry[] }>('/staff/directory'),
          api<{ layout: TaskLayout | null }>('/tasks/layout'),
          api<{ views: SavedView[] }>('/task-views'),
        ]);
        setMe(meRes);
        setStaff(dir.staff);
        setLayout(lay.layout);
        setViews(vw.views);
      } catch (err) {
        setError((err as Error).message);
      }
    })();
  }, [router]);

  // ── search (debounced on filter changes) ─────────────────────────────────
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const load = useCallback(async (f: Filters, meId: string) => {
    setLoading(true);
    try {
      const r = await api<{ tasks: Task[] }>(`/tasks/search?${buildSearchQuery(f, meId)}`);
      setTasks(r.tasks);
      setSelected(new Set());
      // Cheap count query beside the list, so clearing backlog visibly shrinks the chip.
      void api<{ tasks: Task[] }>(`/tasks/search?sourceType=${BACKLOG_SOURCE}&limit=2000`)
        .then((b) => setBacklogCount(b.tasks.length))
        .catch(() => setBacklogCount(0));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!me) return;
    if (searchTimer.current) clearTimeout(searchTimer.current);
    searchTimer.current = setTimeout(() => void load(filters, me.id), 250);
    return () => { if (searchTimer.current) clearTimeout(searchTimer.current); };
  }, [filters, me, load]);

  const refresh = useCallback(() => {
    if (me) void load(filters, me.id);
  }, [me, filters, load]);

  const canManage = me?.permissions.includes('*') || me?.permissions.includes('tasks.manage') || false;

  // ── saved views ──────────────────────────────────────────────────────────
  const applyView = (v: SavedView) => {
    setActiveViewId(v.id);
    setFilters({ ...EMPTY_FILTERS, ...(v.filters as Partial<Filters>), sortField: v.sort.field ?? 'priority', sortDir: v.sort.dir ?? 'desc' });
    setViewType(v.view_type);
    if (v.columns.length) setColumns(v.columns);
    if (v.group_by) setGroupBy(v.group_by);
  };

  const saveCurrentView = async () => {
    const name = window.prompt('View name:');
    if (!name?.trim()) return;
    const shared = window.confirm('Share this view with the whole team?\nOK = shared, Cancel = private.');
    const { sortField, sortDir, ...filterRest } = filters;
    await api('/task-views', {
      method: 'POST',
      body: { name: name.trim(), shared, viewType, filters: filterRest, sort: { field: sortField, dir: sortDir }, columns, groupBy },
    });
    const vw = await api<{ views: SavedView[] }>('/task-views');
    setViews(vw.views);
  };

  const deleteView = async (id: string) => {
    await api(`/task-views/${id}`, { method: 'DELETE' });
    setViews((vs) => vs.filter((v) => v.id !== id));
    if (activeViewId === id) setActiveViewId('');
  };

  // ── mutations ────────────────────────────────────────────────────────────
  const setStatus = async (id: string, status: TaskStatus) => {
    try {
      setError('');
      await api(`/tasks/${id}/status`, { method: 'PATCH', body: { status } });
    } catch (err) {
      // v4.6: completing a blocked task is refused — say why, don't swallow it.
      setError((err as Error).message);
    }
    refresh();
  };
  const patchTask = async (id: string, body: Record<string, unknown>) => {
    await api(`/tasks/${id}`, { method: 'PATCH', body });
    refresh();
  };
  const duplicate = async (id: string) => {
    await api(`/tasks/${id}/duplicate`, { method: 'POST', body: {} });
    refresh();
  };
  const followUp = async (id: string) => {
    await api(`/tasks/${id}/follow-up`, { method: 'POST', body: {} });
    refresh();
  };
  const bulk = async (set: Record<string, unknown>) => {
    if (selected.size === 0) return;
    const r = await api<{ updated: number; blocked?: number }>('/tasks/bulk', { method: 'POST', body: { ids: [...selected], set } });
    if (r.blocked) setError(`${r.blocked} task${r.blocked === 1 ? '' : 's'} skipped — blocked by open tasks.`);
    refresh();
  };

  // ── sorting from list headers ────────────────────────────────────────────
  const sortBy = (field: string) => {
    setFilters((f) => ({
      ...f,
      sortField: field,
      sortDir: f.sortField === field && f.sortDir === 'desc' ? 'asc' : 'desc',
    }));
  };

  const statusCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const t of tasks) counts[t.status] = (counts[t.status] ?? 0) + 1;
    return counts;
  }, [tasks]);

  if (!me) return <p className="muted">{error || 'Loading…'}</p>;

  return (
    <>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', marginBottom: 10 }}>
        <h1 style={{ margin: 0 }}>Tasks</h1>
        <div className="viewtabs">
          {(['list', 'kanban', 'calendar', 'timeline'] as ViewType[]).map((v) => (
            <button key={v} className={viewType === v ? 'active' : ''} onClick={() => setViewType(v)} type="button">
              {v[0]!.toUpperCase() + v.slice(1)}
            </button>
          ))}
        </div>
        {viewType === 'kanban' ? (
          <label className="small" style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            Group by
            <select style={{ display: 'inline-block', width: 'auto', margin: 0, padding: '3px 8px' }} value={groupBy} onChange={(e) => setGroupBy(e.target.value)}>
              {GROUP_FIELDS.map((g) => <option key={g.key} value={g.key}>{g.label}</option>)}
            </select>
          </label>
        ) : null}
        {isPhone ? (
          <button className="chip" type="button" onClick={() => setSheetOpen(true)}>
            Filters{activeFilterCount(filters) > 0 ? ` · ${activeFilterCount(filters)}` : ''}
          </button>
        ) : null}
        <span style={{ flex: 1 }} />
        <Link className="btn ghost" href="/tasks/boards">Project boards</Link>
        <button className="btn ghost" type="button" onClick={() => setShowWorkload((s) => !s)}>Workload</button>
        {canManage ? <button className="btn accent" type="button" onClick={() => setCreating(true)}>Create Task</button> : null}
      </div>

      {error ? <div className="alert error">{error}</div> : null}

      {/* saved views bar */}
      <div className="chipbar">
        <button type="button" className={`chip ${activeViewId === '' && filters.assignee === 'me' ? 'active' : ''}`}
          onClick={() => { setActiveViewId(''); setFilters({ ...EMPTY_FILTERS, assignee: 'me', excludeSourceType: BACKLOG_SOURCE }); }}>
          My Open Tasks
        </button>
        <button type="button" className={`chip ${activeViewId === '' && filters.assignee === '' && !filters.includeDone ? 'active' : ''}`}
          onClick={() => { setActiveViewId(''); setFilters({ ...EMPTY_FILTERS, excludeSourceType: BACKLOG_SOURCE }); }}>
          All Open Tasks
        </button>
        <button type="button" className={`chip ${activeViewId === '' && filters.status.length === 1 && filters.status[0] === 'waiting_for_input' ? 'active' : ''}`}
          onClick={() => { setActiveViewId(''); setFilters({ ...EMPTY_FILTERS, status: ['waiting_for_input'] }); }}>
          Waiting for input
        </button>
        <button type="button" className={`chip ${activeViewId === '' && filters.due === 'overdue' ? 'active' : ''}`}
          onClick={() => { setActiveViewId(''); setFilters({ ...EMPTY_FILTERS, due: 'overdue' }); }}>
          Overdue
        </button>
        {/*
          MIGRATION BACKLOG (Brian, 2026-08-14). The July import raised 611 enrichment
          tasks against 10 from everything the business actually does, so the default views
          exclude them — a list that is 98.5% backlog is the same as having no list.

          It is a CHIP rather than a hidden rule: "migration backlog to triage deliberately
          later, not noise to delete". A backlog nobody can see is one nobody triages,
          which is how it reached 611.
        */}
        <button type="button" className={`chip ${activeViewId === '' && filters.sourceType === BACKLOG_SOURCE ? 'active' : ''}`}
          onClick={() => { setActiveViewId(''); setFilters({ ...EMPTY_FILTERS, sourceType: BACKLOG_SOURCE }); }}>
          Migration backlog{backlogCount > 0 ? ` (${backlogCount})` : ''}
        </button>
        {views.map((v) => (
          <span key={v.id} className={`chip ${activeViewId === v.id ? 'active' : ''}`} style={{ display: 'inline-flex', alignItems: 'center' }}>
            <button type="button" style={{ all: 'unset', cursor: 'pointer' }} onClick={() => applyView(v)}>
              {v.name}{v.shared ? ' ·shared' : ''}
            </button>
            {v.owner_staff_id === me.id ? (
              <button type="button" className="x" style={{ all: 'unset', cursor: 'pointer', marginLeft: 6, opacity: 0.6 }}
                title="Delete view" onClick={() => void deleteView(v.id)}>×</button>
            ) : null}
          </span>
        ))}
        <button type="button" className="chip" onClick={() => void saveCurrentView()}>+ Save view</button>
      </div>

      <div className="task-layout">
        <FilterRail filters={filters} setFilters={(f) => { setActiveViewId(''); setFilters(f); }} staff={staff} />

        <div>
          {selected.size > 0 ? (
            <BulkBar
              count={selected.size} staff={staff}
              onStatus={(s) => void bulk({ status: s })}
              onOwner={(id) => void bulk({ assignedStaffId: id || null })}
              onPriority={(p) => void bulk({ priority: p })}
              onDue={(d) => void bulk({ dueDate: d || null })}
              onClear={() => setSelected(new Set())}
            />
          ) : null}

          {loading ? <p className="muted small">Loading…</p> : null}

          {viewType === 'list' && isPhone ? (
            <ListCards
              tasks={tasks} selected={selected} setSelected={setSelected} canManage={canManage} staff={staff}
              onStatus={(id, s) => void setStatus(id, s)}
              onPatch={(id, b) => void patchTask(id, b)}
              onEdit={setEditing} onDuplicate={(id) => void duplicate(id)} onFollowUp={(id) => void followUp(id)}
            />
          ) : null}
          {viewType === 'list' && !isPhone ? (
            <ListView
              tasks={tasks} columns={columns} setColumns={setColumns} filters={filters} sortBy={sortBy}
              selected={selected} setSelected={setSelected} canManage={canManage} staff={staff}
              onStatus={(id, s) => void setStatus(id, s)}
              onPatch={(id, b) => void patchTask(id, b)}
              onEdit={setEditing} onDuplicate={(id) => void duplicate(id)} onFollowUp={(id) => void followUp(id)}
            />
          ) : null}

          {viewType === 'kanban' ? (
            <KanbanView
              tasks={tasks} groupBy={groupBy} staff={staff} canManage={canManage}
              onStatus={(id, s) => void setStatus(id, s)}
              onPatch={(id, b) => void patchTask(id, b)}
              onEdit={setEditing}
            />
          ) : null}

          {viewType === 'calendar' ? <CalendarView tasks={tasks} onEdit={setEditing} /> : null}
          {viewType === 'timeline' ? <TimelineView tasks={tasks} onEdit={setEditing} /> : null}

          <p className="muted small" style={{ marginTop: 8 }}>
            {tasks.length} task{tasks.length === 1 ? '' : 's'}
            {STATUSES.map((s) => statusCounts[s.value] ? ` · ${STATUS_LABEL[s.value]} ${statusCounts[s.value]}` : '').join('')}
          </p>

          {showWorkload ? <WorkloadTable workload={workload} setWorkload={setWorkload} /> : null}
        </div>
      </div>

      {sheetOpen ? (
        <div className="sheet-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) setSheetOpen(false); }}>
          <div className="sheet">
            <div className="grabber" />
            <FilterRail filters={filters} setFilters={(f) => { setActiveViewId(''); setFilters(f); }} staff={staff} />
            <div className="sheet-actions">
              <button className="btn ghost" type="button" onClick={() => { setActiveViewId(''); setFilters({ ...EMPTY_FILTERS }); }}>
                Clear all
              </button>
              <button className="btn" type="button" onClick={() => setSheetOpen(false)}>
                Show {tasks.length} task{tasks.length === 1 ? '' : 's'}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {(creating || editing) ? (
        <TaskFormModal
          task={editing} layout={layout} staff={staff} meId={me.id}
          canEditLayout={me.permissions.includes('*') || me.permissions.includes('admin.settings')}
          onClose={() => { setCreating(false); setEditing(null); }}
          onSaved={refresh}
        />
      ) : null}
    </>
  );
}

// ── phone card list (the dense table doesn't ship at 390px) ──────────────────

function ListCards(props: {
  tasks: Task[];
  selected: Set<string>; setSelected: (s: Set<string>) => void;
  canManage: boolean; staff: StaffEntry[];
  onStatus: (id: string, s: TaskStatus) => void;
  onPatch: (id: string, body: Record<string, unknown>) => void;
  onEdit: (t: Task) => void; onDuplicate: (id: string) => void; onFollowUp: (id: string) => void;
}) {
  const toggleOne = (id: string, checked: boolean) => {
    const next = new Set(props.selected);
    if (checked) next.add(id); else next.delete(id);
    props.setSelected(next);
  };
  return (
    <div>
      {props.tasks.map((t) => (
        <div className="tcard" key={t.id}>
          <div className="trow">
            <input type="checkbox" style={{ width: 'auto', margin: '3px 0 0' }}
              checked={props.selected.has(t.id)} onChange={(e) => toggleOne(t.id, e.target.checked)} />
            <span className="ttitle" onClick={() => props.onEdit(t)}>
              {t.title}
              {t.open_blockers > 0 ? <span className="badge warn" style={{ marginLeft: 6 }}>⛔ blocked</span> : null}
              {t.client_visible ? <span className="badge" style={{ marginLeft: 6 }}>client</span> : null}
              {isOverdue(t) ? <span className="badge danger" style={{ marginLeft: 6 }}>overdue</span> : null}
            </span>
          </div>
          <div className="tmeta">
            {t.client_name ? `${t.client_name} · ` : ''}
            {t.business_name ? `${t.business_name} · ` : ''}
            {t.due_date ? `due ${formatDate(t.due_date)} · ` : ''}
            {t.assignee_name ?? 'unassigned'}
            {t.tags.length ? ` · ${t.tags.join(', ')}` : ''}
          </div>
          <div className="tctl">
            {props.canManage ? (
              <>
                <select value={t.status} onChange={(e) => props.onStatus(t.id, e.target.value as TaskStatus)}>
                  {STATUSES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
                  {t.status === 'cancelled' ? <option value="cancelled">Cancelled</option> : null}
                </select>
                <select value={t.priority} onChange={(e) => props.onPatch(t.id, { priority: Number(e.target.value) })}>
                  {PRIORITIES.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
                </select>
                <button className="chip" type="button" title="Duplicate" onClick={() => props.onDuplicate(t.id)}>⧉</button>
                <button className="chip" type="button" title="Follow-up" onClick={() => props.onFollowUp(t.id)}>↳</button>
              </>
            ) : (
              <span className="muted small">{STATUS_LABEL[t.status]} · {PRIORITY_LABEL[t.priority]}</span>
            )}
          </div>
        </div>
      ))}
      {props.tasks.length === 0 ? <p className="muted small">No tasks match these filters.</p> : null}
    </div>
  );
}

// ── filter rail ──────────────────────────────────────────────────────────────

function FilterRail(props: { filters: Filters; setFilters: (f: Filters) => void; staff: StaffEntry[] }) {
  const f = props.filters;
  const set = (patch: Partial<Filters>) => props.setFilters({ ...f, ...patch });

  return (
    <aside className="rail">
      <h3>Search</h3>
      <input placeholder="Title or description…" value={f.q} onChange={(e) => set({ q: e.target.value })} />

      <h3>Status</h3>
      {STATUSES.map((s) => (
        <label className="check" key={s.value}>
          <input
            type="checkbox"
            checked={f.status.includes(s.value)}
            onChange={(e) => set({
              status: e.target.checked ? [...f.status, s.value] : f.status.filter((x) => x !== s.value),
              includeDone: (e.target.checked && s.value === 'completed') || f.includeDone,
            })}
          />
          {s.label}
        </label>
      ))}
      <label className="check">
        <input type="checkbox" checked={f.includeDone} onChange={(e) => set({ includeDone: e.target.checked })} />
        Include closed
      </label>

      <h3>Priority</h3>
      {PRIORITIES.map((p) => (
        <label className="check" key={p.value}>
          <input
            type="checkbox"
            checked={f.priority.includes(p.value)}
            onChange={(e) => set({ priority: e.target.checked ? [...f.priority, p.value] : f.priority.filter((x) => x !== p.value) })}
          />
          {p.label}
        </label>
      ))}

      <h3>Task Owner</h3>
      <select value={f.assignee} onChange={(e) => set({ assignee: e.target.value, unassigned: false })}>
        <option value="">Anyone</option>
        <option value="me">Me</option>
        {props.staff.map((s) => <option key={s.id} value={s.id}>{s.full_name}</option>)}
      </select>
      <label className="check">
        <input type="checkbox" checked={f.unassigned} onChange={(e) => set({ unassigned: e.target.checked, assignee: '' })} />
        Unassigned only
      </label>

      <h3>Due</h3>
      <select value={f.due} onChange={(e) => set({ due: e.target.value as Filters['due'] })}>
        <option value="">Any time</option>
        <option value="overdue">Overdue</option>
        <option value="today">Due today</option>
        <option value="week">Due this week</option>
        <option value="range">Date range…</option>
      </select>
      {f.due === 'range' ? (
        <>
          <input type="date" value={f.dueFrom} onChange={(e) => set({ dueFrom: e.target.value })} />
          <input type="date" value={f.dueTo} onChange={(e) => set({ dueTo: e.target.value })} />
        </>
      ) : null}

      <h3>Source</h3>
      <select value={f.sourceType} onChange={(e) => set({ sourceType: e.target.value })}>
        <option value="">Any source</option>
        {SOURCE_TYPES.map((s) => <option key={s} value={s}>{s.replace(/_/g, ' ')}</option>)}
      </select>

      <h3>Tag</h3>
      <input placeholder="Exact tag…" value={f.tag} onChange={(e) => set({ tag: e.target.value })} />

      <h3>System filters</h3>
      <label className="check">
        <input type="checkbox" checked={f.createdByMe} onChange={(e) => set({ createdByMe: e.target.checked })} />
        Created by me
      </label>
      <label className="check">
        <input type="checkbox" checked={f.delegatedByMe} onChange={(e) => set({ delegatedByMe: e.target.checked })} />
        Delegated by me
      </label>
      <label className="check">
        <input type="checkbox" checked={f.clientVisible === 'true'} onChange={(e) => set({ clientVisible: e.target.checked ? 'true' : '' })} />
        Client-visible only
      </label>
      <label className="check" title="No activity in N days">
        Untouched ≥
        <input
          type="number" min={1} style={{ width: 56, display: 'inline-block', margin: 0, padding: '2px 6px' }}
          value={f.untouchedDays} onChange={(e) => set({ untouchedDays: e.target.value })}
        />
        days
      </label>

      <button className="btn ghost" type="button" style={{ marginTop: 12, width: '100%' }}
        onClick={() => props.setFilters({ ...EMPTY_FILTERS })}>
        Clear filters
      </button>
    </aside>
  );
}

// ── bulk bar ─────────────────────────────────────────────────────────────────

function BulkBar(props: {
  count: number; staff: StaffEntry[];
  onStatus: (s: TaskStatus) => void; onOwner: (id: string) => void;
  onPriority: (p: number) => void; onDue: (d: string) => void; onClear: () => void;
}) {
  const [due, setDue] = useState('');
  return (
    <div className="bulkbar">
      <strong>{props.count} selected</strong>
      <select defaultValue="" onChange={(e) => { if (e.target.value) props.onStatus(e.target.value as TaskStatus); e.target.value = ''; }}>
        <option value="" disabled>Set status…</option>
        {STATUSES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
      </select>
      <select defaultValue="" onChange={(e) => { props.onOwner(e.target.value === 'none' ? '' : e.target.value); e.target.value = ''; }}>
        <option value="" disabled>Set owner…</option>
        <option value="none">Unassigned</option>
        {props.staff.map((s) => <option key={s.id} value={s.id}>{s.full_name}</option>)}
      </select>
      <select defaultValue="" onChange={(e) => { if (e.target.value !== '') props.onPriority(Number(e.target.value)); e.target.value = ''; }}>
        <option value="" disabled>Set priority…</option>
        {PRIORITIES.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
      </select>
      <span style={{ display: 'inline-flex', gap: 4, alignItems: 'center' }}>
        <input type="date" value={due} onChange={(e) => setDue(e.target.value)} />
        <button className="chip" type="button" disabled={!due} onClick={() => { if (due) props.onDue(due); }}>Set due</button>
      </span>
      <button className="chip" type="button" onClick={() => props.onStatus('completed')}>Mass complete</button>
      <span style={{ flex: 1 }} />
      <button className="chip" type="button" onClick={props.onClear}>Clear</button>
    </div>
  );
}

// ── list view ────────────────────────────────────────────────────────────────

function ListView(props: {
  tasks: Task[]; columns: string[]; setColumns: (c: string[]) => void;
  filters: Filters; sortBy: (field: string) => void;
  selected: Set<string>; setSelected: (s: Set<string>) => void;
  canManage: boolean; staff: StaffEntry[];
  onStatus: (id: string, s: TaskStatus) => void;
  onPatch: (id: string, body: Record<string, unknown>) => void;
  onEdit: (t: Task) => void; onDuplicate: (id: string) => void; onFollowUp: (id: string) => void;
}) {
  const [chooserOpen, setChooserOpen] = useState(false);
  const cols = props.columns;
  const arrow = (field: string) =>
    props.filters.sortField === field ? (props.filters.sortDir === 'asc' ? ' ▲' : ' ▼') : '';

  const toggleAll = (checked: boolean) => {
    props.setSelected(checked ? new Set(props.tasks.map((t) => t.id)) : new Set());
  };
  const toggleOne = (id: string, checked: boolean) => {
    const next = new Set(props.selected);
    if (checked) next.add(id); else next.delete(id);
    props.setSelected(next);
  };

  return (
    <section className="card" style={{ position: 'relative', overflowX: 'auto' }}>
      <div style={{ position: 'absolute', right: 10, top: 8 }}>
        <button className="chip" type="button" onClick={() => setChooserOpen((o) => !o)}>Columns ⚙</button>
        {chooserOpen ? (
          <div className="colmenu">
            {ALL_COLUMNS.map((c) => (
              <label className="check" key={c.key} style={{ display: 'flex', gap: 6, fontSize: 12.5 }}>
                <input
                  type="checkbox" style={{ width: 'auto', margin: 0 }}
                  checked={cols.includes(c.key)}
                  onChange={(e) => props.setColumns(e.target.checked
                    ? [...ALL_COLUMNS.filter((a) => cols.includes(a.key) || a.key === c.key).map((a) => a.key)]
                    : cols.filter((k) => k !== c.key))}
                />
                {c.label}
              </label>
            ))}
          </div>
        ) : null}
      </div>

      <table className="dense">
        <thead>
          <tr>
            <th className="nosort" style={{ width: 26 }}>
              <input type="checkbox" style={{ width: 'auto', margin: 0 }}
                checked={props.tasks.length > 0 && props.selected.size === props.tasks.length}
                onChange={(e) => toggleAll(e.target.checked)} />
            </th>
            <th onClick={() => props.sortBy('title')}>Subject{arrow('title')}</th>
            {cols.includes('status') ? <th onClick={() => props.sortBy('status')}>Status{arrow('status')}</th> : null}
            {cols.includes('priority') ? <th onClick={() => props.sortBy('priority')}>Priority{arrow('priority')}</th> : null}
            {cols.includes('due_date') ? <th onClick={() => props.sortBy('due_date')}>Due{arrow('due_date')}</th> : null}
            {cols.includes('assignee') ? <th onClick={() => props.sortBy('assignee')}>Owner{arrow('assignee')}</th> : null}
            {cols.includes('client') ? <th onClick={() => props.sortBy('client')}>Contact{arrow('client')}</th> : null}
            {cols.includes('business') ? <th className="nosort">Business</th> : null}
            {cols.includes('tags') ? <th className="nosort">Tags</th> : null}
            {cols.includes('source') ? <th className="nosort">Source</th> : null}
            {cols.includes('waiting') ? <th className="nosort">Waiting</th> : null}
            {cols.includes('checklist') ? <th className="nosort">✓</th> : null}
            {cols.includes('created_at') ? <th onClick={() => props.sortBy('created_at')}>Created{arrow('created_at')}</th> : null}
            <th className="nosort" />
          </tr>
        </thead>
        <tbody>
          {props.tasks.map((t) => (
            <tr key={t.id} className={props.selected.has(t.id) ? 'selected' : ''}>
              <td>
                <input type="checkbox" style={{ width: 'auto', margin: 0 }}
                  checked={props.selected.has(t.id)} onChange={(e) => toggleOne(t.id, e.target.checked)} />
              </td>
              <td className="title-cell">
                <button type="button" style={{ all: 'unset', cursor: 'pointer', fontWeight: 600 }} title={t.description ?? t.title} onClick={() => props.onEdit(t)}>
                  {t.title}
                </button>
                {t.open_blockers > 0 ? <span className="badge warn" style={{ marginLeft: 6 }} title={`Blocked by ${t.open_blockers} open task${t.open_blockers === 1 ? '' : 's'}`}>⛔ blocked</span> : null}
                {t.client_visible ? <span className="badge" style={{ marginLeft: 6 }}>client</span> : null}
                {t.sop_link ? <a className="small" style={{ marginLeft: 6 }} href={t.sop_link} target="_blank" rel="noreferrer" title="How to do this">SOP</a> : null}
              </td>
              {cols.includes('status') ? (
                <td>
                  {props.canManage ? (
                    <select value={t.status} onChange={(e) => props.onStatus(t.id, e.target.value as TaskStatus)}>
                      {STATUSES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
                      {t.status === 'cancelled' ? <option value="cancelled">Cancelled</option> : null}
                    </select>
                  ) : STATUS_LABEL[t.status]}
                </td>
              ) : null}
              {cols.includes('priority') ? (
                <td>
                  {props.canManage ? (
                    <select value={t.priority} onChange={(e) => props.onPatch(t.id, { priority: Number(e.target.value) })}>
                      {PRIORITIES.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
                    </select>
                  ) : PRIORITY_LABEL[t.priority]}
                </td>
              ) : null}
              {cols.includes('due_date') ? (
                <td>
                  {props.canManage ? (
                    <input type="date" value={t.due_date ?? ''} onChange={(e) => props.onPatch(t.id, { dueDate: e.target.value || null })} />
                  ) : (t.due_date ?? '—')}
                  {isOverdue(t) ? <span className="badge danger" style={{ marginLeft: 4 }}>overdue</span> : null}
                </td>
              ) : null}
              {cols.includes('assignee') ? (
                <td>
                  {props.canManage ? (
                    <select value={t.assigned_staff_id ?? ''} onChange={(e) => props.onPatch(t.id, { assignedStaffId: e.target.value || null })}>
                      <option value="">—</option>
                      {props.staff.map((s) => <option key={s.id} value={s.id}>{s.full_name}</option>)}
                    </select>
                  ) : (t.assignee_name ?? '—')}
                </td>
              ) : null}
              {cols.includes('client') ? <td>{t.client_name ?? '—'}</td> : null}
              {cols.includes('business') ? <td>{t.business_name ?? '—'}</td> : null}
              {cols.includes('tags') ? <td>{t.tags.map((tag) => <span key={tag} className="badge" style={{ marginRight: 3 }}>{tag}</span>)}</td> : null}
              {cols.includes('source') ? <td className="muted">{(t.source_type ?? t.source).replace(/_/g, ' ')}</td> : null}
              {cols.includes('waiting') ? (
                <td>
                  {t.status === 'waiting_for_input' && t.waiting_since ? (
                    <span>
                      {Math.floor((Date.now() - new Date(t.waiting_since).getTime()) / 86400000)}d
                      {t.ladder_rung > 0 ? <span className="rung" style={{ marginLeft: 4 }}>{LADDER_LABEL[t.ladder_rung]}</span> : null}
                    </span>
                  ) : '—'}
                </td>
              ) : null}
              {cols.includes('checklist') ? <td>{t.checklist_total > 0 ? `${t.checklist_done}/${t.checklist_total}` : '—'}</td> : null}
              {cols.includes('created_at') ? <td className="muted">{dayOf(t.created_at)}</td> : null}
              <td style={{ whiteSpace: 'nowrap' }}>
                {props.canManage ? (
                  <>
                    <button className="chip" type="button" title="Duplicate task" onClick={() => props.onDuplicate(t.id)}>⧉</button>{' '}
                    <button className="chip" type="button" title="Create follow-up" onClick={() => props.onFollowUp(t.id)}>↳</button>
                  </>
                ) : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {props.tasks.length === 0 ? <p className="muted small" style={{ marginTop: 8 }}>No tasks match these filters.</p> : null}
    </section>
  );
}

// ── kanban ───────────────────────────────────────────────────────────────────

function KanbanView(props: {
  tasks: Task[]; groupBy: string; staff: StaffEntry[]; canManage: boolean;
  onStatus: (id: string, s: TaskStatus) => void;
  onPatch: (id: string, body: Record<string, unknown>) => void;
  onEdit: (t: Task) => void;
}) {
  const groups = useMemo(() => {
    const map = new Map<string, { label: string; tasks: Task[] }>();
    const ensure = (key: string, label: string) => {
      if (!map.has(key)) map.set(key, { label, tasks: [] });
      return map.get(key)!;
    };
    // Stable columns first so empty ones still show (Zoho behaviour).
    if (props.groupBy === 'status') for (const s of STATUSES) ensure(s.value, s.label);
    if (props.groupBy === 'priority') for (const p of PRIORITIES) ensure(String(p.value), p.label);
    if (props.groupBy === 'assignee') {
      ensure('', 'Unassigned');
      for (const s of props.staff) ensure(s.id, s.full_name);
    }
    for (const t of props.tasks) {
      const key = props.groupBy === 'status' ? t.status
        : props.groupBy === 'priority' ? String(t.priority)
        : props.groupBy === 'assignee' ? (t.assigned_staff_id ?? '')
        : (t.source_type ?? t.source);
      ensure(key, key === '' ? 'Unassigned' : (STATUS_LABEL[key] ?? PRIORITY_LABEL[Number(key)] ?? props.staff.find((s) => s.id === key)?.full_name ?? key.replace(/_/g, ' '))).tasks.push(t);
    }
    if (props.groupBy === 'assignee') {
      for (const [k, v] of map) if (k !== '' && v.tasks.length === 0 && !props.tasks.some((t) => t.assigned_staff_id === k)) map.delete(k);
    }
    return [...map.entries()];
  }, [props.tasks, props.groupBy, props.staff]);

  const moveOptions = (t: Task) => {
    if (props.groupBy === 'status') {
      return STATUSES.map((s) => ({ value: s.value, label: s.label, apply: () => props.onStatus(t.id, s.value) }));
    }
    if (props.groupBy === 'priority') {
      return PRIORITIES.map((p) => ({ value: String(p.value), label: p.label, apply: () => props.onPatch(t.id, { priority: p.value }) }));
    }
    if (props.groupBy === 'assignee') {
      return [{ value: '', label: 'Unassigned', apply: () => props.onPatch(t.id, { assignedStaffId: null }) },
        ...props.staff.map((s) => ({ value: s.id, label: s.full_name, apply: () => props.onPatch(t.id, { assignedStaffId: s.id }) }))];
    }
    return null; // source grouping is read-only
  };

  return (
    <div className="kanban">
      {groups.map(([key, g]) => (
        <div className="kcol" key={key || '(none)'}>
          <h4>{g.label} <span className="muted">{g.tasks.length}</span></h4>
          {g.tasks.map((t) => {
            const opts = props.canManage ? moveOptions(t) : null;
            const current = props.groupBy === 'status' ? t.status
              : props.groupBy === 'priority' ? String(t.priority)
              : (t.assigned_staff_id ?? '');
            return (
              <div className="kcard" key={t.id} onClick={() => props.onEdit(t)}>
                <strong>{t.title}</strong>
                <div className="muted" style={{ margin: '2px 0' }}>
                  {t.client_name ? `${t.client_name} · ` : ''}
                  {t.due_date ? `due ${formatDate(t.due_date)}` : 'no due date'}
                  {isOverdue(t) ? <span className="badge danger" style={{ marginLeft: 4 }}>overdue</span> : null}
                </div>
                {t.open_blockers > 0 ? <span className="badge warn" style={{ marginRight: 4 }}>⛔ blocked</span> : null}
                {t.priority > 0 ? <span className={`badge ${t.priority === 2 ? 'danger' : 'warn'}`}>{PRIORITY_LABEL[t.priority]}</span> : null}
                {opts ? (
                  <select
                    style={{ marginTop: 4, padding: '2px 6px', fontSize: 11.5 }}
                    value={current}
                    onClick={(e) => e.stopPropagation()}
                    onChange={(e) => opts.find((o) => o.value === e.target.value)?.apply()}
                  >
                    {opts.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                  </select>
                ) : null}
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}

// ── calendar ─────────────────────────────────────────────────────────────────

function CalendarView(props: { tasks: Task[]; onEdit: (t: Task) => void }) {
  const [month, setMonth] = useState(() => todayStr().slice(0, 7)); // YYYY-MM
  const today = todayStr();

  const cells = useMemo(() => {
    const [y, m] = [Number(month.slice(0, 4)), Number(month.slice(5, 7))];
    const first = new Date(Date.UTC(y, m - 1, 1));
    const start = new Date(first);
    start.setUTCDate(1 - first.getUTCDay()); // back to Sunday
    const out: { date: string; inMonth: boolean }[] = [];
    for (let i = 0; i < 42; i++) {
      const d = new Date(start);
      d.setUTCDate(start.getUTCDate() + i);
      out.push({ date: d.toISOString().slice(0, 10), inMonth: d.getUTCMonth() === m - 1 });
    }
    return out;
  }, [month]);

  const byDate = useMemo(() => {
    const map = new Map<string, Task[]>();
    for (const t of props.tasks) {
      if (!t.due_date) continue;
      map.set(t.due_date, [...(map.get(t.due_date) ?? []), t]);
    }
    return map;
  }, [props.tasks]);

  const shift = (delta: number) => {
    const [y, m] = [Number(month.slice(0, 4)), Number(month.slice(5, 7))];
    const d = new Date(Date.UTC(y, m - 1 + delta, 1));
    setMonth(d.toISOString().slice(0, 7));
  };

  return (
    <section className="card">
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8 }}>
        <button className="chip" type="button" onClick={() => shift(-1)}>←</button>
        <strong>{formatMonth(month)}</strong>
        <button className="chip" type="button" onClick={() => shift(1)}>→</button>
        <span className="muted small">tasks by due date — undated tasks don&apos;t appear here</span>
      </div>
      <div className="cal-grid">
        {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((d) => <div key={d} className="muted small" style={{ textAlign: 'center' }}>{d}</div>)}
        {cells.map((c) => (
          <div key={c.date} className={`cal-cell ${c.inMonth ? '' : 'dim'} ${c.date === today ? 'today' : ''}`}>
            <span className="muted">{Number(c.date.slice(8, 10))}</span>
            {(byDate.get(c.date) ?? []).slice(0, 4).map((t) => (
              <button key={t.id} type="button" className={`cal-task ${isOverdue(t) ? 'overdue' : ''}`} title={t.title} onClick={() => props.onEdit(t)}>
                {t.title}
              </button>
            ))}
            {(byDate.get(c.date)?.length ?? 0) > 4 ? <span className="muted">+{byDate.get(c.date)!.length - 4} more</span> : null}
          </div>
        ))}
      </div>
    </section>
  );
}

// ── timeline ─────────────────────────────────────────────────────────────────

const TIMELINE_DAYS = 28;

function TimelineView(props: { tasks: Task[]; onEdit: (t: Task) => void }) {
  const today = todayStr();
  const start = useMemo(() => {
    const d = new Date(`${today}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() - 7);
    return d;
  }, [today]);

  const days = useMemo(() => {
    const out: string[] = [];
    for (let i = 0; i < TIMELINE_DAYS; i++) {
      const d = new Date(start);
      d.setUTCDate(start.getUTCDate() + i);
      out.push(d.toISOString().slice(0, 10));
    }
    return out;
  }, [start]);

  const lanes = useMemo(() => {
    const map = new Map<string, Task[]>();
    for (const t of props.tasks) {
      if (!t.due_date) continue;
      const owner = t.assignee_name ?? 'Unassigned';
      if (t.due_date >= days[0]! && t.due_date <= days[days.length - 1]!) {
        map.set(owner, [...(map.get(owner) ?? []), t]);
      }
    }
    return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [props.tasks, days]);

  return (
    // scroll-x + min-width: on phones the 4-week grid scrolls inside the
    // card instead of squeezing to nothing (page never scrolls sideways).
    <section className="card scroll-x">
      <div style={{ minWidth: 560 }}>
      <div className="tl-row" style={{ borderBottom: '2px solid var(--line)' }}>
        <strong className="small">Owner</strong>
        <div style={{ display: 'grid', gridTemplateColumns: `repeat(${TIMELINE_DAYS}, 1fr)`, fontSize: 10 }} className="muted">
          {days.map((d) => (
            <span key={d} style={{ textAlign: 'center', fontWeight: d === today ? 700 : 400, color: d === today ? 'var(--electric)' : undefined }}>
              {d.slice(8, 10) === '01' || d === days[0] ? d.slice(5) : d.slice(8)}
            </span>
          ))}
        </div>
      </div>
      {lanes.length === 0 ? <p className="muted small" style={{ marginTop: 8 }}>No dated tasks in the next {TIMELINE_DAYS - 7} days (window starts a week back).</p> : null}
      {lanes.map(([owner, ts]) => (
        <div className="tl-row" key={owner}>
          <span>{owner} <span className="muted">({ts.length})</span></span>
          <div className="tl-lane">
            {ts.map((t) => {
              const idx = days.indexOf(t.due_date!);
              return (
                <button
                  key={t.id} type="button"
                  className={`tl-dot ${isOverdue(t) ? 'overdue' : ''}`}
                  style={{ left: `${(idx / TIMELINE_DAYS) * 100}%`, maxWidth: `${(3 / TIMELINE_DAYS) * 100}%` }}
                  title={`${t.title} — due ${formatDate(t.due_date)}`}
                  onClick={() => props.onEdit(t)}
                >
                  {t.title}
                </button>
              );
            })}
          </div>
        </div>
      ))}
      </div>
    </section>
  );
}

// ── workload ─────────────────────────────────────────────────────────────────

function WorkloadTable(props: { workload: Workload[]; setWorkload: (w: Workload[]) => void }) {
  const { workload, setWorkload } = props;
  useEffect(() => {
    void api<{ workload: Workload[] }>('/tasks/workload').then((r) => setWorkload(r.workload)).catch(() => undefined);
  }, [setWorkload]);
  return (
    <section className="card" style={{ marginTop: 12 }}>
      <h2>Team workload</h2>
      <table className="dense">
        <thead>
          <tr><th className="nosort">Person</th><th className="nosort">Not Started</th><th className="nosort">In Progress</th><th className="nosort">Waiting</th><th className="nosort">Deferred</th><th className="nosort">Overdue</th></tr>
        </thead>
        <tbody>
          {workload.map((w) => (
            <tr key={w.id}>
              <td>{w.full_name} <span className="muted small">{w.role}</span></td>
              <td>{w.not_started}</td>
              <td>{w.in_progress}</td>
              <td>{w.waiting}</td>
              <td>{w.deferred}</td>
              <td>{w.overdue > 0 ? <span className="badge danger">{w.overdue}</span> : 0}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
