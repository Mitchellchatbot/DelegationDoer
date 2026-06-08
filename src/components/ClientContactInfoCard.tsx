"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  IdCard, Loader2, Pencil, Save, X, Mail, Globe2, CalendarClock, FileText, RefreshCw
} from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

// Client contact / onboarding info card.
//
// Lives on the client detail page. Always renders for everyone so a
// teammate can see who to email; only leaders / heads / admins see the
// edit affordance. Edit mode lets them rename the client, swap the
// website list, fix the primary contact, and update the onboarding
// brief — all in one go so a sales rep doesn't have to bounce between
// modals.

export type UpdateCadenceValue = "daily" | "biweekly" | "weekly" | "monthly" | "none";

const CADENCE_OPTIONS: Array<{ value: UpdateCadenceValue; label: string; hint: string }> = [
  { value: "daily",    label: "Daily",     hint: "fires on every EOD submit that touches this client" },
  { value: "biweekly", label: "Bi-weekly", hint: "Wednesdays + Fridays" },
  { value: "weekly",   label: "Weekly",    hint: "Fridays" },
  { value: "monthly",  label: "Monthly",   hint: "1st of the month" },
  { value: "none",     label: "Off",       hint: "no EOD digest emails queued" }
];

const CADENCE_LABEL: Record<UpdateCadenceValue, string> = Object.fromEntries(
  CADENCE_OPTIONS.map((o) => [o.value, o.label])
) as Record<UpdateCadenceValue, string>;

interface Props {
  clientId: string;
  name: string;
  website: string | null;
  websites: string[];
  contactName: string | null;
  contactEmails: string[];
  onboardingDate: string | null;
  businessInformation: string | null;
  updateCadence: UpdateCadenceValue;
  canEdit: boolean;
}

interface Draft {
  name: string;
  website: string;
  websites: string;        // newline-separated
  contactName: string;
  contactEmails: string;   // comma/newline-separated
  onboardingDate: string;  // YYYY-MM-DD
  businessInformation: string;
  updateCadence: UpdateCadenceValue;
}

function fromProps(p: Props): Draft {
  return {
    name: p.name,
    website: p.website ?? "",
    websites: p.websites.join("\n"),
    contactName: p.contactName ?? "",
    contactEmails: p.contactEmails.join(", "),
    onboardingDate: p.onboardingDate ?? "",
    businessInformation: p.businessInformation ?? "",
    updateCadence: p.updateCadence
  };
}

