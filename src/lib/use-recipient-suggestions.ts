"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { ClientSuggestion } from "@/components/RecipientAutocomplete";

// Loads the To/Cc typeahead roster shared by both composers (the main Compose
// window and the inline reply composer): saved clients (with an email on file)
// plus our own team inboxes + teammates. Clients render first so the dropdown's
// "Team" section divider lands after them.
//
// Fetched once, the first time `enabled` turns true (a ref gates it), so the
// modal/composer only pays for it when actually opened. Silent on failure — the
// fields just behave as plain inputs.
export function useRecipientSuggestions(enabled: boolean): ClientSuggestion[] {
  const [clients, setClients] = useState<ClientSuggestion[]>([]);
  const [team, setTeam] = useState<ClientSuggestion[]>([]);
  const loadedRef = useRef(false);

  useEffect(() => {
    if (!enabled || loadedRef.current) return;
    loadedRef.current = true;
    let cancelled = false;

    fetch("/api/clients", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : { clients: [] }))
      .then((d) => {
        if (cancelled) return;
        const list = ((d.clients ?? []) as Array<{ id: string; name: string; contactName?: string | null; contactEmails?: string[] }>)
          .map((c) => ({
            id: c.id,
            name: c.name,
            contactName: c.contactName ?? null,
            contactEmails: c.contactEmails ?? [],
          }))
          .filter((c) => c.contactEmails.length > 0);
        setClients(list);
      })
      .catch(() => { loadedRef.current = false; });

    // Team inboxes + teammates. Already in ClientSuggestion shape from the
    // route; silent on failure — the typeahead just shows clients only.
    fetch("/api/team-emails", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : { suggestions: [] }))
      .then((d) => {
        if (cancelled) return;
        const list = ((d.suggestions ?? []) as Array<{ id: string; name: string; contactName?: string | null; contactEmails?: string[] }>)
          .map((s) => ({
            id: s.id,
            name: s.name,
            contactName: s.contactName ?? null,
            contactEmails: s.contactEmails ?? [],
            category: "team" as const,
          }))
          .filter((s) => s.contactEmails.length > 0);
        setTeam(list);
      })
      .catch(() => { /* silent — To/Cc fall back to clients only */ });

    return () => { cancelled = true; };
  }, [enabled]);

  // Clients first so the typeahead's "Team" section renders after them.
  return useMemo(() => [...clients, ...team], [clients, team]);
}
