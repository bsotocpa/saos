'use client';

/*
 * THE OPS ERROR BOUNDARY (R49, Brian, 2026-09-26). A render error on any Ops page used to leave
 * Next's bare "Application error" line. Now it is one plain sentence and a Reload control. Ops is
 * internal and English; the failure itself is in the browser console for whoever is at the keyboard,
 * and Next's digest is printed so a report can name the occurrence.
 */
export default function OpsError({ error }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <section className="card" data-testid="page-error">
      <p role="alert">This page could not be shown. Reload it; if it fails again, tell Brian which page and what you were doing.</p>
      {error.digest ? <p className="muted small">Reference {error.digest}</p> : null}
      <button className="btn" type="button" onClick={() => window.location.reload()}>Reload</button>
    </section>
  );
}
