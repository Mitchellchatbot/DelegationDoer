"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { createPortal } from "react-dom";
import {
  X, Plus, Trash2, Edit3, Save, Loader2, Settings, AlertCircle,
  Eye, EyeOff, Copy, Check
} from "lucide-react";
import type { OutboundTypeformForm } from "@/lib/outbound-typeform-forms";
import { cn } from "@/lib/utils";

// Right-side slide-over drawer for managing the outbound_typeform_forms
// catalog from inside the leads page. Triggered by the "Manage forms"
// gear button rendered next to the page hero.
//
// All mutations go through /api/outbound/typeform-forms and run
// router.refresh() on success so the per-form blocks underneath repaint
// with the new labels without a hard reload.

interface Props {
  initialForms: OutboundTypeformForm[];
  // Form IDs that have shown up in webhooks but aren't registered yet
  // — surfaced at the top of the drawer with a one-click "Register"
  // affordance so the operator never has to copy-paste a UUID.
  unknownFormIds: string[];
}

export function OutboundTypeformFormsDrawer({ initialForms, unknownFormIds }: Props) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[12.5px] font-medium border border-slate-200 bg-white text-ink/75 hover:border-accent/40 hover:text-accent transition-colors"
        title="Manage Typeform sources"
      >
        <Settings className="w-3.5 h-3.5" />
        Manage forms
        {unknownFormIds.length > 0 && (
          <span className="inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded-full bg-amber-100 text-amber-700 text-[10px] font-semibold">
            {unknownFormIds.length}
          </span>
        )}
      </button>
      {open && (
        <DrawerPanel
          initialForms={initialForms}
          unknownFormIds={unknownFormIds}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}

function DrawerPanel({
  initialForms, unknownFormIds, onClose
}: {
  initialForms: OutboundTypeformForm[];
  unknownFormIds: string[];
  onClose: () => void;
}) {
  const router = useRouter();
  const [mounted, setMounted] = useState(false);
  const [forms, setForms] = useState(initialForms);
  const [, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => setMounted(true), []);

  // Close on Escape; trap focus within the panel for screen readers.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  async function refresh() {
    try {
      const res = await fetch("/api/outbound/typeform-forms", { cache: "no-store" });
      const data = await res.json();
      if (res.ok) setForms(data.forms ?? []);
    } catch {
      /* network error swallowed — list stays stale until the user retries */
    }
    startTransition(() => router.refresh());
  }

  async function save(input: { id: string; label: string; description?: string | null; enrollInFlow?: boolean }) {
    setError(null);
    const res = await fetch("/api/outbound/typeform-forms", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input)
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(data?.error || `save failed (${res.status})`);
    }
    await refresh();
  }

  async function remove(id: string) {
    setError(null);
    const res = await fetch(`/api/outbound/typeform-forms/${encodeURIComponent(id)}`, {
      method: "DELETE"
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(data?.error || `delete failed (${res.status})`);
    }
    await refresh();
  }

  if (!mounted) return null;

  return createPortal(
    <div className="fixed inset-0 z-50 flex">
      <div
        className="flex-1 bg-slate-900/30 backdrop-blur-[2px]"
        onClick={onClose}
      />
      <aside
        className="w-full sm:w-[440px] bg-white shadow-2xl border-l border-slate-200 flex flex-col"
        role="dialog"
        aria-label="Manage Typeform sources"
      >
        <header className="px-5 py-4 border-b border-slate-100 flex items-center justify-between">
          <div>
            <div className="text-[11px] uppercase tracking-[0.16em] font-semibold text-ink/55">
              Catalog
            </div>
            <h2 className="text-[18px] font-semibold text-ink mt-0.5">
              Typeform sources
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 rounded-lg text-ink/55 hover:bg-slate-100 hover:text-ink"
            aria-label="Close"
          >
            <X className="w-4 h-4" />
          </button>
        </header>

        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-5">
          {error && (
            <div className="text-[12px] text-rose-700 bg-rose-50 border border-rose-200/70 rounded-lg px-3 py-2 inline-flex items-start gap-2">
              <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
              <span>{error}</span>
            </div>
          )}

          {unknownFormIds.length > 0 && (
            <section>
              <div className="text-[11px] uppercase tracking-wide font-semibold text-ink/55 mb-2">
                Unregistered forms ({unknownFormIds.length})
              </div>
              <div className="rounded-xl border border-amber-200/70 bg-amber-50/40 p-3 space-y-2 text-[12.5px]">
                <div className="text-ink/75">
                  These form IDs have submitted leads but don't have a name yet.
                  Click <span className="font-medium text-ink">Register</span> to add them to the catalog.
                </div>
                {unknownFormIds.map((id) => (
                  <UnknownFormRow
                    key={id}
                    formId={id}
                    onRegister={(label) =>
                      save({ id, label }).catch((e) =>
                        setError(e instanceof Error ? e.message : "save failed")
                      )
                    }
                  />
                ))}
              </div>
            </section>
          )}

          <section>
            <div className="text-[11px] uppercase tracking-wide font-semibold text-ink/55 mb-2">
              Registered forms ({forms.length})
            </div>
            {forms.length === 0 ? (
              <div className="text-[13px] text-ink/55 rounded-xl border border-dashed border-slate-300 px-3 py-4 text-center">
                Nothing here yet — register a form using the panel below.
              </div>
            ) : (
              <ul className="space-y-2">
                {forms.map((f) => (
                  <FormRow
                    key={f.id}
                    form={f}
                    onSave={(label, description, enrollInFlow) =>
                      save({ id: f.id, label, description, enrollInFlow }).catch((e) =>
                        setError(e instanceof Error ? e.message : "save failed")
                      )
                    }
                    onDelete={() =>
                      remove(f.id).catch((e) =>
                        setError(e instanceof Error ? e.message : "delete failed")
                      )
                    }
                  />
                ))}
              </ul>
            )}
          </section>

          <section className="border-t border-slate-100 pt-4">
            <div className="text-[11px] uppercase tracking-wide font-semibold text-ink/55 mb-2">
              Register a new form
            </div>
            <WebhookUrlNote />
            <div className="mb-3" />

            <NewFormForm
              onSave={(input) =>
                save(input).catch((e) =>
                  setError(e instanceof Error ? e.message : "save failed")
                )
              }
            />
          </section>
        </div>
      </aside>
    </div>,
    document.body
  );
}