export function ClientContactInfoCard(props: Props) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState<Draft>(() => fromProps(props));

  function startEdit() {
    setDraft(fromProps(props));
    setEditing(true);
  }
  function cancel() {
    setDraft(fromProps(props));
    setEditing(false);
  }

  async function save() {
    if (busy) return;
    const name = draft.name.trim();
    if (!name) {
      toast.error("Name can't be empty.");
      return;
    }
    const websites = draft.websites
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean);
    const contactEmails = draft.contactEmails
      .split(/[\s,;]+/)
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
    // Light client-side validation — server enforces the same shape.
    for (const e of contactEmails) {
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) {
        toast.error(`Not a valid email: ${e}`);
        return;
      }
    }
    if (draft.onboardingDate && !/^\d{4}-\d{2}-\d{2}$/.test(draft.onboardingDate)) {
      toast.error("Onboarding date must be a valid date.");
      return;
    }

    setBusy(true);
    try {
      const res = await fetch(`/api/clients/${encodeURIComponent(props.clientId)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          website: draft.website.trim() || null,
          websites,
          contactName: draft.contactName.trim() || null,
          contactEmails,
          onboardingDate: draft.onboardingDate || null,
          businessInformation: draft.businessInformation.trim() || null,
          updateCadence: draft.updateCadence
        })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error ?? `failed (${res.status})`);
      toast.success("Client info updated.");
      setEditing(false);
      router.refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "save failed");
    } finally {
      setBusy(false);
    }
  }

  const hasAnyInfo =
    props.contactName ||
    props.contactEmails.length > 0 ||
    props.onboardingDate ||
    props.businessInformation;

  return (
    <section className="rounded-2xl border border-indigo-200/60 shadow-soft bg-gradient-to-br from-indigo-50/60 via-white to-white p-4 space-y-3">
      <header className="flex items-center gap-2">
        <IdCard className="w-4 h-4 text-indigo-600" />
        <div className="text-sm font-semibold">Contact & onboarding</div>
        <span className="text-[10px] text-ink/50 hidden sm:inline">
          — primary contact, website, business brief
        </span>
        {props.canEdit && !editing && (
          <button
            type="button"
            onClick={startEdit}
            className="ml-auto text-[10px] text-indigo-700/80 hover:text-indigo-800 inline-flex items-center gap-1 font-medium"
          >
            <Pencil className="w-3 h-3" /> {hasAnyInfo ? "Edit" : "Add"}
          </button>
        )}
      </header>

      {editing ? (
        <div className="space-y-3">
          <Field label="Client name">
            <input
              type="text"
              value={draft.name}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              disabled={busy}
              maxLength={200}
              className="block w-full rounded-xl border border-indigo-200 bg-white px-3 py-2 text-[13px] outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-200"
            />
          </Field>

          <Field label="Primary website">
            <input
              type="text"
              value={draft.website}
              placeholder="acme.com"
              onChange={(e) => setDraft({ ...draft, website: e.target.value })}
              disabled={busy}
              maxLength={500}
              className="block w-full rounded-xl border border-indigo-200 bg-white px-3 py-2 text-[13px] outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-200"
            />
          </Field>

          <Field
            label="Other websites"
            hint="One URL per line. Sites the client also runs (Villa, Pool group, etc.)."
          >
            <textarea
              value={draft.websites}
              placeholder={"villa-acme.com\npool-acme.com"}
              onChange={(e) => setDraft({ ...draft, websites: e.target.value })}
              disabled={busy}
              rows={3}
              className="block w-full rounded-xl border border-indigo-200 bg-white px-3 py-2 text-[13px] outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-200 leading-relaxed"
            />
          </Field>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Field label="Contact name">
              <input
                type="text"
                value={draft.contactName}
                placeholder="Jane Smith"
                onChange={(e) => setDraft({ ...draft, contactName: e.target.value })}
                disabled={busy}
                maxLength={200}
                className="block w-full rounded-xl border border-indigo-200 bg-white px-3 py-2 text-[13px] outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-200"
              />
            </Field>
            <Field label="Onboarding date">
              <input
                type="date"
                value={draft.onboardingDate}
                onChange={(e) => setDraft({ ...draft, onboardingDate: e.target.value })}
                disabled={busy}
                className="block w-full rounded-xl border border-indigo-200 bg-white px-3 py-2 text-[13px] outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-200"
              />
            </Field>
          </div>

          <Field
            label="Contact emails"
            hint="Comma or newline separated. The first one is treated as primary."
          >
            <input
              type="text"
              value={draft.contactEmails}
              placeholder="jane@acme.com, ops@acme.com"
              onChange={(e) => setDraft({ ...draft, contactEmails: e.target.value })}
              disabled={busy}
              className="block w-full rounded-xl border border-indigo-200 bg-white px-3 py-2 text-[13px] outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-200"
            />
          </Field>

          <Field label="Business information">
            <textarea
              value={draft.businessInformation}
              placeholder="Company overview, products/services, background, special instructions."
              onChange={(e) => setDraft({ ...draft, businessInformation: e.target.value })}
              disabled={busy}
              rows={5}
              maxLength={8000}
              className="block w-full rounded-xl border border-indigo-200 bg-white px-3 py-2 text-[13px] outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-200 leading-relaxed"
            />
          </Field>

          <Field
            label="EOD update cadence"
            hint="When the system queues an EOD-digest email to this client. Drafts land in /approvals for review."
          >
            <select
              value={draft.updateCadence}
              onChange={(e) => setDraft({ ...draft, updateCadence: e.target.value as UpdateCadenceValue })}
              disabled={busy}
              className="block w-full rounded-xl border border-indigo-200 bg-white px-3 py-2 text-[13px] outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-200"
            >
              {CADENCE_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>{o.label} — {o.hint}</option>
              ))}
            </select>
          </Field>

          <div className="flex items-center justify-end gap-2 pt-1">
            <button
              type="button"
              onClick={cancel}
              disabled={busy}
              className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-[11px] font-medium text-ink/65 hover:text-ink"
            >
              <X className="w-3 h-3" /> Cancel
            </button>
            <button
              type="button"
              onClick={save}
              disabled={busy}
              className={cn(
                "inline-flex items-center gap-1 px-3 py-1 rounded-full text-[11px] font-semibold text-white shadow-sm transition-all",
                busy && "opacity-60 cursor-not-allowed"
              )}
              style={{ background: "linear-gradient(135deg, #4f46e5 0%, #4338ca 100%)" }}
            >
              {busy ? <Loader2 className="w-3 h-3 animate-spin" /> : <Save className="w-3 h-3" />}
              Save changes
            </button>
          </div>
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <ReadCell icon={<Mail className="w-3 h-3" />} label="Contact">
            {props.contactName ? (
              <div>
                <div className="text-[13px] text-ink font-medium">{props.contactName}</div>
                {props.contactEmails.length > 0 && (
                  <div className="text-[11px] text-ink/65 mt-0.5 break-all">
                    {props.contactEmails.join(", ")}
                  </div>
                )}
              </div>
            ) : props.contactEmails.length > 0 ? (
              <div className="text-[13px] text-ink break-all">{props.contactEmails.join(", ")}</div>
            ) : (
              <EmptyHint canEdit={props.canEdit} onClick={startEdit}>No contact set</EmptyHint>
            )}
          </ReadCell>

          <ReadCell icon={<Globe2 className="w-3 h-3" />} label="Website">
            {props.website ? (
              <a
                href={props.website.startsWith("http") ? props.website : `https://${props.website}`}
                target="_blank"
                rel="noopener noreferrer"
                className="text-[13px] text-accent hover:underline break-all"
              >
                {props.website}
              </a>
            ) : (
              <EmptyHint canEdit={props.canEdit} onClick={startEdit}>No website set</EmptyHint>
            )}
          </ReadCell>

          <ReadCell icon={<CalendarClock className="w-3 h-3" />} label="Onboarded">
            {props.onboardingDate ? (
              <div className="text-[13px] text-ink tabular-nums">
                {new Date(props.onboardingDate).toLocaleDateString(undefined, {
                  year: "numeric", month: "short", day: "numeric"
                })}
              </div>
            ) : (
              <EmptyHint canEdit={props.canEdit} onClick={startEdit}>Not set</EmptyHint>
            )}
          </ReadCell>

          <ReadCell icon={<FileText className="w-3 h-3" />} label="Business info">
            {props.businessInformation ? (
              <div className="text-[12.5px] text-ink/80 leading-relaxed whitespace-pre-wrap line-clamp-4">
                {props.businessInformation}
              </div>
            ) : (
              <EmptyHint canEdit={props.canEdit} onClick={startEdit}>No info yet</EmptyHint>
            )}
          </ReadCell>

          <ReadCell icon={<RefreshCw className="w-3 h-3" />} label="EOD digest cadence">
            <div className="text-[13px] text-ink font-medium">
              {CADENCE_LABEL[props.updateCadence]}
            </div>
            <div className="text-[11px] text-ink/55 mt-0.5">
              {CADENCE_OPTIONS.find((o) => o.value === props.updateCadence)?.hint ?? ""}
            </div>
          </ReadCell>
        </div>
      )}
    </section>
  );
}

function Field({
  label, hint, children
}: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="block space-y-1">
      <span className="text-[10px] uppercase tracking-wide text-ink/55 font-semibold">
        {label}
      </span>
      {children}
      {hint && <span className="block text-[10px] text-ink/50">{hint}</span>}
    </label>
  );
}

function ReadCell({
  icon, label, children
}: { icon: React.ReactNode; label: string; children: React.ReactNode }) {
  return (
    <div className="rounded-xl bg-white/70 border border-white/70 p-3">
      <div className="text-[10px] uppercase tracking-wide text-ink/55 font-semibold inline-flex items-center gap-1 mb-1">
        {icon} {label}
      </div>
      {children}
    </div>
  );
}

function EmptyHint({
  canEdit, onClick, children
}: { canEdit: boolean; onClick: () => void; children: React.ReactNode }) {
  if (!canEdit) {
    return <span className="text-[12px] italic text-ink/45">{children}</span>;
  }
  return (
    <button
      type="button"
      onClick={onClick}
      className="text-[12px] italic text-indigo-700/70 hover:text-indigo-800 inline-flex items-center gap-1"
    >
      {children} <Pencil className="w-2.5 h-2.5" />
    </button>
  );
}
