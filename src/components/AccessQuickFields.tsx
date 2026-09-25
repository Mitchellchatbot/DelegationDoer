"use client";

import { useState } from "react";
import { Check } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import {
  ZAPIER_MODE_KEY, CRM_MODE_KEY, CALENDLY_MODE_KEY, EIN_KEY, AD_ACCOUNT_ID_KEY, MONTHLY_SPEND_KEY,
  LANDING_PAGE_KEY, TYPEFORM_LINK_KEY, ACCOUNT_METRICS_KEY,
  TRUST_SUBMITTED_KEY, TRUST_ACCEPTED_KEY, CTM_GRANTED_KEY,
  type OnboardingState, type EntryValue
} from "@/lib/fb-onboarding";

const str = (s: OnboardingState, k: string) => (typeof s[k]?.v === "string" ? (s[k].v as string) : "");
const isOn = (s: OnboardingState, k: string) => s[k]?.v === true;

// The at-a-glance block every list card wants right under Go-live: Zapier
// and Calendly access mode, EIN, the ad account itself, and Meta's Trust
// Center steps. Reads and writes the exact same keys the Access tab does —
// PATCHes /api/tasks/[id]/fb-onboarding directly, same as the tab, so there
// is no separate copy of this state to keep in sync.
export function AccessQuickFields({
  taskId, state, canEdit
}: {
  taskId: string;
  state: OnboardingState;
  canEdit: boolean;
}) {
  const [s, setS] = useState(state);

  async function set(key: string, value: EntryValue) {
    if (!canEdit) return;
    const prev = s[key];
    setS((cur) => ({ ...cur, [key]: { v: value, by: null, at: new Date().toISOString() } }));
    try {
      const res = await fetch(`/api/tasks/${taskId}/fb-onboarding`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key, value })
      });
      if (!res.ok) {
        const d = await res.json().catch(() => null);
        throw new Error(d?.error ?? `failed (${res.status})`);
      }
    } catch (e) {
      setS((cur) => {
        const next = { ...cur };
        if (prev) next[key] = prev; else delete next[key];
        return next;
      });
      toast.error(`Couldn't save: ${e instanceof Error ? e.message : "network error"}`);
    }
  }

  return (
    <div>
      <div className="text-[10px] font-medium uppercase tracking-wide text-muted mb-1.5">Meta account &amp; access</div>
      <div className="grid grid-cols-2 gap-1.5">
        <ModePill
          label="Zapier" value={str(s, ZAPIER_MODE_KEY)} canEdit={canEdit}
          grantedValue="client_workspace" ourAccountValue="our_account"
          onToggle={(v) => set(ZAPIER_MODE_KEY, v)}
        />
        <ModePill
          label="CRM" value={str(s, CRM_MODE_KEY)} canEdit={canEdit}
          grantedValue="granted" ourAccountValue="our_account"
          onToggle={(v) => set(CRM_MODE_KEY, v)}
        />
        <ModePill
          label="Calendly" value={str(s, CALENDLY_MODE_KEY)} canEdit={canEdit}
          grantedValue="client_invites_us" ourAccountValue="we_invite_client"
          onToggle={(v) => set(CALENDLY_MODE_KEY, v)}
        />
        <QuickInput label="EIN" value={str(s, EIN_KEY)} canEdit={canEdit} placeholder="XX-XXXXXXX" onSave={(v) => set(EIN_KEY, v)} />
        <QuickInput label="Ad account ID" value={str(s, AD_ACCOUNT_ID_KEY)} canEdit={canEdit} placeholder="act_…" onSave={(v) => set(AD_ACCOUNT_ID_KEY, v)} />
        <QuickInput label="Monthly spend" value={str(s, MONTHLY_SPEND_KEY)} canEdit={canEdit} placeholder="$…/mo" onSave={(v) => set(MONTHLY_SPEND_KEY, v)} />
        <QuickInput label="Landing page link" value={str(s, LANDING_PAGE_KEY)} canEdit={canEdit} placeholder="https://…" onSave={(v) => set(LANDING_PAGE_KEY, v)} />
        <QuickInput label="Typeform link" value={str(s, TYPEFORM_LINK_KEY)} canEdit={canEdit} placeholder="https://…" onSave={(v) => set(TYPEFORM_LINK_KEY, v)} />
        <QuickInput label="Account metrics link" value={str(s, ACCOUNT_METRICS_KEY)} canEdit={canEdit} placeholder="https://…" onSave={(v) => set(ACCOUNT_METRICS_KEY, v)} />
        <QuickCheck label="CTM access granted" on={isOn(s, CTM_GRANTED_KEY)} canEdit={canEdit} onToggle={() => set(CTM_GRANTED_KEY, !isOn(s, CTM_GRANTED_KEY))} />
        <QuickCheck label="Trust Center submitted" on={isOn(s, TRUST_SUBMITTED_KEY)} canEdit={canEdit} onToggle={() => set(TRUST_SUBMITTED_KEY, !isOn(s, TRUST_SUBMITTED_KEY))} />
        <QuickCheck label="Trust Center accepted" on={isOn(s, TRUST_ACCEPTED_KEY)} canEdit={canEdit} onToggle={() => set(TRUST_ACCEPTED_KEY, !isOn(s, TRUST_ACCEPTED_KEY))} />
      </div>
    </div>
  );
}

