/*
 * BREAK AT THE TOKEN'S OWN SEAMS (Brian, 2026-10-01, R105 rule 2). An email, a dotted key or a file name
 * has no spaces, so in a narrow cell it either widens the page or breaks a letter at a time. This offers
 * the browser a break after each @ . _ (a <wbr>), so such a token wraps at its seams, never inside a word.
 * The harness layout check counts the same characters as word boundaries.
 */
import { Fragment } from 'react';

export function Breakable({ text }: { text: string }): React.JSX.Element {
  const parts = text.split(/(?<=[@._])/);
  return <>{parts.map((p, i) => <Fragment key={i}>{p}{i < parts.length - 1 ? <wbr /> : null}</Fragment>)}</>;
}
