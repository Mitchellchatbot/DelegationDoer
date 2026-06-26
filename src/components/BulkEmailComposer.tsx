"use client";

import { useMemo, useState } from "react";
import {
  Send, Clock, Loader2, Users, AlertTriangle, CheckCircle2, XCircle, Mail
} from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { Tooltip } from "@/components/Tooltip";

// Bulk "monthly SEO update" composer. Write one email, pick the clients to
// exclude, send to everyone else in a single action (one Missive thread
// per client). Mirrors ComposeButton's from-picker / schedule idioms and
// SuggestedDigestsCard's shared-recipient warning tag.

// Serialized roster shape from /api/clients/bulk-email (kept local so this
// client component never imports the server-only lib/bulk-email module).
interface SharedEmail {
  email: string;
  others: Array<{ clientId: string; name: string }>;
}
interface RosterClient {
  clientId: string;
  name: string;
  contactName: string | null;
  website: string | null;
  contactEmails: string[];
  // False when no contact email is on file — listed (disabled) but never sent.
  canEmail: boolean;
  updateCadence: string;
  status: string;
  teamId: string | null;
  sharedEmails: SharedEmail[];
}

interface FromOption {
  id: string;
  email: string;
  display_name: string | null;
}

interface SendResult {
  clientId: string;
  name: string;
  to: string[];
  ok: boolean;
  error?: string;
}

interface SendResponse {
  ok: boolean;
  scheduled: boolean;
  sendAt: string | null;
  total: number;
  sent: number;
  failed: number;
  results: SendResult[];
}

// Same three tokens the server renders (lib/bulk-email.renderTemplate).
// Duplicated here only for the live preview; the server is authoritative.
function renderPreview(template: string, c: RosterClient): string {
  return template
    .replace(/\{\{\s*client_name\s*\}\}/gi, c.name)
    .replace(/\{\{\s*contact_name\s*\}\}/gi, c.contactName ?? "there")
    .replace(/\{\{\s*website\s*\}\}/gi, c.website ?? "");
}

