// Prefilled booking links for authenticated portal clients.
//
// The portal checklist's "Book your consultation" step points at
// `booking.client_booking_url` (a setting, so scheduling opens without a deploy —
// see finding #9). An authenticated client should never retype their own name and
// email into the booking page: we already know who they are, so Cal.com's prefill
// query parameters carry it.
//
// Prefill is a CONVENIENCE, not a claim of identity. Cal.com fields stay editable,
// so a client booking on behalf of a spouse can change them. Nothing downstream
// trusts these values — the booking is matched back to a contact by other means.
//
// Deliberately NOT here: phone, language, client status. Those are intake questions
// on the PUBLIC new-client event, where the booker is a stranger. An authenticated
// client answering "are you a current client?" is the system forgetting who it is
// talking to.

/**
 * Append Cal.com prefill parameters to a booking URL.
 *
 * Returns the URL unchanged when it is not parseable, so a mistyped setting
 * degrades to "the link goes somewhere odd" rather than throwing inside the
 * checklist endpoint and taking the whole portal home page down with it.
 *
 * Existing query parameters on the setting are preserved (Brian may append
 * `?month=` or a tracking parameter); prefill values win on collision, since the
 * session is more authoritative than a setting typed by hand.
 */
export function prefillBookingUrl(
  baseUrl: string,
  client: { name: string | null; email: string | null }
): string {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    return baseUrl;
  }
  // http(s) only. A setting containing `javascript:` or `data:` must never reach an
  // href in the portal, and the checklist renders this straight into one.
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return baseUrl;

  const name = client.name?.trim();
  const email = client.email?.trim();
  if (name) url.searchParams.set('name', name);
  if (email) url.searchParams.set('email', email);
  return url.toString();
}
