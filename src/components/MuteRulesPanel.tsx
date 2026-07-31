"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { BellOff, X, Loader2, Plus, ShieldCheck } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  describeRule,
  matchTypeLabel,
  MUTE_MATCH_TYPES,
  type MuteMatchType,
  type MuteRule
} from "@/lib/inbox-mute-shared";

// The workspace mute list, shown at the top of the Muted view.
//
// This is the "why is my mail being filtered" surface. It leads with the rules
// rather than the filtered mail, because someone who opens Muted is usually
// either auditing the filter or trying to undo it — and a filter you can't
// inspect is one people stop trusting and route around.

interface Props {
  // Bumped by the parent when a rule is added elsewhere (the row bell), so the
  // list refetches without a callback chain.
  version: number;
  onChanged: () => void;
}

export function MuteRulesPanel({ version, onChanged }: Props) {
  const [rules, setRules] = useState<MuteRule[]>([]);
  const [canManage, setCanManage] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [draftType, setDraftType] = useState<MuteMatchType>("sender_exact");
  const [draftValue, setDraftValue] = useState("");
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/inboxes/mute-rules", { cache: "no-store" });
      const data = await res.json();
      setRules(data.rules ?? []);
      setCanManage(!!data.canManage);
    } catch {
      setRules([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load, version]);

  async function remove(rule: MuteRule) {
    setBusyId(rule.id);
    setRules((prev) => prev.filter((r) => r.id !== rule.id));
    try {
      const res = await fetch(`/api/inboxes/mute-rules?id=${encodeURIComponent(rule.id)}`, {
        method: "DELETE"
      });
      if (!res.ok) throw new Error();
      toast.success(`Unmuted ${describeRule(rule.matchType, rule.value)}`);
      onChanged();
    } catch {
      setRules((prev) => (prev.some((r) => r.id === rule.id) ? prev : [rule, ...prev]));
      toast.error("Couldn't remove that rule — try again.");
    } finally {
      setBusyId(null);
    }
  }

  async function add() {
    const value = draftValue.trim();
    if (!value || saving) return;
    setSaving(true);
    try {
      const res = await fetch("/api/inboxes/mute-rules", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ matchType: draftType, value })
      });
      if (res.status === 403) {
        toast.error("Only leaders and admins can change the mute list.");
        return;
      }
      if (!res.ok) throw new Error();
      setDraftValue("");
      setAdding(false);
      toast.success("Rule added");
      onChanged();
      void load();
    } catch {
      toast.error("Couldn't add that rule — try again.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="rounded-2xl border border-slate-200/70 bg-white shadow-soft p-3 space-y-2.5">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 min-w-0">
          <span className="w-7 h-7 rounded-lg bg-warn/10 text-warn grid place-items-center shrink-0">
            <BellOff className="w-3.5 h-3.5" />
          </span>
          <div className="min-w-0">
            <div className="text-[13px] font-semibold">Mute rules</div>
            <div className="text-[11px] text-ink/55">
              Workspace-wide. Matching mail skips the inbox and never pings.
            </div>
          </div>
        </div>
        {canManage && !adding && (
          <button
            type="button"
            onClick={() => setAdding(true)}
            className="inline-flex items-center gap-1 shrink-0 px-2.5 py-1 rounded-lg border border-slate-200 bg-white text-[12px] font-medium text-ink/65 hover:text-accent hover:border-accent/40 transition-colors"
          >
            <Plus className="w-3 h-3" /> Add rule
          </button>
        )}
      </div>

      {adding && (
        <div className="flex flex-wrap items-center gap-2 p-2 rounded-xl bg-slate-50 border border-slate-200">
          <select
            value={draftType}
            onChange={(e) => setDraftType(e.target.value as MuteMatchType)}
            className="rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-[12px] outline-none focus:border-accent/50"
          >
            {MUTE_MATCH_TYPES.map((t) => (
              <option key={t} value={t}>{matchTypeLabel(t)}</option>
            ))}
          </select>
          <input
            value={draftValue}
            onChange={(e) => setDraftValue(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") void add(); }}
            placeholder={
              draftType === "sender_exact" ? "noreply@elementor.com"
                : draftType === "sender_domain" ? "mailchimp.com"
                  : draftType === "sender_local" ? "wordpress"
                    : "plugin activated"
            }
            className="flex-1 min-w-[180px] rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-[12px] outline-none focus:border-accent/50 focus:ring-2 focus:ring-accent/20"
          />
          <button
            type="button"
            onClick={() => { void add(); }}
            disabled={!draftValue.trim() || saving}
            className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg bg-accent text-white text-[12px] font-medium disabled:opacity-40 enabled:hover:brightness-110"
          >
            {saving && <Loader2 className="w-3 h-3 animate-spin" />}
            Save
          </button>
          <button
            type="button"
            onClick={() => { setAdding(false); setDraftValue(""); }}
            className="px-2 py-1.5 rounded-lg text-[12px] text-ink/55 hover:text-ink"
          >
            Cancel
          </button>
        </div>
      )}

      {loading ? (
        <div className="flex items-center gap-1.5 text-[11px] text-ink/55 py-1">
          <Loader2 className="w-3 h-3 animate-spin" /> Loading rules…
        </div>
      ) : rules.length === 0 ? (
        <div className="flex items-center gap-2 text-[12px] text-ink/55 py-1">
          <ShieldCheck className="w-3.5 h-3.5 text-ok shrink-0" />
          Nothing is muted. Use the bell on any inbox row to quiet a noisy sender.
        </div>
      ) : (
        <div className="flex flex-wrap gap-1.5">
          {rules.map((r) => (
            <span
              key={r.id}
              className={cn(
                "inline-flex items-center gap-1.5 pl-2.5 pr-1 py-1 rounded-full border text-[11px]",
                "bg-slate-50 border-slate-200 text-ink/70",
                busyId === r.id && "opacity-50"
              )}
              title={r.note ?? matchTypeLabel(r.matchType)}
            >
              <span className="font-medium tabular-nums">
                {describeRule(r.matchType, r.value)}
              </span>
              {canManage && (
                <button
                  type="button"
                  onClick={() => { void remove(r); }}
                  disabled={busyId === r.id}
                  title="Unmute"
                  aria-label={`Unmute ${describeRule(r.matchType, r.value)}`}
                  className="w-4 h-4 grid place-items-center rounded-full text-ink/40 hover:text-urgent hover:bg-urgent/10 transition-colors"
                >
                  <X className="w-2.5 h-2.5" />
                </button>
              )}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