export function BulkEmailComposer({
  fromOptions,
  clients
}: {
  fromOptions: FromOption[];
  clients: RosterClient[];
}) {
  const [fromAccountId, setFromAccountId] = useState<string>(fromOptions[0]?.id ?? "");
  // Minimal starter — the worker writes the rest of the subject. The blast is
  // kept out of touchpoint health by a marker (automated flag), not the
  // subject text, so this can be anything.
  const [subject, setSubject] = useState("Update ");
  const [bodyText, setBodyText] = useState("");
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const [sendAtLocal, setSendAtLocal] = useState("");
  const [busy, setBusy] = useState(false);
  // Excluded client ids. Empty = everyone included (the default).
  const [excluded, setExcluded] = useState<Set<string>>(new Set());
  const [response, setResponse] = useState<SendResponse | null>(null);

  const fromMeta = fromOptions.find((a) => a.id === fromAccountId) ?? fromOptions[0];

  // Only clients with a contact email can actually be sent to — no-email
  // clients are listed (disabled) for visibility but never count toward the
  // send. The "of N" denominator is this emailable universe.
  const emailableCount = useMemo(() => clients.filter((c) => c.canEmail).length, [clients]);
  const includedCount = useMemo(
    () => clients.filter((c) => c.canEmail && !excluded.has(c.clientId)).length,
    [clients, excluded]
  );
  const previewClient = useMemo(
    () =>
      clients.find((c) => c.canEmail && !excluded.has(c.clientId)) ??
      clients.find((c) => c.canEmail) ??
      null,
    [clients, excluded]
  );

  function toggle(clientId: string) {
    setExcluded((prev) => {
      const next = new Set(prev);
      if (next.has(clientId)) next.delete(clientId);
      else next.add(clientId);
      return next;
    });
  }
  function selectAll() { setExcluded(new Set()); }
  function clearAll() { setExcluded(new Set(clients.filter((c) => c.canEmail).map((c) => c.clientId))); }

  async function submit() {
    if (!fromAccountId) { toast.error("Pick a sending inbox"); return; }
    if (!subject.trim()) { toast.error("Add a subject"); return; }
    if (!bodyText.trim()) { toast.error("Write the email body"); return; }
    if (includedCount === 0) { toast.error("Every client is excluded — nothing to send"); return; }

    // Resolve schedule the same way ComposeButton does: datetime-local is
    // local time; convert to a UTC ISO string the backend can compare.
    let sendAtISO: string | null = null;
    if (scheduleOpen && sendAtLocal) {
      const ms = new Date(sendAtLocal).getTime();
      if (Number.isNaN(ms)) { toast.error("Pick a valid date + time to schedule"); return; }
      if (ms <= Date.now() + 30_000) {
        toast.error("Schedule a time at least a minute from now (or turn off scheduling)");
        return;
      }
      sendAtISO = new Date(ms).toISOString();
    }

    const verb = sendAtISO ? "Schedule" : "Send";
    if (!window.confirm(
      `${verb} this email to ${includedCount} client${includedCount === 1 ? "" : "s"}?`
    )) return;

    setBusy(true);
    setResponse(null);
    try {
      const res = await fetch("/api/clients/bulk-email", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          fromAccountId,
          subject: subject.trim(),
          bodyText,
          excludedClientIds: Array.from(excluded),
          ...(sendAtISO ? { sendAt: sendAtISO } : {})
        })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { toast.error(data?.error ?? `failed (${res.status})`); return; }
      const r = data as SendResponse;
      setResponse(r);
      if (r.failed === 0) {
        toast.success(
          r.scheduled
            ? `Scheduled for ${r.total} client${r.total === 1 ? "" : "s"}`
            : `Sent to ${r.sent} client${r.sent === 1 ? "" : "s"} ✉️`
        );
      } else {
        toast.error(`${r.sent} sent, ${r.failed} failed — see the list below`);
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "network error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      {/* Compose card */}
      <section className="rounded-2xl border border-slate-200/70 bg-white shadow-soft overflow-hidden">
        <header
          className="px-5 py-3 flex items-center justify-between border-b border-slate-100 flex-wrap gap-2"
          style={{ background: "linear-gradient(120deg, #DBEAFE 0%, #EEF2FF 100%)" }}
        >
          <div className="flex items-center gap-2">
            <Mail className="w-4 h-4 text-accent" />
            <span className="text-sm font-semibold">Bulk SEO update</span>
          </div>
          {fromOptions.length > 1 ? (
            <label className="inline-flex items-center gap-1.5 text-[11px] text-ink/55">
              from
              <select
                value={fromAccountId}
                onChange={(e) => setFromAccountId(e.target.value)}
                className="text-[11px] bg-white/70 border border-slate-200 rounded-md px-1.5 py-0.5 outline-none focus:ring-2 focus:ring-accent/30 focus:border-accent/40 max-w-[260px]"
              >
                {fromOptions.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.display_name ? `${a.display_name} <${a.email}>` : a.email}
                  </option>
                ))}
              </select>
            </label>
          ) : (
            <span className="text-[11px] text-ink/55 truncate max-w-[260px]">
              from {fromMeta?.display_name || fromMeta?.email || "—"}
            </span>
          )}
        </header>

        <div className="p-4 space-y-3">
          <div className="flex items-center gap-2 px-3 py-2 rounded-xl border border-slate-200/70 bg-white/60 focus-within:ring-2 focus-within:ring-accent/30 focus-within:border-accent/40 transition-all">
            <span className="text-[11px] uppercase tracking-wide font-semibold text-ink/45 w-16 shrink-0">
              Subject
            </span>
            <input
              type="text"
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              placeholder="What's this about?"
              className="flex-1 bg-transparent text-sm outline-none placeholder:text-ink/40"
            />
          </div>

          <textarea
            value={bodyText}
            onChange={(e) => setBodyText(e.target.value)}
            placeholder="Write the monthly SEO update…"
            rows={10}
            className="w-full text-sm bg-white/60 border border-slate-200/70 rounded-xl px-3 py-2.5 outline-none focus:ring-2 focus:ring-accent/30 focus:border-accent/40 resize-y transition-all"
          />

          <div className="text-[11px] text-ink/55 leading-relaxed">
            Placeholders:{" "}
            <code className="px-1 py-0.5 rounded bg-slate-100 text-ink/70">{"{{client_name}}"}</code>{" "}
            <code className="px-1 py-0.5 rounded bg-slate-100 text-ink/70">{"{{contact_name}}"}</code>{" "}
            <code className="px-1 py-0.5 rounded bg-slate-100 text-ink/70">{"{{website}}"}</code>{" "}
            — filled per client at send time.
            <span className="block mt-1 text-ink/45">
              These sends are automatically kept out of touchpoint health, so they won&apos;t reset clients&apos; last-contacted status.
            </span>
          </div>

          {/* Live preview for the first included client. */}
          {previewClient && (subject.includes("{{") || bodyText.includes("{{")) && (
            <div className="rounded-xl border border-slate-200/60 bg-slate-50/60 p-3">
              <div className="text-[10px] uppercase tracking-wide text-ink/45 font-semibold mb-1">
                Preview · {previewClient.name}
              </div>
              <div className="text-[12px] font-semibold text-ink/80">
                {renderPreview(subject, previewClient) || <span className="text-ink/40">(no subject)</span>}
              </div>
              <div className="text-[12px] text-ink/70 whitespace-pre-wrap mt-1">
                {renderPreview(bodyText, previewClient)}
              </div>
            </div>
          )}

          {/* Schedule toggle. */}
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setScheduleOpen((v) => !v)}
              className={cn(
                "inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-full text-[11px] font-medium border transition-colors",
                scheduleOpen
                  ? "bg-blue-50 text-blue-700 border-blue-200 hover:bg-blue-100"
                  : "bg-white text-ink/65 border-slate-200 hover:text-ink hover:border-slate-300"
              )}
            >
              <Clock className="w-3 h-3" />
              {scheduleOpen ? "Scheduled" : "Schedule send"}
            </button>
            {scheduleOpen && (
              <input
                type="datetime-local"
                value={sendAtLocal}
                onChange={(e) => setSendAtLocal(e.target.value)}
                className="text-[11px] bg-white border border-slate-200 rounded-lg px-2 py-1 outline-none focus:ring-2 focus:ring-accent/30 focus:border-accent/40"
                min={new Date(Date.now() + 60_000).toISOString().slice(0, 16)}
              />
            )}
          </div>
        </div>
      </section>

      {/* Recipient picker */}
      <section className="rounded-2xl border border-slate-200/70 bg-white shadow-soft overflow-hidden">
        <header className="flex items-center justify-between px-4 py-3 border-b border-slate-100 flex-wrap gap-2">
          <div className="text-[13px] font-semibold inline-flex items-center gap-2">
            <Users className="w-4 h-4 text-accent" />
            Recipients
            <span className="text-[11px] text-ink/55 font-normal tabular-nums">
              · sending to {includedCount} of {emailableCount}
            </span>
          </div>
          <div className="flex items-center gap-2 text-[11px]">
            {excluded.size > 0 && (
              <button type="button" onClick={selectAll} className="text-accent hover:text-accent/80 font-medium">
                Select all
              </button>
            )}
            {includedCount > 0 && (
              <button type="button" onClick={clearAll} className="text-ink/55 hover:text-rose-600 font-medium">
                Clear all
              </button>
            )}
          </div>
        </header>

        {clients.length === 0 ? (
          <div className="px-4 py-8 text-center text-[12px] text-ink/55">
            No clients found.
          </div>
        ) : (
          <ul className="divide-y divide-slate-100/70 max-h-[460px] overflow-y-auto">
            {clients.map((c) => {
              const included = c.canEmail && !excluded.has(c.clientId);
              return (
                <li key={c.clientId} className="px-4 py-2.5">
                  <label className={cn("flex items-start gap-3", c.canEmail ? "cursor-pointer" : "cursor-default")}>
                    <input
                      type="checkbox"
                      checked={included}
                      disabled={!c.canEmail}
                      onChange={() => toggle(c.clientId)}
                      className={cn(
                        "mt-0.5 w-4 h-4 rounded border-slate-300 text-accent focus:ring-accent/30 shrink-0",
                        !c.canEmail && "opacity-40 cursor-not-allowed"
                      )}
                    />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className={cn("text-[13px] font-semibold truncate", included ? "text-ink" : "text-ink/40")}>
                          {c.name}
                        </span>
                        {!c.canEmail && (
                          <span className="inline-flex items-center gap-1 rounded-full border font-medium px-1.5 py-0.5 text-[10px] shrink-0 cursor-default bg-amber-50 text-amber-700 border-amber-200/70">
                            <AlertTriangle className="w-3 h-3" />
                            No email on file
                          </span>
                        )}
                        {c.sharedEmails.length > 0 && (
                          <Tooltip
                            side="top"
                            align="start"
                            label={
                              <div className="max-w-[16rem] space-y-1">
                                <div className="font-semibold text-blue-300 flex items-center gap-1.5">
                                  <AlertTriangle className="w-3 h-3 shrink-0" /> Shared recipient
                                </div>
                                {c.sharedEmails.map((s) => (
                                  <div key={s.email} className="text-white/85 leading-snug break-words">
                                    {s.email} also contacts {s.others.map((o) => o.name).join(", ")}.
                                  </div>
                                ))}
                              </div>
                            }
                          >
                            <span className="inline-flex items-center gap-1 rounded-full border font-medium px-1.5 py-0.5 text-[10px] shrink-0 cursor-default bg-blue-100 text-blue-700 border-blue-200/60">
                              <AlertTriangle className="w-3 h-3" />
                              Shared recipient
                            </span>
                          </Tooltip>
                        )}
                      </div>
                      <div className={cn("text-[11px] truncate mt-0.5", included ? "text-ink/55" : "text-ink/35")}>
                        {c.canEmail ? c.contactEmails.join(", ") : "No contact email on file"}
                      </div>
                    </div>
                  </label>
                </li>
              );
            })}
          </ul>
        )}

        <footer className="px-4 py-3 border-t border-slate-100 flex items-center justify-end gap-2 bg-slate-50/60">
          <button
            type="button"
            onClick={submit}
            disabled={busy || includedCount === 0}
            className={cn(
              "inline-flex items-center gap-1.5 px-4 py-1.5 rounded-full text-xs font-semibold text-white shadow-sm transition-all hover:-translate-y-0.5 hover:shadow-lift active:scale-95",
              (busy || includedCount === 0) && "opacity-60 cursor-not-allowed hover:translate-y-0"
            )}
            style={{ background: "linear-gradient(135deg, #0a4099 0%, #063270 100%)" }}
          >
            {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : scheduleOpen ? <Clock className="w-3.5 h-3.5" /> : <Send className="w-3.5 h-3.5" />}
            {busy
              ? scheduleOpen ? "Scheduling…" : "Sending…"
              : scheduleOpen ? `Schedule for ${includedCount}` : `Send to ${includedCount}`}
          </button>
        </footer>
      </section>

      {/* Results */}
      {response && (
        <section className="rounded-2xl border border-slate-200/70 bg-white shadow-soft overflow-hidden">
          <header className="px-4 py-3 border-b border-slate-100 text-[13px] font-semibold inline-flex items-center gap-2">
            {response.failed === 0
              ? <CheckCircle2 className="w-4 h-4 text-emerald-600" />
              : <AlertTriangle className="w-4 h-4 text-amber-600" />}
            {response.scheduled ? "Scheduled" : "Sent"} · {response.sent} ok
            {response.failed > 0 && <span className="text-rose-600">· {response.failed} failed</span>}
          </header>
          <ul className="divide-y divide-slate-100/70 max-h-[320px] overflow-y-auto">
            {response.results.map((r) => (
              <li key={r.clientId} className="px-4 py-2 flex items-center gap-2 text-[12px]">
                {r.ok
                  ? <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600 shrink-0" />
                  : <XCircle className="w-3.5 h-3.5 text-rose-600 shrink-0" />}
                <span className="font-medium text-ink/80 truncate">{r.name}</span>
                <span className="text-ink/45 truncate">{r.to.join(", ")}</span>
                {!r.ok && r.error && <span className="text-rose-600 truncate ml-auto">{r.error}</span>}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
