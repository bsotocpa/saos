/*
 * THE LAYOUT CHECK (Brian, 2026-09-30, R106) — run on a page as it stands, in the browser.
 *
 * It fails on what Brian's production screenshots showed at narrow widths:
 *   overflow     the page scrolls sideways (the document is wider than the viewport);
 *   word-broken  a word wraps inside itself: a label "a letter per line" (the text element is narrower
 *                than its longest word);
 *   clipped      a select whose chosen option, or a button or field whose text, does not fit and is cut
 *                ("Chan", "This");
 *   tap-target   a control smaller than 44 × 44 px. A link inside running text is exempt (WCAG 2.5.5's
 *                inline exception); a checkbox or radio counts its label as its target.
 *
 * Each failure names the element the way a person would find it: its tag, its test id or label, and
 * its first words. The R105 rules in CLAUDE.md are what the fixes follow.
 */
import type { Page } from '@playwright/test';

export interface LayoutFailure { check: 'overflow' | 'word-broken' | 'clipped' | 'tap-target'; element: string; detail: string }

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
     * R113: an element's hit area — its box grown by an invisible extension (an absolutely positioned
     * ::after with negative insets), clipped by any ancestor that hides its overflow (a scroll container
     * only across its scroll axis: what is scrolled out of view along it is reached by scrolling).
     */
    const hitRect = (el: Element): DOMRect => {
      const r = el.getBoundingClientRect();
      const after = getComputedStyle(el, '::after');
      if (after.content === 'none' || after.content === 'normal' || after.position !== 'absolute') return r;
      const px = (v: string) => (v.endsWith('px') ? parseFloat(v) : 0);
      let box = {
        top: Math.min(r.top, r.top + px(after.top)), bottom: Math.max(r.bottom, r.bottom - px(after.bottom)),
        left: Math.min(r.left, r.left + px(after.left)), right: Math.max(r.right, r.right - px(after.right)),
      };
      const scrolls = (v: string) => v === 'auto' || v === 'scroll';
      for (let a = el.parentElement; a && a !== document.body; a = a.parentElement) {
        const cs = getComputedStyle(a);
        if (cs.overflowX === 'visible' && cs.overflowY === 'visible') continue;
        const ar = a.getBoundingClientRect();
        if (!scrolls(cs.overflowX)) box = { ...box, left: Math.max(box.left, ar.left), right: Math.min(box.right, ar.right) };
        if (!scrolls(cs.overflowY)) box = { ...box, top: Math.max(box.top, ar.top), bottom: Math.min(box.bottom, ar.bottom) };
      }
      return new DOMRect(box.left, box.top, box.right - box.left, box.bottom - box.top);
    };
    const union = (a: DOMRect, b: DOMRect) => {
      const left = Math.min(a.left, b.left), top = Math.min(a.top, b.top);
      return new DOMRect(left, top, Math.max(a.right, b.right) - left, Math.max(a.bottom, b.bottom) - top);
    };

    // tap-target: every control at least minTap × minTap, links in running text excepted.
    const controls = Array.from(document.querySelectorAll('a[href], button, input:not([type=hidden]), select, textarea, summary, [role=button], [role=tab]'));
    for (const el of controls) {
      if (!shown(el)) continue;
      if (el.tagName === 'A') {
        const block = el.closest('p, li, td, dd, span.small, .muted');
        const linkText = (el.textContent ?? '').trim();
        const blockText = (block?.textContent ?? '').trim();
        if (block && blockText.length > linkText.length + 12 && getComputedStyle(el).display === 'inline') continue;
      }
      let r = hitRect(el);
      // A checkbox, a radio or a file picker counts its label; any other field inside its label counts the
      // label too (a tap on the label's words, or its extension, focuses the field).
      const label = el.closest('label') ?? (el instanceof HTMLInputElement && el.id ? document.querySelector(`label[for="${el.id}"]`) : null);
      if (label && (el instanceof HTMLInputElement || el instanceof HTMLSelectElement || el instanceof HTMLTextAreaElement)) {
        r = union(r, hitRect(label));
      }
      // R114 (2026-10-01): at 1024 and wider a control inside a table row is held to 24px (dense desk tables,
      // WCAG 2.5.8); everywhere else, and in every table below 1024, to 44px.
      const need = vw >= 1024 && el.closest('td, th') ? 24 : minTap;
      if (r.width < need - 0.5 || r.height < need - 0.5) {
        out.push({ check: 'tap-target', element: name(el), detail: `${Math.round(r.width)}×${Math.round(r.height)}px` });
      }
    }
    return out;
  }, MIN_TAP) as Promise<LayoutFailure[]>;
}
