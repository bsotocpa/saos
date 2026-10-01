/*
 * THE LAYOUT CHECK (Brian, 2026-09-30, R106) — run on a page as it stands, in the browser.
 *
 * It fails on what Brian's production screenshots showed at narrow widths:
 *   overflow     the page scrolls sideways (the document is wider than the viewport);
 *   word-broken  a word wraps inside itself: a label "a letter per line" (the text element is narrower
 *                than its longest word);
 *   clipped      a select whose chosen option, or a button or field whose text, does not fit and is cut
 *                ("Chan", "This");
 *   spill        a control whose face lies outside its own row, list item or card (it lies over the next);
 *   crowded      below 768, more than two action buttons side by side (R105: the primary and "More");
 *   tap-target   a control a tap cannot reach across 44 × 44 px, measured where the browser routes a tap
 *                (its centre must reach it; a neighbour's hit extension over it is a failure). A link inside
 *                running text is exempt (WCAG 2.5.5's inline exception); a field counts its label.
 *
 * Each failure names the element the way a person would find it: its tag, its test id or label, and
 * its first words. The R105 rules in CLAUDE.md are what the fixes follow.
 */
import type { Page } from '@playwright/test';

export interface LayoutFailure { check: 'overflow' | 'word-broken' | 'clipped' | 'spill' | 'crowded' | 'tap-target'; element: string; detail: string }

export const MIN_TAP = 44;