// Collapses the 2-3 option "how do we access this" choice into one click:
// granted (the client gave it to us, whichever specific way) vs. we're using
// our own account. The full 3-way choice (Zapier only) still lives on the
// Access tab — this is a quick toggle, not a replacement for it.
function ModePill({
  label, value, canEdit, grantedValue, ourAccountValue, onToggle
}: {
  label: string;
  value: string;
  canEdit: boolean;
  grantedValue: string;
  ourAccountValue: string;
  onToggle: (next: string) => void;
}) {
  const isOurAccount = value === ourAccountValue;
  const isGranted = value !== "" && !isOurAccount;
  const text = isOurAccount ? "Using our account" : isGranted ? "Access granted" : "Not set";
  return (
    <button
      type="button"
      disabled={!canEdit}
      onClick={(e) => { e.preventDefault(); e.stopPropagation(); onToggle(isOurAccount ? grantedValue : ourAccountValue); }}
      className={cn(
        "flex flex-col items-start gap-0.5 rounded-lg border px-2 py-1.5 text-left transition-colors",
        isGranted ? "border-ok/30 bg-ok/10" : isOurAccount ? "border-accent/25 bg-accent/5" : "border-border bg-surface2",
        canEdit && "hover:brightness-95 cursor-pointer"
      )}
    >
      <span className="text-[10px] uppercase tracking-wide text-muted">{label}</span>
      <span className={cn("text-xs font-medium", isGranted ? "text-ok" : isOurAccount ? "text-accent" : "text-muted")}>{text}</span>
    </button>
  );
}

function QuickInput({
  label, value, canEdit, placeholder, onSave
}: {
  label: string;
  value: string;
  canEdit: boolean;
  placeholder?: string;
  onSave: (next: string) => void;
}) {
  // Re-keyed on the stored value so a save from elsewhere (or the optimistic
  // rollback above) replaces a stale draft, same trick FbOnboardingPanel uses.
  return <QuickInputInner key={value} stored={value} label={label} canEdit={canEdit} placeholder={placeholder} onSave={onSave} />;
}

function QuickInputInner({
  stored, label, canEdit, placeholder, onSave
}: {
  stored: string;
  label: string;
  canEdit: boolean;
  placeholder?: string;
  onSave: (next: string) => void;
}) {
  const [draft, setDraft] = useState(stored);
  const commit = () => { if (draft.trim() !== stored) onSave(draft.trim()); };
  return (
    <div className="rounded-lg border border-border bg-surface2 px-2 py-1.5">
      <div className="text-[10px] uppercase tracking-wide text-muted mb-0.5">{label}</div>
      <input
        className="w-full bg-transparent text-xs font-medium text-ink placeholder:text-muted/60 placeholder:font-normal focus:outline-none"
        value={draft}
        placeholder={placeholder}
        disabled={!canEdit}
        onClick={(e) => e.stopPropagation()}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
      />
    </div>
  );
}

function QuickCheck({ label, on, canEdit, onToggle }: { label: string; on: boolean; canEdit: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      disabled={!canEdit}
      onClick={(e) => { e.preventDefault(); e.stopPropagation(); onToggle(); }}
      className={cn(
        "flex items-center gap-1.5 rounded-lg border px-2 py-1.5 text-left transition-colors",
        on ? "border-ok/30 bg-ok/10 text-ok" : "border-border bg-surface2 text-muted",
        canEdit && "hover:brightness-95 cursor-pointer"
      )}
    >
      <span className={cn("w-3.5 h-3.5 shrink-0 rounded-[4px] border grid place-items-center", on ? "bg-ok border-ok" : "bg-surface border-slate-300")}>
        {on && <Check className="w-2.5 h-2.5 text-white" strokeWidth={3} />}
      </span>
      <span className="text-xs font-medium truncate">{label}</span>
    </button>
  );
}