function UnknownFormRow({
  formId, onRegister
}: {
  formId: string;
  onRegister: (label: string) => Promise<void>;
}) {
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState(false);
  async function go() {
    if (!label.trim()) return;
    setBusy(true);
    try { await onRegister(label.trim()); }
    finally { setBusy(false); }
  }
  return (
    <div className="flex items-center gap-2 bg-white border border-amber-200/60 rounded-lg px-2.5 py-2">
      <div className="font-mono text-[11px] text-ink/55 shrink-0 truncate max-w-[120px]" title={formId}>
        {formId}
      </div>
      <input
        type="text"
        placeholder="Name this form…"
        value={label}
        onChange={(e) => setLabel(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter") void go(); }}
        className="flex-1 text-[12.5px] border border-slate-200 rounded-md px-2 py-1 focus:outline-none focus:ring-2 focus:ring-accent/30"
      />
      <button
        type="button"
        onClick={() => void go()}
        disabled={!label.trim() || busy}
        className={cn(
          "inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-[12px] font-semibold transition-colors",
          label.trim() && !busy
            ? "bg-accent text-white hover:bg-accent/90"
            : "bg-slate-100 text-ink/45 cursor-not-allowed"
        )}
      >
        {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Plus className="w-3.5 h-3.5" />}
        Register
      </button>
    </div>
  );
}

function FormRow({
  form, onSave, onDelete
}: {
  form: OutboundTypeformForm;
  onSave: (label: string, description: string | null, enrollInFlow: boolean) => Promise<void>;
  onDelete: () => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [label, setLabel] = useState(form.label);
  const [description, setDescription] = useState(form.description ?? "");
  const [enrollInFlow, setEnrollInFlow] = useState(form.enrollInFlow);
  const [busy, setBusy] = useState<"save" | "delete" | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  async function save() {
    if (!label.trim()) return;
    setBusy("save");
    try {
      await onSave(label.trim(), description.trim() || null, enrollInFlow);
      setEditing(false);
    } finally { setBusy(null); }
  }

  async function del() {
    setBusy("delete");
    try { await onDelete(); }
    finally { setBusy(null); setConfirmDelete(false); }
  }

  if (editing) {
    return (
      <li className="rounded-xl border border-accent/40 bg-accent/5 p-3 space-y-2">
        <input
          type="text"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          className="w-full text-[13px] font-medium border border-slate-200 rounded-md px-2.5 py-1.5 focus:outline-none focus:ring-2 focus:ring-accent/30"
          autoFocus
        />
        <input
          type="text"
          value={description}
          placeholder="(optional) short description"
          onChange={(e) => setDescription(e.target.value)}
          className="w-full text-[12.5px] border border-slate-200 rounded-md px-2.5 py-1.5 focus:outline-none focus:ring-2 focus:ring-accent/30"
        />
        <label className="flex items-start gap-2.5 rounded-md border border-slate-200 bg-white px-2.5 py-2 cursor-pointer select-none">
          <input
            type="checkbox"
            checked={enrollInFlow}
            onChange={(e) => setEnrollInFlow(e.target.checked)}
            className="mt-0.5 h-3.5 w-3.5 rounded border-slate-300 text-accent focus:ring-accent/30"
          />
          <span className="min-w-0">
            <span className="block text-[12.5px] font-medium text-ink">Add to flow</span>
            <span className="block text-[11px] text-ink/55 mt-0.5">
              Auto-enroll new submissions in the Recovery drip SMS sequence. Off = leads still created, no texts.
            </span>
          </span>
        </label>
        <div className="font-mono text-[10.5px] text-ink/45">ID: {form.id}</div>
        <div className="flex items-center justify-end gap-2 pt-1">
          <button
            type="button"
            onClick={() => { setEditing(false); setLabel(form.label); setDescription(form.description ?? ""); setEnrollInFlow(form.enrollInFlow); }}
            className="text-[12px] text-ink/55 hover:text-ink"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void save()}
            disabled={!label.trim() || busy === "save"}
            className={cn(
              "inline-flex items-center gap-1 px-3 py-1.5 rounded-md text-[12px] font-semibold transition-colors",
              label.trim() && busy !== "save"
                ? "bg-accent text-white hover:bg-accent/90"
                : "bg-slate-100 text-ink/45 cursor-not-allowed"
            )}
          >
            {busy === "save" ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
            Save
          </button>
        </div>
      </li>
    );
  }

  return (
    <li className="rounded-xl border border-slate-200 bg-white px-3 py-2.5 flex items-start justify-between gap-3 group">
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-[13px] font-medium text-ink truncate">{form.label}</span>
          <span
            className={cn(
              "shrink-0 inline-flex items-center px-1.5 py-0.5 rounded-full text-[10px] font-semibold uppercase tracking-wide",
              form.enrollInFlow
                ? "bg-emerald-100 text-emerald-700"
                : "bg-slate-100 text-ink/55"
            )}
            title={
              form.enrollInFlow
                ? "Submissions auto-enroll in the Recovery drip"
                : "Submissions create leads but skip the SMS sequence"
            }
          >
            {form.enrollInFlow ? "In flow" : "No flow"}
          </span>
        </div>
        {form.description && (
          <div className="text-[12px] text-ink/65 mt-0.5">{form.description}</div>
        )}
        <div className="font-mono text-[10.5px] text-ink/40 mt-1 truncate" title={form.id}>
          {form.id}
        </div>
      </div>
      <div className="flex items-center gap-1 shrink-0">
        <button
          type="button"
          onClick={() => setEditing(true)}
          className="p-1.5 rounded-md text-ink/55 hover:bg-slate-100 hover:text-ink"
          aria-label="Edit"
          title="Edit"
        >
          <Edit3 className="w-3.5 h-3.5" />
        </button>
        {confirmDelete ? (
          <button
            type="button"
            onClick={() => void del()}
            disabled={busy === "delete"}
            className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-[11px] font-semibold bg-rose-600 text-white hover:bg-rose-700"
          >
            {busy === "delete" ? <Loader2 className="w-3 h-3 animate-spin" /> : <Trash2 className="w-3 h-3" />}
            Confirm
          </button>
        ) : (
          <button
            type="button"
            onClick={() => setConfirmDelete(true)}
            className="p-1.5 rounded-md text-ink/55 hover:bg-rose-50 hover:text-rose-700"
            aria-label="Delete"
            title="Delete"
          >
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        )}
      </div>
    </li>
  );
}

// Webhook URL Typeform should post to. Held as a const so the
// reveal-on-click affordance below can render it without any plumbing.
const WEBHOOK_URL = "https://delegationdoer-production.up.railway.app/api/integrations/typeform/webhook";

// Sky-blue info card explaining the one-time Typeform-side setup. The
// URL is kept hidden behind a "View URL" toggle so the drawer doesn't
// shoulder-surf-leak it; a copy button is inline so the operator
// doesn't have to select + Cmd-C manually.
function WebhookUrlNote() {
  const [visible, setVisible] = useState(false);
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(WEBHOOK_URL);
      setCopied(true);
      // Reset the "Copied!" affordance after a beat so a second click
      // can show feedback again.
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked in some browsers / iframes — user can still
         click View URL and copy manually. */
    }
  }

  return (
    <div className="rounded-lg border border-sky-200/70 bg-sky-50/60 px-3 py-2 text-[12px] text-ink/75 leading-relaxed">
      <div className="font-semibold text-sky-900 mb-1">Before you register</div>
      In Typeform, open the form → <span className="font-medium">Connect → Webhooks → Add a webhook</span> and paste the URL below (use the same secret as the other forms).
      <div className="mt-2 flex items-center gap-2">
        <button
          type="button"
          onClick={() => setVisible((v) => !v)}
          className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[11.5px] font-semibold bg-white border border-sky-200/70 text-sky-900 hover:bg-sky-100 transition-colors"
        >
          {visible
            ? <><EyeOff className="w-3.5 h-3.5" /> Hide URL</>
            : <><Eye className="w-3.5 h-3.5" /> View URL</>}
        </button>
        {visible && (
          <button
            type="button"
            onClick={() => void copy()}
            className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[11.5px] font-semibold bg-white border border-slate-200 text-ink/75 hover:border-accent/40 hover:text-accent transition-colors"
          >
            {copied
              ? <><Check className="w-3.5 h-3.5 text-emerald-600" /> Copied</>
              : <><Copy className="w-3.5 h-3.5" /> Copy</>}
          </button>
        )}
      </div>
      {visible && (
        <code className="block mt-2 px-2 py-1.5 rounded bg-white border border-sky-200/60 font-mono text-[11px] text-ink break-all select-all">
          {WEBHOOK_URL}
        </code>
      )}
    </div>
  );
}

// Pulls the form ID out of any Typeform URL shape we've seen in the
// wild — public form links (/to/<id>), admin URLs (/form/<id>), with
// optional query strings, trailing slashes, custom subdomains. If the
// input doesn't look like a URL we fall back to treating it as a raw
// ID (alphanumeric only) so power users can still paste an ID directly.
function parseTypeformId(input: string): string | null {
  const raw = input.trim();
  if (!raw) return null;
  // URL paths Typeform uses: /to/<id>, /form/<id>, /forms/<id>
  const urlMatch = raw.match(/\/(?:to|form|forms)\/([A-Za-z0-9]+)/i);
  if (urlMatch) return urlMatch[1];
  // Bare ID — only accept alphanumeric so we don't store half a URL by
  // accident when the user mis-pastes.
  if (/^[A-Za-z0-9]+$/.test(raw)) return raw;
  return null;
}

function NewFormForm({
  onSave
}: {
  onSave: (input: { id: string; label: string; description: string | null; enrollInFlow: boolean }) => Promise<void>;
}) {
  const linkRef = useRef<HTMLInputElement>(null);
  const [link, setLink] = useState("");
  const [label, setLabel] = useState("");
  const [description, setDescription] = useState("");
  const [enrollInFlow, setEnrollInFlow] = useState(true);
  const [busy, setBusy] = useState(false);

  const parsedId = parseTypeformId(link);
  const linkLooksWrong = link.trim().length > 0 && parsedId === null;
  const canSubmit = !!parsedId && label.trim().length > 0 && !busy;

  async function go() {
    if (!parsedId || !label.trim()) return;
    setBusy(true);
    try {
      await onSave({ id: parsedId, label: label.trim(), description: description.trim() || null, enrollInFlow });
      setLink(""); setLabel(""); setDescription(""); setEnrollInFlow(true);
      linkRef.current?.focus();
    } finally { setBusy(false); }
  }

  return (
    <div className="space-y-2">
      <input
        ref={linkRef}
        type="text"
        placeholder="Form link (e.g. https://form.typeform.com/to/pVx03fWu)"
        value={link}
        onChange={(e) => setLink(e.target.value)}
        className={cn(
          "w-full text-[12.5px] border rounded-md px-2.5 py-1.5 focus:outline-none focus:ring-2",
          linkLooksWrong
            ? "border-amber-300 focus:ring-amber-300/30"
            : "border-slate-200 focus:ring-accent/30"
        )}
      />
      {parsedId && (
        <div className="text-[11px] text-emerald-700 px-2.5 inline-flex items-center gap-1.5">
          <span className="font-medium">Detected ID:</span>
          <span className="font-mono">{parsedId}</span>
        </div>
      )}
      {linkLooksWrong && (
        <div className="text-[11px] text-amber-700 px-2.5">
          Couldn't find a form ID in that — paste the full link or just the ID.
        </div>
      )}
      <input
        type="text"
        placeholder="Display name (e.g. Scaled AI Outbounds)"
        value={label}
        onChange={(e) => setLabel(e.target.value)}
        className="w-full text-[13px] border border-slate-200 rounded-md px-2.5 py-1.5 focus:outline-none focus:ring-2 focus:ring-accent/30"
      />
      <input
        type="text"
        placeholder="(optional) short description"
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter") void go(); }}
        className="w-full text-[12.5px] border border-slate-200 rounded-md px-2.5 py-1.5 focus:outline-none focus:ring-2 focus:ring-accent/30"
      />
      <label className="flex items-start gap-2.5 rounded-md border border-slate-200 bg-white px-2.5 py-2 cursor-pointer select-none">
        <input
          type="checkbox"
          checked={enrollInFlow}
          onChange={(e) => setEnrollInFlow(e.target.checked)}
          className="mt-0.5 h-3.5 w-3.5 rounded border-slate-300 text-accent focus:ring-accent/30"
        />
        <span className="min-w-0">
          <span className="block text-[12.5px] font-medium text-ink">Add to flow</span>
          <span className="block text-[11px] text-ink/55 mt-0.5">
            Auto-enroll new submissions in the Recovery drip SMS sequence.
          </span>
        </span>
      </label>
      <button
        type="button"
        onClick={() => void go()}
        disabled={!canSubmit}
        className={cn(
          "w-full inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded-md text-[13px] font-semibold transition-colors",
          canSubmit
            ? "bg-accent text-white hover:bg-accent/90"
            : "bg-slate-100 text-ink/45 cursor-not-allowed"
        )}
      >
        {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
        Register form
      </button>
    </div>
  );
}
