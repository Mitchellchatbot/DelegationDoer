"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Bot, Check, ChevronDown, Loader2, Users, Inbox } from "lucide-react";
import { toast } from "sonner";
import type { MissiveAccount } from "@/lib/missive-client";
import { cn } from "@/lib/utils";

interface SettingRow {
  account_id: string;
  auto_intake_enabled: boolean;
  last_polled_at: string | null;
}

interface PersonOption {
  id: string;
  name: string;
  email: string;
  avatarUrl: string | null;
}

// Auto-delegation config card. Two dropdowns:
//   1. Which inboxes auto-create tasks from new inbound emails
//   2. Which teammates are eligible to receive those tasks
// Replaces the old per-row toggle list — much faster to glance at +
// scales when the team has more than ~5 inboxes.

export function AutoIntakeToggleSection({
  inboxes, initialSettings
}: {
  inboxes: MissiveAccount[];
  initialSettings: SettingRow[];
}) {
  const [settings, setSettings] = useState<Record<string, SettingRow>>(() => {
    const m: Record<string, SettingRow> = {};
    for (const s of initialSettings) m[s.account_id] = s;
    return m;
  });
  const [people, setPeople] = useState<PersonOption[]>([]);
  const [recipientIds, setRecipientIds] = useState<string[]>([]);
  const [savingInbox, setSavingInbox] = useState<Record<string, boolean>>({});
  const [savingRecipients, setSavingRecipients] = useState(false);

  useEffect(() => {
    let cancelled = false;
    // Load eligible-people roster + current recipient list in parallel.
    void Promise.all([
      fetch("/api/users", { cache: "no-store" }).then((r) => r.ok ? r.json() : null),
      fetch("/api/auto-delegate-recipients", { cache: "no-store" }).then((r) => r.ok ? r.json() : null)
    ]).then(([usersRes, recRes]) => {
      if (cancelled) return;
      if (usersRes?.users) {
        setPeople((usersRes.users as Array<{ id: string; name: string; email: string; avatarUrl: string | null; role: string }>)
          .filter((u) => u.role !== "leader") // leaders aren't typical recipients
          .map((u) => ({ id: u.id, name: u.name, email: u.email, avatarUrl: u.avatarUrl }))
          .sort((a, b) => a.name.localeCompare(b.name)));
      }
      if (recRes?.userIds) setRecipientIds(recRes.userIds);
    });
    return () => { cancelled = true; };
  }, []);

  async function toggleInbox(accountId: string, next: boolean) {
    setSavingInbox((p) => ({ ...p, [accountId]: true }));
    try {
      const res = await fetch("/api/missive-account-settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accountId, autoIntakeEnabled: next })
      });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error ?? "couldn't save");
        return;
      }
      setSettings((m) => ({
        ...m,
        [accountId]: {
          account_id: accountId,
          auto_intake_enabled: data.setting.auto_intake_enabled,
          last_polled_at: data.setting.last_polled_at ?? null
        }
      }));
      toast.success(next ? "Auto-intake on" : "Auto-intake off");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "request failed");
    } finally {
      setSavingInbox((p) => ({ ...p, [accountId]: false }));
    }
  }

  const saveRecipients = useCallback(async (nextIds: string[]) => {
    setSavingRecipients(true);
    try {
      const res = await fetch("/api/auto-delegate-recipients", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userIds: nextIds })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? `failed (${res.status})`);
      setRecipientIds(nextIds);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "couldn't save");
    } finally {
      setSavingRecipients(false);
    }
  }, []);

  function toggleRecipient(id: string) {
    const next = recipientIds.includes(id)
      ? recipientIds.filter((x) => x !== id)
      : [...recipientIds, id];
    void saveRecipients(next);
  }

  const enabledInboxCount = inboxes.filter((a) => settings[a.id]?.auto_intake_enabled).length;

  return (
    <section className="rounded-2xl border border-slate-200/70 bg-white shadow-soft overflow-hidden">
      <header className="px-5 py-4 border-b border-slate-100 flex items-center gap-3 bg-gradient-to-r from-blue-50/60 to-indigo-50/40">
        <span className="w-10 h-10 rounded-xl bg-blue-500 text-white grid place-items-center shadow-sm shrink-0">
          <Bot className="w-5 h-5" />
        </span>
        <div className="min-w-0">
          <div className="text-sm font-semibold text-ink">Auto-delegation</div>
          <div className="text-[12px] text-ink/60 mt-0.5">
            When an inbox in the list below receives a new email, it&apos;s turned into a task and routed to one of the eligible recipients.
          </div>
        </div>
      </header>

      <div className="p-5 grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* Inbox picker */}
        <MultiPickerDropdown
          icon={<Inbox className="w-4 h-4 text-blue-600" />}
          title="Inboxes that auto-create tasks"
          summary={
            enabledInboxCount === 0
              ? "None — auto-intake off everywhere"
              : `${enabledInboxCount} inbox${enabledInboxCount === 1 ? "" : "es"} on`
          }
          options={inboxes.map((a) => ({
            id: a.id,
            primary: a.display_name || a.email,
            secondary: a.display_name && a.display_name !== a.email ? a.email : null,
            selected: !!settings[a.id]?.auto_intake_enabled,
            pending: !!savingInbox[a.id],
            extra: settings[a.id]?.last_polled_at
              ? `last polled ${new Date(settings[a.id]!.last_polled_at!).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}`
              : null
          }))}
          onToggle={(id) => toggleInbox(id, !settings[id]?.auto_intake_enabled)}
          emptyState="No inboxes connected yet."
        />

        {/* Recipient picker */}
        <MultiPickerDropdown
          icon={<Users className="w-4 h-4 text-emerald-600" />}
          title="Eligible recipients"
          summary={
            recipientIds.length === 0
              ? "Default routing (skill / dept)"
              : `${recipientIds.length} teammate${recipientIds.length === 1 ? "" : "s"} eligible`
          }
          options={people.map((p) => ({
            id: p.id,
            primary: p.name,
            secondary: p.email,
            selected: recipientIds.includes(p.id),
            pending: savingRecipients,
            extra: null
          }))}
          onToggle={toggleRecipient}
          emptyState="No teammates loaded yet."
        />
      </div>
    </section>
  );
}

