"use client";

import * as Dialog from "@radix-ui/react-dialog";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { UserPlus, X, Loader2 } from "lucide-react";
import { toast } from "sonner";

// "Add lead" affordance on the outbound leads page. Opens a small modal to
// create a lead by hand (referrals, calls, events) instead of waiting on a
// Typeform submission. Submit hits POST /api/outbound/leads; on success we
// router.refresh() so the new row shows up in the funnel table.
//
// A lead needs at least one contact channel (phone and/or email). The SMS
// recovery sequence can only start when there's a phone, so the checkbox is
// disabled + forced off until a phone is entered.
//
// `forms` is the registered Typeform catalog (outbound_typeform_forms),
// passed from the leads page so the operator can attribute a manual lead to
// the same form a webhook submission would carry. Optional — leaving it unset
// stores no form (the lead lands under "Legacy / no form ID" grouping).

interface FormOption {
  id: string;
  label: string;
}

export function AddLeadButton({ forms }: { forms: FormOption[] }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [formId, setFormId] = useState("");
  const [startSequence, setStartSequence] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const hasPhone = phone.trim().length > 0;
  const canSubmit = (hasPhone || email.trim().length > 0) && !busy;

  function reset() {
    setName("");
    setPhone("");
    setEmail("");
    setFormId("");
    setStartSequence(false);
    setError(null);
  }

  async function submit() {
    setError(null);
    if (!hasPhone && !email.trim()) {
      setError("Enter a phone number or an email.");
      return;
    }
    setBusy(true);
    try {
      const res = await fetch("/api/outbound/leads", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim() || undefined,
          phone: phone.trim() || undefined,
          email: email.trim() || undefined,
          // The route validates this against the form catalog; unknown → null.
          typeformFormId: formId || undefined,
          // Only meaningful with a phone; the route ignores it otherwise.
          startSequence: hasPhone && startSequence
        })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(
          res.status === 409
            ? "A lead with that phone or email already exists."
            : (data?.error ?? `Failed (HTTP ${res.status})`)
        );
        setBusy(false);
        return;
      }
      toast.success("Lead added");
      setOpen(false);
      reset();
      startTransition(() => router.refresh());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog.Root open={open} onOpenChange={(o) => { setOpen(o); if (!o) reset(); }}>
      <Dialog.Trigger asChild>
        <button
          className="inline-flex items-center gap-2 px-3.5 py-2 rounded-xl text-[13.5px] font-medium border border-fuchsia-200/60 bg-fuchsia-50 text-fuchsia-700 hover:bg-fuchsia-100 transition-colors"
        >
          <UserPlus className="w-4 h-4" /> Add lead
        </button>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-ink/30 backdrop-blur-sm" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-[min(440px,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 rounded-2xl border border-slate-200 bg-white shadow-soft focus:outline-none">
          <div className="flex items-center justify-between px-5 py-3 border-b border-slate-100">
            <Dialog.Title className="text-[16px] font-semibold text-ink">Add a lead</Dialog.Title>
            <Dialog.Close asChild>
              <button className="text-ink/45 hover:text-ink/80 transition-colors" aria-label="Close">
                <X className="w-4.5 h-4.5" />
              </button>
            </Dialog.Close>
          </div>

          <div className="p-5 space-y-3.5">
            <label className="block">
              <span className="text-[12px] font-medium text-ink/65">Name</span>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Jane Doe"
                className="mt-1 w-full rounded-xl border border-slate-200 px-3 py-2 text-[14px] text-ink placeholder:text-ink/35 focus:border-fuchsia-300 focus:outline-none"
              />
            </label>

            <label className="block">
              <span className="text-[12px] font-medium text-ink/65">Phone</span>
              <input
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                placeholder="+1 512 555 0100"
                inputMode="tel"
                className="mt-1 w-full rounded-xl border border-slate-200 px-3 py-2 text-[14px] text-ink placeholder:text-ink/35 focus:border-fuchsia-300 focus:outline-none"
              />
            </label>

            <label className="block">
              <span className="text-[12px] font-medium text-ink/65">Email</span>
              <input
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="jane@example.com"
                inputMode="email"
                className="mt-1 w-full rounded-xl border border-slate-200 px-3 py-2 text-[14px] text-ink placeholder:text-ink/35 focus:border-fuchsia-300 focus:outline-none"
              />
            </label>

            {forms.length > 0 && (
              <label className="block">
                <span className="text-[12px] font-medium text-ink/65">Typeform</span>
                <select
                  value={formId}
                  onChange={(e) => setFormId(e.target.value)}
                  className="mt-1 w-full rounded-xl border border-slate-200 px-3 py-2 text-[14px] text-ink focus:border-fuchsia-300 focus:outline-none"
                >
                  <option value="">No specific form</option>
                  {forms.map((f) => (
                    <option key={f.id} value={f.id}>{f.label}</option>
                  ))}
                </select>
              </label>
            )}

            <label className={`flex items-start gap-2.5 rounded-xl border px-3 py-2.5 ${hasPhone ? "border-slate-200" : "border-slate-100 bg-slate-50/60"}`}>
              <input
                type="checkbox"
                checked={hasPhone && startSequence}
                disabled={!hasPhone}
                onChange={(e) => setStartSequence(e.target.checked)}
                className="mt-0.5 accent-fuchsia-600 disabled:opacity-40"
              />
              <span className="text-[13px] leading-snug">
                <span className="font-medium text-ink">Start SMS sequence</span>
                <span className="block text-ink/55">
                  {hasPhone
                    ? "Queues the 5-message recovery drip immediately."
                    : "Needs a phone number."}
                </span>
              </span>
            </label>

            {error && (
              <div className="rounded-xl border border-rose-200/60 bg-rose-50/60 px-3 py-2 text-[12.5px] text-rose-900">
                {error}
              </div>
            )}
          </div>

          <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-slate-100">
            <Dialog.Close asChild>
              <button className="px-3.5 py-2 rounded-xl text-[13.5px] font-medium text-ink/65 hover:bg-slate-100 transition-colors">
                Cancel
              </button>
            </Dialog.Close>
            <button
              onClick={() => void submit()}
              disabled={!canSubmit}
              className="inline-flex items-center gap-2 px-3.5 py-2 rounded-xl text-[13.5px] font-medium border border-fuchsia-200/60 bg-fuchsia-600 text-white hover:bg-fuchsia-700 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {(busy || pending) && <Loader2 className="w-4 h-4 animate-spin" />}
              Add lead
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
