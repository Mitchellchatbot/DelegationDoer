import type { ExecPrincipal, ExecSettings } from "@/lib/exec/types";

// Whether a chat tool can read his mailbox (review ui-10; Area E; pure,
// client-safe): email intelligence installed and on, and a pinned mailbox
// (P3 L1). Copy only: when false the empty state, the drawer's subtitle and
// the client starters don't claim the mailbox. The tools gate for real.

export function chatEmailOn(settings: Pick<ExecSettings, "emailSchemaReady" | "emailEnabled">, principal: Pick<ExecPrincipal, "mailAccountIds">): boolean {
  return settings.emailSchemaReady === true && settings.emailEnabled === true &&
    Array.isArray(principal.mailAccountIds) && principal.mailAccountIds.some((id) => typeof id === "string" && id.length > 0);
}
