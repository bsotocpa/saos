'use client';

// Project boards (v4.4 view #5): kanban for non-client work — firm projects,
// Brian's personal board. Move controls per card (wireframe pass may add
// drag); columns are custom per board.

import { formatDate } from '../../../lib/dates';
import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { api, isAuthed } from '../../../lib/api';

interface Board { id: string; name: string; owner_staff_id: string | null; owner_name: string | null }
interface Column { id: string; name: string; position: number }
interface Card { id: string; title: string; status: string; priority: number; due_date: string | null; board_column_id: string; assignee_name: string | null }

export default function BoardsPage() {
  const router = useRouter();
  const [boards, setBoards] = useState<Board[]>([]);
  const [active, setActive] = useState<string | null>(null);
  const [columns, setColumns] = useState<Column[]>([]);
  const [cards, setCards] = useState<Card[]>([]);
  const [newBoard, setNewBoard] = useState('');
  const [newCard, setNewCard] = useState('');
  // THE ERROR STAYS WITH THE CONTROL (Brian, 2026-09-19, defect 2): a refusal renders beside the
  // input or select that caused it, verbatim, with the typed text kept.
  const [inlineErr, setInlineErr] = useState<{ key: string; message: string } | null>(null);
  const errAt = (key: string) => (inlineErr?.key === key ? <p className="field-error" role="alert">{inlineErr.message}</p> : null);
  const refused = (err: unknown) => (err instanceof Error && err.message ? err.message : 'The request was refused.');

  const loadBoards = useCallback(async () => {
    const r = await api<{ boards: Board[] }>('/boards');
    setBoards(r.boards);
    if (!active && r.boards[0]) setActive(r.boards[0].id);
  }, [active]);

  const loadBoard = useCallback(async () => {
    if (!active) return;
    const r = await api<{ columns: Column[]; tasks: Card[] }>(`/boards/${active}`);
    setColumns(r.columns);
    setCards(r.tasks);
  }, [active]);

  useEffect(() => {
    if (!isAuthed()) {
      router.replace('/login');
      return;
    }
    void loadBoards();
  }, [router, loadBoards]);

  useEffect(() => {
    void loadBoard();
  }, [loadBoard]);

  const move = async (cardId: string, columnId: string) => {
    setInlineErr(null);
    try {
      await api(`/tasks/${cardId}/move`, { method: 'PATCH', body: { boardColumnId: columnId } });
      await loadBoard();
    } catch (err) {
      setInlineErr({ key: `move:${cardId}`, message: refused(err) });
    }
  };

  const createBoard = async () => {
    if (!newBoard.trim()) return;
    setInlineErr(null);
    try {
      await api('/boards', { method: 'POST', body: { name: newBoard.trim() } });
      setNewBoard('');
      await loadBoards();
    } catch (err) {
      setInlineErr({ key: 'board', message: refused(err) });
    }
  };

  const addCard = async () => {
    const first = columns[0];
    if (!newCard.trim() || !first) return;
    setInlineErr(null);
    try {
      await api('/tasks', { method: 'POST', body: { title: newCard.trim(), boardColumnId: first.id } });
      setNewCard('');
      await loadBoard();
    } catch (err) {
      setInlineErr({ key: 'card', message: refused(err) });
    }
  };

  return (
    <>
      <h1>Project boards</h1>
      <section className="card">
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          {boards.map((b) => (
            <button
              key={b.id}
              type="button"
              className={`btn ${active === b.id ? '' : 'ghost'}`}
              onClick={() => setActive(b.id)}
            >
              {b.name}
              {b.owner_staff_id ? ' (personal)' : ''}
            </button>
          ))}
          <form
            onSubmit={(e) => { e.preventDefault(); void createBoard(); }}
            style={{ display: 'flex', gap: 6 }}
          >
            <input placeholder="New board…" value={newBoard} onChange={(e) => setNewBoard(e.target.value)} />
            <button className="btn ghost" type="submit">Create</button>
          </form>
        </div>
        {errAt('board')}
      </section>

      {active ? (
        <>
          <section className="card">
            <form
              onSubmit={(e) => { e.preventDefault(); void addCard(); }}
              style={{ display: 'flex', gap: 8 }}
            >
              <input placeholder="New card…" value={newCard} onChange={(e) => setNewCard(e.target.value)} style={{ flex: 1 }} />
              <button className="btn" type="submit">Add card</button>
            </form>
            {errAt('card')}
          </section>
          <div style={{ display: 'grid', gridTemplateColumns: `repeat(${Math.max(columns.length, 1)}, 1fr)`, gap: 12 }}>
            {columns.map((col) => (
              <section className="card" key={col.id}>
                <h2>{col.name}</h2>
                {cards.filter((c) => c.board_column_id === col.id).map((c) => (
                  <div key={c.id} className="card" style={{ padding: 10, marginBottom: 8 }}>
                    <strong className="small">{c.title}</strong>
                    <br />
                    <span className="muted small">
                      {c.assignee_name ?? 'unassigned'}
                      {c.due_date ? ` · due ${formatDate(c.due_date)}` : ''}
                    </span>
                    <br />
                    <select
                      className="small"
                      value={col.id}
                      onChange={(e) => void move(c.id, e.target.value)}
                    >
                      {columns.map((target) => (
                        <option key={target.id} value={target.id}>{target.name}</option>
                      ))}
                    </select>
                    {errAt(`move:${c.id}`)}
                  </div>
                ))}
              </section>
            ))}
          </div>
        </>
      ) : (
        <p className="muted">Create a board to get started — firm projects and personal boards live here.</p>
      )}
    </>
  );
}
