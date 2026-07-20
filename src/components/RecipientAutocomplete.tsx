"use client";

import { useEffect, useMemo, useRef, useState, Fragment } from "react";
import { cn } from "@/lib/utils";

// A recipient text input with a client-roster typeahead. Keeps the same
// comma/newline-separated string model the compose form already uses
// (submit/saveDraft split on /[,\n]/) — selecting a suggestion just
// rewrites the address currently being typed, so nothing downstream
// changes. Mirrors the custom dropdown pattern in NewTaskForm.

export type ClientSuggestion = {
  id: string;
  name: string;
  contactName: string | null;
  contactEmails: string[];
  // "client" (default) groups render as-is; "team" groups (our own inboxes
  // / teammates) are listed after a one-time "Team" section divider; "thread"
  // groups are this thread's own participants, listed first under an "In this
  // thread" divider and exempt from the MAX_CLIENTS cap.
  category?: "client" | "team" | "thread";
};

// One selectable row in the dropdown. "all" inserts every (still-absent)
// email for a client at once; "email" inserts a single address.
type FlatItem = {
  index: number;
  clientId: string;
  clientName: string;
  contactName: string | null;
  category: "client" | "team" | "thread";
  groupStart: boolean; // render the client header before this row
} & ({ kind: "all"; emails: string[] } | { kind: "email"; email: string });

const MAX_CLIENTS = 8;

// Index of the last , or \n — the boundary between already-committed
// recipients and the address the user is currently typing.
function lastBoundary(value: string): number {
  return Math.max(value.lastIndexOf(","), value.lastIndexOf("\n"));
}