interface MultiOption {
  id: string;
  primary: string;
  secondary: string | null;
  selected: boolean;
  pending: boolean;
  extra: string | null;
}

function MultiPickerDropdown({
  icon, title, summary, options, onToggle, emptyState
}: {
  icon: React.ReactNode;
  title: string;
  summary: string;
  options: MultiOption[];
  onToggle: (id: string) => void;
  emptyState: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    function onClick(e: MouseEvent) {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    }
    if (open) document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [open]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return options;
    return options.filter((o) =>
      o.primary.toLowerCase().includes(q) ||
      (o.secondary ?? "").toLowerCase().includes(q)
    );
  }, [options, query]);

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center gap-3 px-4 py-3 rounded-xl border border-slate-200 bg-white hover:border-accent/40 hover:shadow-sm transition-all text-left"
      >
        <span className="w-8 h-8 rounded-lg bg-slate-50 border border-slate-200/70 grid place-items-center shrink-0">
          {icon}
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-semibold text-ink">{title}</div>
          <div className="text-[11px] text-ink/55 mt-0.5">{summary}</div>
        </div>
        <ChevronDown className={cn("w-4 h-4 text-ink/40 transition-transform shrink-0", open && "rotate-180")} />
      </button>

      {open && (
        <div className="absolute z-20 mt-2 w-full max-w-lg rounded-2xl border border-slate-200 bg-white shadow-[0_24px_48px_-16px_rgba(15,23,42,0.25)] overflow-hidden">
          <div className="px-3 py-2 border-b border-slate-100">
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search…"
              className="w-full text-[12px] bg-transparent border-none px-1 py-1 outline-none focus:ring-0 placeholder:text-ink/35"
            />
          </div>
          <ul className="max-h-80 overflow-y-auto py-1">
            {filtered.length === 0 ? (
              <li className="px-4 py-6 text-center text-[12px] text-ink/45 italic">
                {options.length === 0 ? emptyState : "No matches."}
              </li>
            ) : filtered.map((o) => (
              <li key={o.id}>
                <button
                  type="button"
                  onClick={() => onToggle(o.id)}
                  disabled={o.pending}
                  className={cn(
                    "w-full flex items-center gap-3 px-3 py-2 text-left text-[13px] transition-colors hover:bg-slate-50",
                    o.pending && "opacity-50 cursor-not-allowed"
                  )}
                >
                  <span
                    className={cn(
                      "w-4 h-4 rounded-md border-2 grid place-items-center shrink-0 transition-colors",
                      o.selected ? "border-accent bg-accent" : "border-slate-300 bg-white"
                    )}
                  >
                    {o.pending ? <Loader2 className="w-2.5 h-2.5 animate-spin text-white" /> :
                      o.selected ? <Check className="w-2.5 h-2.5 text-white" /> : null}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="font-medium text-ink truncate">{o.primary}</div>
                    {o.secondary && (
                      <div className="text-[11px] text-ink/55 truncate">{o.secondary}</div>
                    )}
                    {o.extra && (
                      <div className="text-[10px] text-ink/40 mt-0.5">{o.extra}</div>
                    )}
                  </div>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
