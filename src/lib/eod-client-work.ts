// Helpers for matching eod_client_work rows to a client.
//
// The table stores BOTH a real FK (`client_id`, nullable — survives a client
// deletion) and a frozen `client_name` copy taken at the moment the work was
// logged. Historically every email-generating surface matched on `client_name`
// alone, so a client rename (which doesn't cascade to eod_client_work) or any
// casing/whitespace drift silently orphaned that client's entries — they stayed
// in the DB but disappeared from the composer. Matching on the FK OR the frozen
// name is a strict superset: it recovers renamed rows (correct client_id, stale
// name) while still catching legacy rows whose client_id is null.

// Double-quote a value for use inside a PostgREST logic-tree (or()/and()),
// escaping embedded `"` and `\`. Quoting is required whenever a value could
// contain the tree's structural characters (`,` `(` `)`); we quote
// unconditionally so the filter is correct for ANY client name or id. PostgREST
// strips the surrounding quotes, so quoting a plain value is a harmless no-op.
function pgQuote(value: string): string {
  return `"${value.replace(/["\\]/g, (c) => "\\" + c)}"`;
}

// Build a PostgREST or()-filter string matching a row by the client_id FK OR
// the frozen client_name copy. Both values are quoted so a comma/paren in a
// client name (or any future change to the client-id format) can't break the
// filter tree — a plain `.eq("client_name", name)` was immune to this, so the
// or() form must reproduce that safety itself.
export function clientWorkMatchOr(clientId: string, clientName: string): string {
  return `client_id.eq.${pgQuote(clientId)},client_name.eq.${pgQuote(clientName)}`;
}