export function RecipientAutocomplete({
  value,
  onChange,
  clients,
  placeholder,
  autoFocus,
  inputClassName,
}: {
  value: string;
  onChange: (v: string) => void;
  clients: ClientSuggestion[];
  placeholder?: string;
  autoFocus?: boolean;
  // Override the input's styling so the typeahead can blend into hosts
  // with different field sizes (defaults to the compose-modal look).
  inputClassName?: string;
}) {
  const [focused, setFocused] = useState(false);
  const [active, setActive] = useState(0);
  // Escape hides the dropdown without blurring; cleared on the next
  // keystroke (or refocus) so typing more brings suggestions back.
  const [dismissed, setDismissed] = useState(false);
  const blurTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // The address fragment being typed (everything after the last comma).
  const activeToken = useMemo(() => value.slice(lastBoundary(value) + 1).trim(), [value]);

  // Addresses already committed in the field — so we never re-suggest
  // (or duplicate) one the user has already added.
  const presentEmails = useMemo(() => {
    const idx = lastBoundary(value);
    const prefix = idx >= 0 ? value.slice(0, idx + 1) : "";
    return new Set(
      prefix.split(/[,\n]/).map((s) => s.trim().toLowerCase()).filter(Boolean)
    );
  }, [value]);

  const items = useMemo<FlatItem[]>(() => {
    const q = activeToken.toLowerCase();
    if (!q) return [];
    const out: FlatItem[] = [];
    let clientCount = 0;
    for (const c of clients) {
      const category = c.category ?? "client";
      // Thread participants (merged first) always show — they're never capped
      // out by the 8-client budget and never spend it. Everything else stops
      // once the budget's exhausted.
      if (category !== "thread" && clientCount >= MAX_CLIENTS) break;
      const matches =
        c.name.toLowerCase().includes(q) ||
        (c.contactName?.toLowerCase().includes(q) ?? false) ||
        c.contactEmails.some((e) => e.toLowerCase().includes(q));
      if (!matches) continue;
      const remaining = c.contactEmails.filter((e) => !presentEmails.has(e.toLowerCase()));
      if (remaining.length === 0) continue;
      if (category !== "thread") clientCount++;
      let firstOfGroup = true;
      // "Add all" only earns its own row when there's more than one address
      // left — otherwise it would duplicate the single email row below it.
      if (remaining.length > 1) {
        out.push({
          index: out.length,
          clientId: c.id,
          clientName: c.name,
          contactName: c.contactName,
          category,
          groupStart: true,
          kind: "all",
          emails: remaining,
        });
        firstOfGroup = false;
      }
      for (const email of remaining) {
        out.push({
          index: out.length,
          clientId: c.id,
          clientName: c.name,
          contactName: c.contactName,
          category,
          groupStart: firstOfGroup,
          kind: "email",
          email,
        });
        firstOfGroup = false;
      }
    }
    return out;
  }, [clients, activeToken, presentEmails]);

  // Reset the highlight whenever the candidate list changes shape.
  useEffect(() => {
    setActive(0);
  }, [activeToken]);

  useEffect(() => () => {
    if (blurTimer.current) clearTimeout(blurTimer.current);
  }, []);

  const showDropdown = focused && !dismissed && items.length > 0;

  function insertEmails(emails: string[]) {
    const idx = lastBoundary(value);
    const prefix = idx >= 0 ? value.slice(0, idx + 1) + " " : "";
    const existing = new Set(
      prefix.split(/[,\n]/).map((s) => s.trim().toLowerCase()).filter(Boolean)
    );
    const fresh = emails.filter((e) => !existing.has(e.toLowerCase()));
    const merged = fresh.length ? fresh.join(", ") + ", " : "";
    onChange(prefix + merged);
  }

  function selectItem(it: FlatItem) {
    insertEmails(it.kind === "all" ? it.emails : [it.email]);
    setActive(0);
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (!showDropdown) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((a) => Math.min(a + 1, items.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => Math.max(a - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const it = items[active] ?? items[0];
      if (it) selectItem(it);
    } else if (e.key === "Escape") {
      // Swallow it so the surrounding Radix dialog doesn't also close.
      // (Once the dropdown is hidden, a later Escape falls through the
      // early return above and bubbles, closing the dialog as before.)
      e.preventDefault();
      e.stopPropagation();
      setDismissed(true);
    }
  }

  return (
    <div className="relative flex-1">
      <input
        autoFocus={autoFocus}
        type="text"
        value={value}
        onChange={(e) => { setDismissed(false); onChange(e.target.value); }}
        onFocus={() => {
          if (blurTimer.current) clearTimeout(blurTimer.current);
          setFocused(true);
          setDismissed(false);
        }}
        onBlur={() => {
          // Delay so an onMouseDown selection lands before we hide.
          blurTimer.current = setTimeout(() => setFocused(false), 120);
        }}
        onKeyDown={onKeyDown}
        placeholder={placeholder}
        autoComplete="off"
        className={inputClassName ?? "w-full bg-transparent text-sm outline-none placeholder:text-ink/40"}
      />
      {showDropdown && (
        <div className="absolute left-0 right-0 top-full mt-1 z-20 rounded-xl border border-slate-200 bg-white shadow-lift overflow-hidden max-h-72 overflow-y-auto">
          {items.map((it, i) => (
            <Fragment key={`${it.clientId}-${it.kind}-${it.kind === "email" ? it.email : "all"}`}>
              {it.category === "thread" && (i === 0 || items[i - 1].category !== "thread") && (
                <div className="px-3 pt-2 pb-1 text-[10px] uppercase tracking-wide font-semibold text-accent/70">
                  In this thread
                </div>
              )}
              {it.category === "team" && (i === 0 || items[i - 1].category !== "team") && (
                <div className="px-3 pt-2 pb-1 text-[10px] uppercase tracking-wide font-semibold text-accent/70 border-t border-slate-100">
                  Team inboxes &amp; members
                </div>
              )}
              {it.groupStart && (
                <div className="px-3 pt-2 pb-1 text-[10px] uppercase tracking-wide font-semibold text-ink/40 truncate">
                  {it.clientName}
                  {it.contactName ? ` · ${it.contactName}` : ""}
                </div>
              )}
              <button
                type="button"
                onMouseDown={(e) => {
                  e.preventDefault();
                  selectItem(it);
                }}
                onMouseEnter={() => setActive(it.index)}
                className={cn(
                  "w-full text-left px-3 py-1.5 flex items-center gap-2 transition-colors",
                  it.index === active ? "bg-blue-50" : "hover:bg-blue-50/60"
                )}
              >
                {it.kind === "all" ? (
                  <span className="text-[13px] font-medium text-accent">
                    Add all {it.emails.length} addresses
                  </span>
                ) : (
                  <span className="text-[13px] flex-1 truncate">{it.email}</span>
                )}
              </button>
            </Fragment>
          ))}
        </div>
      )}
    </div>
  );
}
