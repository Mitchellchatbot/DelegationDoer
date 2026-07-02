// Minimal E.164 phone normalizer, shared across the outbound funnel.
//
// outbound_leads.phone is stored E.164 (Typeform passes phones already-E.164,
// the manual "Add lead" route normalizes on the way in). Anything matching a
// lead by phone must normalize to the same shape first, or an exact lookup
// silently misses (e.g. Calendly delivers "(415) 555-1234").
//
// Strip everything but digits/+, default a bare 10-digit number to US (+1).
// Returns null when the result isn't a plausible E.164 number.
export function normalizeE164(raw: string): string | null {
  let digits = raw.replace(/[^\d+]/g, "");
  if (!digits.startsWith("+")) {
    digits = digits.length === 10 ? "+1" + digits : "+" + digits;
  }
  return /^\+\d{8,15}$/.test(digits) ? digits : null;
}