export async function checkLayout(page: Page): Promise<LayoutFailure[]> {
  return page.evaluate((minTap: number) => {
    const out: Array<{ check: string; element: string; detail: string }> = [];
    const doc = document.documentElement;
    const vw = doc.clientWidth;
    const shown = (el: Element): boolean => {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) return false;
      for (let e: Element | null = el; e; e = e.parentElement) {
        const cs = getComputedStyle(e);
        if (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0') return false;
      }
      return true;
    };
    const name = (el: Element): string => {
      const tag = el.tagName.toLowerCase();
      const testid = el.getAttribute('data-testid');
      const aria = el.getAttribute('aria-label');
      const text = (el instanceof HTMLSelectElement
        ? el.selectedOptions[0]?.textContent ?? ''
        : (el as HTMLElement).innerText ?? el.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 40);
      const id = testid ? `[data-testid=${testid}]` : aria ? `[aria-label="${aria.slice(0, 30)}"]` : '';
      // Where it is: the heading of the card or section it sits in, so a row in the report can be found.
      const box = el.closest('section, .card, details, dialog, [role=dialog]');
      const where = box?.querySelector('h1, h2, h3, summary')?.textContent?.replace(/\s+/g, ' ').trim().slice(0, 30);
      return `${tag}${id}${text ? ` "${text}"` : ''}${where ? ` in "${where}"` : ''}`;
    };

    // overflow: the page scrolls sideways.
    if (doc.scrollWidth > vw + 1) {
      // Name the widest offender: the element reaching furthest right.
      let worst: Element | null = null;
      let right = vw;
      for (const el of Array.from(document.body.querySelectorAll('*'))) {
        const r = el.getBoundingClientRect();
        if (r.right > right + 1 && shown(el)) { right = r.right; worst = el; }
      }
      out.push({ check: 'overflow', element: worst ? name(worst) : 'page', detail: `page ${doc.scrollWidth}px wide in a ${vw}px viewport` });
    }

    // word-broken: a word of two or more characters whose box spans two lines.
    const seen = new Set<Element>();
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let words = 0;
    for (let n = walker.nextNode(); n && words < 4000; n = walker.nextNode()) {
      const parent = n.parentElement;
      if (!parent || seen.has(parent) || ['SCRIPT', 'STYLE', 'NOSCRIPT', 'OPTION', 'TEXTAREA'].includes(parent.tagName)) continue;
      const text = n.textContent ?? '';
      // A word ends at a space or a dash or a slash, and (R105, 2026-10-01) at a token's own seams: an email
      // or a dotted key may wrap after @ . _ (lib/breakable.tsx offers the browser exactly those breaks).
      const re = /[^\s \-–—/@._]{2,}/g;
      for (let m = re.exec(text); m; m = re.exec(text)) {
        words++;
        const range = document.createRange();
        range.setStart(n, m.index);
        range.setEnd(n, m.index + m[0].length);
        const rects = Array.from(range.getClientRects()).filter((r) => r.width > 0);
        if (rects.length > 1 && Math.abs(rects[rects.length - 1]!.top - rects[0]!.top) > 2 && shown(parent)) {
          out.push({ check: 'word-broken', element: name(parent), detail: `"${m[0].slice(0, 30)}" breaks across ${rects.length} lines in a ${Math.round(parent.getBoundingClientRect().width)}px box` });
          seen.add(parent);
          break;
        }
      }
    }

    /*
     * spill (receipt run 59, 2026-10-01): a control whose face lies outside the row, list item or card it
     * belongs to. The Staff actions at 375 were clamped to a 44px cell and lay over the next person's card;
     * no other check saw it. A box that scrolls is exempt (what it hides is reached by scrolling).
     */
    for (const el of Array.from(document.querySelectorAll('a[href], button, input:not([type=hidden]), select, textarea, summary'))) {
      if (!shown(el)) continue;
      const box = el.parentElement?.closest('tr, li, .card, .lead-card, dialog, [role=dialog]');
      if (!box) continue;
      const cs = getComputedStyle(box);
      if (cs.overflowX !== 'visible' || cs.overflowY !== 'visible') continue;
      const r = el.getBoundingClientRect(), b = box.getBoundingClientRect();
      const out_ = Math.max(b.top - r.top, r.bottom - b.bottom, b.left - r.left, r.right - b.right);
      if (out_ > 2) out.push({ check: 'spill', element: name(el), detail: `${Math.round(out_)}px outside its ${box.tagName === 'TR' ? 'row' : box.tagName === 'LI' ? 'list item' : 'card'}` });
    }

    /*
     * crowded (R105 rule 4): below 768 an action group of more than two buttons shows its primary action
     * and a "More" menu. A box with three or more visible action buttons as its own children fails; filter
     * chips, tabs and pressed-state toggles (filters, aria-pressed) are not actions.
     */
    if (vw < 768) {
      const groups = new Set(Array.from(document.querySelectorAll('button.btn, a.btn')).map((b) => b.parentElement).filter((p): p is HTMLElement => !!p));
      for (const g of groups) {
        if (g.classList.contains('more-items')) continue; // an open More menu stacks its items
        const acts = Array.from(g.children).filter((c) => c.matches('button.btn, a.btn') && !c.matches('.chip, [role=tab], [aria-pressed]') && shown(c));
        if (acts.length > 2) out.push({ check: 'crowded', element: name(acts[0]!), detail: `${acts.length} buttons side by side: ${acts.map((a) => (a.textContent ?? '').trim().slice(0, 18)).join(', ')}` });
      }
    }

    // clipped: a select's chosen option wider than its box; a button or field whose text overflows it.
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d')!;
    for (const el of Array.from(document.querySelectorAll('select'))) {
      if (!shown(el)) continue;
      const label = el.selectedOptions[0]?.textContent?.trim() ?? '';
      if (!label) continue;
      const cs = getComputedStyle(el);
      ctx.font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
      const need = ctx.measureText(label).width;
      const room = el.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight) - 18;
      if (need > room + 1) out.push({ check: 'clipped', element: name(el), detail: `"${label.slice(0, 30)}" needs ${Math.round(need)}px, the select shows ${Math.max(0, Math.round(room))}px` });
    }
    for (const el of Array.from(document.querySelectorAll('button, a.btn, input[type=submit], input[type=button]'))) {
      if (!shown(el)) continue;
      const h = el as HTMLElement;
      if (h.scrollWidth > h.clientWidth + 1 && getComputedStyle(h).overflowX !== 'visible') {
        out.push({ check: 'clipped', element: name(el), detail: `text ${h.scrollWidth}px in a ${h.clientWidth}px control` });
      }
    }

    /*
     * tap-target, MEASURED WHERE A TAP IS ROUTED (receipt run 59, 2026-10-01). R113's hit extensions passed
     * a geometric check while a neighbour's extension covered a control's own face: a tap on the "Asked for"
     * box reached the next label, and the walks could not click it. So the check now asks the browser, the
     * way a finger does (elementFromPoint), with the control scrolled to the middle of the screen:
     *   - a tap on the control's centre must reach the control itself (or something inside it);
     *   - the points through that centre that reach it, along each axis, must span the size it needs
     *     (a field's own label counts: a tap on a label is a tap on its field).
     * A link inside running text is exempt (WCAG 2.5.5's inline exception). R114: at 1024 and wider a
     * control inside a table cell needs 24px; everywhere else 44px.
     */
    const controls = Array.from(document.querySelectorAll('a[href], button, input:not([type=hidden]), select, textarea, summary, [role=button], [role=tab]'));
    const startX = window.scrollX, startY = window.scrollY;
    for (const el of controls) {
      if (!shown(el)) continue;
      if (el.tagName === 'A') {
        const block = el.closest('p, li, td, dd, span.small, .muted');
        const linkText = (el.textContent ?? '').trim();
        const blockText = (block?.textContent ?? '').trim();
        if (block && blockText.length > linkText.length + 12 && getComputedStyle(el).display === 'inline') continue;
      }
      const need = vw >= 1024 && el.closest('td, th') ? 24 : minTap;
      const field = el instanceof HTMLInputElement || el instanceof HTMLSelectElement || el instanceof HTMLTextAreaElement;
      const label = field ? (el.closest('label') ?? (el.id ? document.querySelector(`label[for="${CSS.escape(el.id)}"]`) : null)) : null;
      const own = (h: Element | null) => !!h && (h === el || el.contains(h));
      const reaches = (x: number, y: number) => {
        const h = document.elementFromPoint(x, y);
        return own(h) || (!!label && !!h && (h === label || label.contains(h)) && !(h !== label && h.matches('a[href], button, input, select, textarea')));
      };
      el.scrollIntoView({ block: 'center', inline: 'center' });
      // A control that wraps (a long link name over two lines) is tapped on its words: the centre of its
      // largest line box, never the middle of its bounding box, which can fall between the lines.
      const boxes = Array.from(el.getClientRects()).filter((b) => b.width > 0 && b.height > 0);
      const r = boxes.length > 1 ? boxes.reduce((a, b) => (b.width * b.height > a.width * a.height ? b : a)) : el.getBoundingClientRect();
      const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
      const hit = document.elementFromPoint(cx, cy);
      if (!own(hit)) {
        out.push({ check: 'tap-target', element: name(el), detail: `a tap on its centre reaches ${hit ? name(hit) : 'nothing'}` });
        continue;
      }
      // Walk out from the centre, 1px at a time, to the last point that still reaches the control, and
      // name what the next point reaches instead (the neighbour, the edge of a clipping box).
      const stops: string[] = [];
      const reach = (dx: number, dy: number, side: string) => {
        let d = 0;
        while (d < need + 2 && reaches(cx + dx * (d + 1), cy + dy * (d + 1))) d++;
        if (d < need / 2) {
          const by = document.elementFromPoint(cx + dx * (d + 1), cy + dy * (d + 1));
          // Reaching a box the control sits in means its extension was cut there: name the box that clips.
          let clip: Element | null = null;
          for (let a = el.parentElement; a && by && a !== by && !clip; a = a.parentElement) {
            const cs = getComputedStyle(a);
            if (cs.overflowX !== 'visible' || cs.overflowY !== 'visible') clip = a;
          }
          const where = by && by.contains(el) ? (clip ? `cut by ${name(clip).slice(0, 40)} (overflow ${getComputedStyle(clip).overflowX}/${getComputedStyle(clip).overflowY})` : `bare ${name(by).slice(0, 40)}`) : by ? name(by).slice(0, 50) : 'the screen edge';
          stops.push(`${side}: ${where}`);
        }
        return d;
      };
      const w = reach(-1, 0, 'left') + reach(1, 0, 'right') + 1, h = reach(0, -1, 'above') + reach(0, 1, 'below') + 1;
      // Sampled a whole pixel at a time from a fractional centre, a span reads up to 1px short: 1px allowed.
      if (w < need - 1 || h < need - 1) {
        out.push({ check: 'tap-target', element: name(el), detail: `${Math.round(w)}×${Math.round(h)}px reach it${stops.length ? ` (stopped ${stops.join('; ')})` : ''}` });
      }
    }
    window.scrollTo(startX, startY);
    return out;
  }, MIN_TAP) as Promise<LayoutFailure[]>;
}
