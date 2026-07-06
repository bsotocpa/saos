// Knowledge-based authentication — the IRS Pub 1345 requirement ahead of any
// REMOTE 8879 signature (MP: per-signature KBA API, ~$1–3/sig, vendor
// APPROVED but not yet selected — Brian's decision at M23).
//
// PLUGGABLE (MP hard requirement): swapping vendors must never touch the
// signing flow. The flow talks only to this interface; a real vendor drops in
// as one new adapter. The sandbox adapter drives dev/tests via an explicit
// simulate endpoint that exists ONLY in sandbox mode — production with no
// real vendor configured refuses to start a remote 8879 at all.

import type { Config } from '../../config.ts';
import { AppError } from '../../types.ts';

export interface KbaVerifier {
  readonly vendor: string;
  /** Begin identity verification for a signer. Returns the vendor's session ref. */
  start(opts: {
    envelopeId: string;
    contactId: string;
    recipientEmail: string;
    recipientName: string;
  }): Promise<{ vendorRef: string }>;
}

function sandboxVerifier(): KbaVerifier {
  return {
    vendor: 'sandbox',
    async start(opts) {
      // Real vendors return a hosted-session URL/ref; the sandbox just mints
      // a ref and waits for the simulate endpoint to resolve it.
      return { vendorRef: `sandbox-${opts.envelopeId}` };
    },
  };
}

export function makeKbaVerifier(config: Config): KbaVerifier {
  if (config.KBA_MODE === 'vendor') {
    // Wired when Brian selects the vendor (M23 decision point): implement one
    // adapter here, set KBA_MODE=vendor, done — the signing flow is untouched.
    throw new AppError(503, 'kba_vendor_not_configured', 'KBA vendor adapter not implemented yet.');
  }
  return sandboxVerifier();
}

/** Production may never rely on the sandbox: remote 8879 requires real KBA. */
export function assertKbaUsable(config: Config): void {
  if (config.NODE_ENV === 'production' && config.KBA_MODE !== 'vendor') {
    throw new AppError(
      503,
      'kba_vendor_not_configured',
      'Remote 8879 signing is unavailable: no KBA vendor is configured (IRS Pub 1345 requires KBA). Use the in-person wet path or configure the vendor.'
    );
  }
}
