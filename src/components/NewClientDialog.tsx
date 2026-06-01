"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Plus, X } from "lucide-react";
import { toast } from "sonner";

// Inline dialog for creating a new client folder. Uses a controlled modal
// triggered by a + button on the list page. Submits to /api/clients.

// Loose email-format check, mirrored server-side in /api/clients.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function NewClientDialog() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [website, setWebsite] = useState("");
  const [onboardingDate, setOnboardingDate] = useState("");
  const [contactName, setContactName] = useState("");
  const [email, setEmail] = useState("");
  const [priority, setPriority] = useState<"low" | "medium" | "high">("medium");
  const [businessInformation, setBusinessInformation] = useState("");
  const [notes, setNotes] = useState("");
  const [submitting, setSubmitting] = useState(false);

  // Optional, but if filled it has to look like an email.
  const emailInvalid = email.trim().length > 0 && !EMAIL_RE.test(email.trim());

  function reset() {
    setName(""); setWebsite(""); setOnboardingDate(""); setContactName("");
    setEmail(""); setPriority("medium"); setBusinessInformation(""); setNotes("");
  }

  async function submit() {
    if (!name.trim() || emailInvalid) return;
    setSubmitting(true);
    try {
      const res = await fetch("/api/clients", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name, website, onboardingDate, contactName,
          email, priority, businessInformation, notes
        })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? "failed");
      toast.success("Client created");
      reset();
      setOpen(false);
      router.refresh();
    } catch (err) {
      toast.error(`Couldn't create client: ${err instanceof Error ? err.message : "unknown"}`);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-full text-sm font-medium text-white shadow-sm transition-all hover:-translate-y-0.5 hover:shadow-lift"
        style={{ background: "linear-gradient(135deg, #2563EB 0%, #1e63ff 100%)" }}
      >
        <Plus className="w-4 h-4" /> New client
      </button>

      {open && (
        <div className="fixed inset-0 z-50 flex items-start justify-center pt-20 px-4 lg:pl-[264px] bg-black/30 backdrop-blur-sm" onClick={() => setOpen(false)}>
          <div
            onClick={(e) => e.stopPropagation()}
            className="bg-white rounded-2xl shadow-lift border border-border w-full max-w-md max-h-[calc(100vh-6rem)] flex flex-col overflow-hidden animate-rise"
          >
            <header className="flex items-center justify-between px-5 pt-5 pb-3 shrink-0">
              <h2 className="text-base font-semibold">New client</h2>
              <button onClick={() => setOpen(false)} className="text-muted hover:text-ink">
                <X className="w-4 h-4" />
              </button>
            </header>

            {/* Only the fields scroll — header + footer stay pinned so the
                "Create client" button is always reachable no matter how
                many fields are filled in or how short the viewport is. */}
            <div className="flex-1 overflow-y-auto px-5 pb-1 space-y-4">
            <label className="block">
              <span className="text-xs text-muted">Name</span>
              <input
                autoFocus
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Acme Insurance"
                className="input mt-1"
              />
            </label>
            <label className="block">
              <span className="text-xs text-muted">Website (optional)</span>
              <input
                value={website}
                onChange={(e) => setWebsite(e.target.value)}
                placeholder="acme-insurance.com"
                className="input mt-1"
              />
            </label>
            <label className="block">
              <span className="text-xs text-muted">Onboarding date (optional)</span>
              <input
                type="date"
                value={onboardingDate}
                onChange={(e) => setOnboardingDate(e.target.value)}
                className="input mt-1"
              />
            </label>
            <label className="block">
              <span className="text-xs text-muted">Primary client contact name (optional)</span>
              <input
                value={contactName}
                onChange={(e) => setContactName(e.target.value)}
                placeholder="e.g. Jane Doe"
                className="input mt-1"
              />
            </label>
            <label className="block">
              <span className="text-xs text-muted">Client email address (optional)</span>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="jane@acme-insurance.com"
                className="input mt-1"
                aria-invalid={emailInvalid}
              />
              {emailInvalid && (
                <span className="text-[11px] text-red-600 mt-1 block">
                  Enter a valid email address.
                </span>
              )}
            </label>
            <label className="block">
              <span className="text-xs text-muted">Priority</span>
              <select
                value={priority}
                onChange={(e) => setPriority(e.target.value as "low" | "medium" | "high")}
                className="input mt-1"
              >
                <option value="low">Low</option>
                <option value="medium">Medium</option>
                <option value="high">High</option>
              </select>
            </label>
            <label className="block">
              <span className="text-xs text-muted">Business information (optional)</span>
              <textarea
                value={businessInformation}
                onChange={(e) => setBusinessInformation(e.target.value)}
                placeholder="Company overview, products/services offered, important background, special instructions — anything the team should know when working with this client."
                className="input mt-1 min-h-[120px]"
              />
            </label>
            <label className="block">
              <span className="text-xs text-muted">Notes (optional)</span>
              <textarea
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="Anything the team should know about this client."
                className="input mt-1 min-h-[80px]"
              />
            </label>
            </div>

            <div className="flex justify-end gap-2 px-5 py-4 border-t border-border shrink-0">
              <button onClick={() => setOpen(false)} className="btn">Cancel</button>
              <button
                onClick={submit}
                disabled={submitting || !name.trim() || emailInvalid}
                className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-xl text-sm font-medium text-white shadow-sm disabled:opacity-50"
                style={{ background: "linear-gradient(135deg, #2563EB 0%, #1e63ff 100%)" }}
              >
                {submitting ? "Creating…" : "Create client"}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
