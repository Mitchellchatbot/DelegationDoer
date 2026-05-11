"use client";

import { useState } from "react";
import { Bot, Loader2 } from "lucide-react";
import { toast } from "sonner";
import type { MissiveAccount } from "@/lib/missive-client";

interface SettingRow {
  account_id: string;
  auto_intake_enabled: boolean;
  last_polled_at: string | null;
}

// CEO-facing per-inbox switch: when on, the email-intake cron polls this
// account every 5 min and turns inbound threads into routed tasks. Off
// by default (so connecting a new inbox is non-destructive).
export function AutoIntakeToggleSection({
  inboxes, initialSettings
}: {
  inboxes: MissiveAccount[];
  initialSettings: SettingRow[];
}) {
  const [byId, setById] = useState<Record<string, SettingRow>>(() => {
    const m: Record<string, SettingRow> = {};
    for (const s of initialSettings) m[s.account_id] = s;
    return m;
  });
  const [pending, setPending] = useState<Record<string, boolean>>({});

  async function toggle(accountId: string, next: boolean) {
    setPending((p) => ({ ...p, [accountId]: true }));
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
      setById((m) => ({
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
      setPending((p) => ({ ...p, [accountId]: false }));
    }
  }

  return (
    <section className="rounded-2xl border border-slate-200/70 bg-white shadow-soft p-5">
      <div className="flex items-center gap-2 mb-1">
        <span className="w-8 h-8 rounded-lg bg-blue-100 text-blue-600 grid place-items-center">
          <Bot className="w-4 h-4" />
        </span>
        <div>
          <div className="text-sm font-semibold">Auto-create tasks from new emails</div>
          <div className="text-xs text-muted">
            When on, every new inbound thread on this inbox becomes a task — auto-routed
            via responsibilities → skills → department head.
          </div>
        </div>
      </div>

      <div className="mt-3 divide-y divide-border/40">
        {inboxes.map((a) => {
          const setting = byId[a.id];
          const enabled = setting?.auto_intake_enabled ?? false;
          const isPending = pending[a.id];
          return (
            <div key={a.id} className="flex items-center justify-between py-2.5">
              <div className="min-w-0">
                <div className="text-sm font-medium truncate">{a.display_name || a.email}</div>
                {a.display_name && a.display_name !== a.email && (
                  <div className="text-[11px] text-muted truncate">{a.email}</div>
                )}
                {setting?.last_polled_at && (
                  <div className="text-[10px] text-muted/80 mt-0.5">
                    last polled {new Date(setting.last_polled_at).toLocaleString(undefined, {
                      month: "short", day: "numeric", hour: "numeric", minute: "2-digit"
                    })}
                  </div>
                )}
              </div>
              <button
                role="switch"
                aria-checked={enabled}
                disabled={isPending}
                onClick={() => toggle(a.id, !enabled)}
                className={
                  "relative inline-flex items-center h-6 w-11 rounded-full transition-colors shrink-0 " +
                  (enabled ? "bg-blue-500" : "bg-slate-300") +
                  (isPending ? " opacity-60 cursor-not-allowed" : " cursor-pointer")
                }
              >
                <span
                  className={
                    "inline-block w-5 h-5 rounded-full bg-white shadow transition-transform " +
                    (enabled ? "translate-x-5" : "translate-x-0.5")
                  }
                />
                {isPending && (
                  <Loader2 className="absolute inset-0 m-auto w-3 h-3 animate-spin text-white" />
                )}
              </button>
            </div>
          );
        })}
      </div>
    </section>
  );
}
