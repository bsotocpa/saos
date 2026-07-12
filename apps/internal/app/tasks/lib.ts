// Shared types + constants for the v4.5 task workspace (Zoho-benchmark UI).

export interface Task {
  id: string;
  title: string;
  description: string | null;
  status: TaskStatus;
  priority: number;
  due_date: string | null;
  source: string;
  source_type: string | null;
  client_visible: boolean;
  sop_link: string | null;
  tags: string[];
  contact_id: string | null;
  business_id: string | null;
  engagement_id: string | null;
  remind_at: string | null;
  recur_freq: string | null;
  recur_interval: number;
  parent_task_id: string | null;
  waiting_since: string | null;
  ladder_rung: number;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
  assignee_name: string | null;
  assigned_staff_id: string | null;
  created_by_name: string | null;
  created_by_staff_id: string | null;
  client_name: string | null;
  business_name: string | null;
  checklist_total: number;
  checklist_done: number;
  comment_count: number;
}

export type TaskStatus = 'not_started' | 'in_progress' | 'waiting_for_input' | 'completed' | 'deferred' | 'cancelled';

export const STATUSES: { value: TaskStatus; label: string }[] = [
  { value: 'not_started', label: 'Not Started' },
  { value: 'in_progress', label: 'In Progress' },
  { value: 'waiting_for_input', label: 'Waiting for input' },
  { value: 'completed', label: 'Completed' },
  { value: 'deferred', label: 'Deferred' },
];
export const STATUS_LABEL: Record<string, string> = Object.fromEntries(
  [...STATUSES, { value: 'cancelled', label: 'Cancelled' }].map((s) => [s.value, s.label])
);

export const PRIORITIES = [
  { value: 0, label: 'Normal' },
  { value: 1, label: 'High' },
  { value: 2, label: 'Urgent' },
];
export const PRIORITY_LABEL = ['Normal', 'High', 'Urgent'];

export const RECUR_FREQS = ['daily', 'weekly', 'monthly', 'quarterly', 'annually', 'custom'] as const;

export const LADDER_LABEL = ['', 'D3', 'D7', 'D14', 'D30'];

export interface StaffEntry { id: string; full_name: string; role: string }

export interface SavedView {
  id: string;
  name: string;
  owner_staff_id: string;
  owner_name: string;
  shared: boolean;
  view_type: 'list' | 'kanban' | 'calendar' | 'timeline';
  filters: Record<string, unknown>;
  sort: { field?: string; dir?: 'asc' | 'desc' };
  columns: string[];
  group_by: string | null;
}

/** UI filter state — serialized into /tasks/search params and into saved views. */
export interface Filters {
  q: string;
  status: TaskStatus[];
  priority: number[];
  assignee: string;        // staff id or '' (any) or 'me'
  unassigned: boolean;
  contactId: string;
  contactName: string;     // display only
  businessId: string;
  businessName: string;    // display only
  tag: string;
  sourceType: string;
  clientVisible: '' | 'true' | 'false';
  due: '' | 'overdue' | 'today' | 'week' | 'range';
  dueFrom: string;
  dueTo: string;
  createdByMe: boolean;
  delegatedByMe: boolean;
  untouchedDays: string;
  includeDone: boolean;
  sortField: string;
  sortDir: 'asc' | 'desc';
}

export const EMPTY_FILTERS: Filters = {
  q: '', status: [], priority: [], assignee: '', unassigned: false,
  contactId: '', contactName: '', businessId: '', businessName: '',
  tag: '', sourceType: '', clientVisible: '', due: '', dueFrom: '', dueTo: '',
  createdByMe: false, delegatedByMe: false, untouchedDays: '', includeDone: false,
  sortField: 'priority', sortDir: 'desc',
};

export function buildSearchQuery(f: Filters, meId: string): string {
  const p = new URLSearchParams();
  if (f.q.trim()) p.set('q', f.q.trim());
  if (f.status.length) p.set('status', f.status.join(','));
  if (f.priority.length) p.set('priority', f.priority.join(','));
  if (f.assignee) p.set('assignee', f.assignee === 'me' ? meId : f.assignee);
  if (f.unassigned) p.set('unassigned', 'true');
  if (f.contactId) p.set('contactId', f.contactId);
  if (f.businessId) p.set('businessId', f.businessId);
  if (f.tag.trim()) p.set('tag', f.tag.trim());
  if (f.sourceType) p.set('sourceType', f.sourceType);
  if (f.clientVisible) p.set('clientVisible', f.clientVisible);
  if (f.due === 'overdue') p.set('overdue', 'true');
  if (f.due === 'today') p.set('dueToday', 'true');
  if (f.due === 'week') p.set('dueThisWeek', 'true');
  if (f.due === 'range') {
    if (f.dueFrom) p.set('dueFrom', f.dueFrom);
    if (f.dueTo) p.set('dueTo', f.dueTo);
  }
  if (f.createdByMe) p.set('createdBy', meId);
  if (f.delegatedByMe) p.set('delegatedBy', meId);
  if (f.untouchedDays) p.set('untouchedDays', f.untouchedDays);
  if (f.includeDone) p.set('includeDone', 'true');
  p.set('sortField', f.sortField);
  p.set('sortDir', f.sortDir);
  p.set('limit', '1000');
  return p.toString();
}

/** All list columns the chooser offers; title is always shown. */
export const ALL_COLUMNS: { key: string; label: string }[] = [
  { key: 'status', label: 'Status' },
  { key: 'priority', label: 'Priority' },
  { key: 'due_date', label: 'Due Date' },
  { key: 'assignee', label: 'Task Owner' },
  { key: 'client', label: 'Contact' },
  { key: 'business', label: 'Business' },
  { key: 'tags', label: 'Tags' },
  { key: 'source', label: 'Source' },
  { key: 'waiting', label: 'Waiting' },
  { key: 'checklist', label: 'Checklist' },
  { key: 'created_at', label: 'Created' },
];
export const DEFAULT_COLUMNS = ['status', 'priority', 'due_date', 'assignee', 'client', 'tags'];

/** Kanban can group by any picklist-ish field (v4.5). */
export const GROUP_FIELDS: { key: string; label: string }[] = [
  { key: 'status', label: 'Status' },
  { key: 'priority', label: 'Priority' },
  { key: 'assignee', label: 'Task Owner' },
  { key: 'source_type', label: 'Source' },
];

export const SOURCE_TYPES = [
  'enrichment', 'doc_request', 'irs_notice', 'extension_decision', 'annual_report', 'meeting_action_item',
  'invoice_overdue', 'referral_approval', 'service_request', 'booking', 'form_submission', 'ladder_call',
  'stalled_flag', 'trello', 'voucher_period', 'deposit_day60',
];

export function todayStr(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
}

export function isOverdue(t: Task): boolean {
  return Boolean(t.due_date && t.due_date < todayStr() && t.status !== 'completed' && t.status !== 'cancelled');
}
