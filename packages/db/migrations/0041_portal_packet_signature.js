/**
 * PORTAL-NATIVE E-SIGNATURE for engagement packets (Brian's Option 2 ruling).
 *
 * Docuseal self-hosted stays for Form 8879, where IRS Pub 1345 requires KBA and the
 * vendor's identity-verification trail is the point. Engagement packets do not
 * legally require KBA: Master §4 already carries the client's E-SIGN / UETA consent
 * to electronic records and signatures. Signing them in our own portal keeps every
 * client document in-house at zero recurring cost — the whole thesis — and removes
 * the constraint that Docuseal community cannot accept a generated document.
 *
 * What E-SIGN / UETA actually require, and where each lives here:
 *
 *   INTENT to sign          -> signed_name typed by the client + intent_affirmed
 *   CONSENT to e-records    -> Master §4, and esign_consent_ack recorded at signing
 *   ATTRIBUTION             -> portal_user_id from the authenticated session, + ip
 *   INTEGRITY / retention   -> document_sha256 over the exact bytes signed, plus the
 *                              rendered document stored immutably in MinIO
 *   ABILITY TO RETAIN A COPY-> document_object_key, downloadable from the portal
 *
 * The hash is the load-bearing part. It is computed over the document the client was
 * SHOWN, submitted back with the signature, and re-verified server-side against a
 * fresh render. If the terms changed between reading and signing — a price edit, a
 * template update, a schedule added — the hashes differ and the signature is
 * refused. "You signed something other than what you read" becomes impossible
 * rather than unlikely.
 */

exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE packet_signatures (
      id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      packet_id          uuid NOT NULL UNIQUE REFERENCES engagement_packets(id) ON DELETE CASCADE,
      contact_id         uuid NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
      -- WHO signed, from the verified session — never from the request body.
      portal_user_id     uuid NOT NULL REFERENCES portal_users(id),
      signed_name        text NOT NULL CHECK (length(btrim(signed_name)) >= 2),
      -- Intent and consent are separate affirmative acts, both required.
      intent_affirmed    boolean NOT NULL CHECK (intent_affirmed),
      esign_consent_ack  boolean NOT NULL CHECK (esign_consent_ack),
      -- WHAT was signed: the hash of the exact rendered document, its stored copy,
      -- and the template versions that produced it.
      document_sha256    text NOT NULL CHECK (document_sha256 ~ '^[0-9a-f]{64}$'),
      document_object_key text NOT NULL,
      section_versions   jsonb NOT NULL,
      language           text NOT NULL DEFAULT 'en' CHECK (language IN ('en', 'es')),
      signed_at          timestamptz NOT NULL DEFAULT now(),
      ip                 text,
      user_agent         text,
      created_at         timestamptz NOT NULL DEFAULT now()
    );
    COMMENT ON TABLE packet_signatures IS
      'Portal-native E-SIGN/UETA signature for an engagement packet. One per packet. document_sha256 is verified against a fresh render at signing time, so a client can never sign text other than what they read.';
    COMMENT ON COLUMN packet_signatures.portal_user_id IS
      'Attribution comes from the authenticated portal session, never from client-supplied input.';

    CREATE INDEX idx_packet_signatures_contact ON packet_signatures (contact_id);

    -- A packet signed in the portal has no Docuseal envelope, so the existing
    -- "signed requires signed_at" rule still holds while envelope_id stays NULL.
    ALTER TABLE engagement_packets
      ADD COLUMN signature_method text
        CHECK (signature_method IS NULL OR signature_method IN ('portal_esign', 'docuseal')),
      ADD CONSTRAINT engagement_packets_signed_has_method CHECK (
        status <> 'signed' OR signature_method IS NOT NULL
      );
    COMMENT ON COLUMN engagement_packets.signature_method IS
      'portal_esign = signed in the Soto portal (engagement packets). docuseal = signed via the vendor (kept for 8879 and any historical packet).';
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    ALTER TABLE engagement_packets
      DROP CONSTRAINT engagement_packets_signed_has_method,
      DROP COLUMN signature_method;
    DROP TABLE packet_signatures;
  `);
};
