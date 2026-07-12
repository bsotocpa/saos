// Trello board-export importer (M25, v4.4: full Trello replacement).
// Input: the JSON a Trello board export produces. Boards → boards, open
// lists → columns, open cards → tasks (due dates, assignee by full-name
// match, checklists), cards in done-ish lists arrive completed. Idempotent:
// a card's Trello id is its task source_id — reruns never duplicate.

import type { FastifyInstance } from 'fastify';

export interface TrelloExport {
  name: string;
  lists: Array<{ id: string; name: string; closed: boolean; pos?: number }>;
  cards: Array<{
    id: string; name: string; desc?: string; due?: string | null;
    idList: string; closed: boolean; idMembers?: string[];
  }>;
  checklists?: Array<{ idCard: string; checkItems: Array<{ name: string; state: 'complete' | 'incomplete' }> }>;
  members?: Array<{ id: string; fullName: string }>;
}

export interface TrelloImportResult {
  board: string;
  columns: number;
  tasksCreated: number;
  tasksSkipped: number;
  assigneesMatched: number;
  checklistItems: number;
}

const DONE_LIST = /\b(done|complete|completed|shipped|finished)\b/i;

export async function importTrelloBoard(app: FastifyInstance, data: TrelloExport): Promise<TrelloImportResult> {
  // Board (by name, idempotent).
  const existing = await app.db.query<{ id: string }>(`SELECT id FROM boards WHERE name = $1 LIMIT 1`, [data.name]);
  const boardId =
    existing.rows[0]?.id ??
    (await app.db.query<{ id: string }>(`INSERT INTO boards (name) VALUES ($1) RETURNING id`, [data.name])).rows[0]!.id;

  // Columns from OPEN lists, order preserved.
  const openLists = data.lists.filter((l) => !l.closed).sort((a, b) => (a.pos ?? 0) - (b.pos ?? 0));
  const columnByList = new Map<string, string>();
  for (const [i, list] of openLists.entries()) {
    const col = await app.db.query<{ id: string }>(
      `SELECT id FROM board_columns WHERE board_id = $1 AND name = $2 LIMIT 1`,
      [boardId, list.name]
    );
    const columnId =
      col.rows[0]?.id ??
      (await app.db.query<{ id: string }>(
        `INSERT INTO board_columns (board_id, name, position) VALUES ($1, $2, $3) RETURNING id`,
        [boardId, list.name, i]
      )).rows[0]!.id;
    columnByList.set(list.id, columnId);
  }

  // Member full names → staff ids.
  const staffByName = new Map<string, string>();
  const staff = await app.db.query<{ id: string; full_name: string }>(`SELECT id, full_name FROM staff WHERE is_active`);
  for (const s of staff.rows) staffByName.set(s.full_name.toLowerCase(), s.id);
  const memberName = new Map((data.members ?? []).map((m) => [m.id, m.fullName]));

  const checklistsByCard = new Map<string, Array<{ name: string; state: string }>>();
  for (const cl of data.checklists ?? []) {
    checklistsByCard.set(cl.idCard, [...(checklistsByCard.get(cl.idCard) ?? []), ...cl.checkItems]);
  }

  const result: TrelloImportResult = {
    board: data.name, columns: openLists.length,
    tasksCreated: 0, tasksSkipped: 0, assigneesMatched: 0, checklistItems: 0,
  };

  for (const card of data.cards) {
    if (card.closed) continue;
    const columnId = columnByList.get(card.idList);
    if (!columnId) continue; // card on an archived list

    // Idempotence across ANY status — a re-run never resurrects or doubles.
    const dupe = await app.db.query(
      `SELECT 1 FROM tasks WHERE source_type = 'trello' AND source_id = $1 LIMIT 1`,
      [card.id]
    );
    if (dupe.rows.length > 0) {
      result.tasksSkipped++;
      continue;
    }

    const listName = openLists.find((l) => l.id === card.idList)?.name ?? '';
    const done = DONE_LIST.test(listName);
    let assignee: string | null = null;
    for (const memberId of card.idMembers ?? []) {
      const name = memberName.get(memberId)?.toLowerCase();
      if (name && staffByName.has(name)) {
        assignee = staffByName.get(name)!;
        result.assigneesMatched++;
        break;
      }
    }

    const { rows } = await app.db.query<{ id: string }>(
      `INSERT INTO tasks (title, description, assigned_staff_id, due_date, status, completed_at,
                          source, source_type, source_id, board_column_id)
       VALUES ($1, $2, $3, $4, $5::task_status, CASE WHEN $5::text = 'completed' THEN now() END, 'import', 'trello', $6, $7)
       RETURNING id`,
      [
        card.name, card.desc || null, assignee, card.due ? card.due.slice(0, 10) : null,
        done ? 'completed' : 'not_started', card.id, columnId,
      ]
    );
    result.tasksCreated++;
    for (const [i, item] of (checklistsByCard.get(card.id) ?? []).entries()) {
      await app.db.query(
        `INSERT INTO task_checklist_items (task_id, label, done, position) VALUES ($1, $2, $3, $4)`,
        [rows[0]!.id, item.name, item.state === 'complete', i]
      );
      result.checklistItems++;
    }
  }
  return result;
}
