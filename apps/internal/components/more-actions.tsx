'use client';
/*
 * R105 RULE 4 (Brian, 2026-09-30): below 768 an action group of more than two buttons shows its primary
 * action and a "More" menu. The secondary actions go inside <MoreActions>, beside the primary. At 768 and
 * wider the menu is not there at all: its items render in place exactly as before (display: contents), so
 * 1440 looks as it does now. Below 768 they collapse behind one "More" button and open as a stacked list,
 * each item a whole 44px row. One set of buttons, never a copy: a handler runs from one place.
 */
import { useState, type ReactNode } from 'react';

export function MoreActions({ children, testId }: { children: ReactNode; testId?: string }): React.JSX.Element {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className="btn ghost more-toggle" aria-expanded={open} data-testid={testId} onClick={() => setOpen((o) => !o)}>
        More {open ? '▴' : '▾'}
      </button>
      <span className={`more-items${open ? ' open' : ''}`}>{children}</span>
    </>
  );
}
