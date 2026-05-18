"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import Papa from "papaparse";
import { toast } from "sonner";
import {
  Upload, ArrowLeft, FileSpreadsheet, Loader2, AlertTriangle,
  CheckCircle2, ListFilter
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useCurrentUser } from "@/lib/user-context";

// /clients/import — leader-only Notion CSV importer.
//
// Drag in a CSV exported from a Notion task DB ("Website Client
// History" or "Website & SEO Task Management"). PapaParse runs in
// the browser to dodge encoding hassles, each row gets mapped to
// DD's task shape (status, priority, assignee, all the Notion-style
// columns DD's tasks table already has), and the bulk insert
// happens on /api/clients/import.
//
// Single-shot tool: pick file → review counts → Import. The mapping
// rules are documented inline so you can see exactly what each
// Notion field translates to.

interface UserLight { id: string; name: string }

type TaskStatus = "pending" | "in_progress" | "urgent" | "waiting_on_client" | "done";
type TaskPriority = "low" | "medium" | "high" | "critical";

interface ImportedTask {
  title: string;
  status: TaskStatus;
  priority: TaskPriority;
  assigneeId?: string | null;
  dueDate?: string | null;
  clientName?: string | null;
  website?: string | null;
  clientEmail?: string | null;
  clientFolderUrl?: string | null;
  stagingServer?: string | null;
  markupLink?: string | null;
  hostingAccess?: string | null;
  missiveThreadUrl?: string | null;
  description?: string | null;
}

interface RowResult {
  ok: boolean;
  task?: ImportedTask;
  reason?: string;
  assigneeUnresolved?: string | null; // raw name when we couldn't match
}

export default function ImportClientsPage() {
  const me = useCurrentUser();
  const canEdit = me.role === "leader" || !!me.isAdmin;

  const [users, setUsers] = useState<UserLight[]>([]);
  const [file, setFile] = useState<File | null>(null);
  const [rows, setRows] = useState<RowResult[]>([]);
  const [parsing, setParsing] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<{ created: number; skipped: number } | null>(null);

  useEffect(() => {
    fetch("/api/users", { cache: "no-store" })
      .then((r) => r.ok ? r.json() : { users: [] })
      .then((data: { users?: UserLight[] }) => setUsers(data.users ?? []))
      .catch(() => { /* ignore — assignee resolution just fails open */ });
  }, []);

  const onPick = useCallback((picked: File | null) => {
    setFile(picked);
    setRows([]);
    setResult(null);
    if (!picked) return;
    setParsing(true);
    Papa.parse<Record<string, string>>(picked, {
      header: true,
      skipEmptyLines: true,
      complete: ({ data }) => {
        const mapped = data.map((row) => mapRow(row, users));
        setRows(mapped);
        setParsing(false);
      },
      error: (err) => {
        toast.error(`CSV parse failed: ${err.message}`);
        setParsing(false);
      }
    });
  }, [users]);

  const counts = useMemo(() => {
    const ok = rows.filter((r) => r.ok);
    const skipped = rows.filter((r) => !r.ok);
    const byStatus: Record<string, number> = {};
    const byPriority: Record<string, number> = {};
    const unresolvedAssignees = new Set<string>();
    for (const r of ok) {
      const t = r.task!;
      byStatus[t.status] = (byStatus[t.status] ?? 0) + 1;
      byPriority[t.priority] = (byPriority[t.priority] ?? 0) + 1;
      if (!t.assigneeId && r.assigneeUnresolved) unresolvedAssignees.add(r.assigneeUnresolved);
    }
    return {
      total: rows.length,
      ok: ok.length,
      skipped: skipped.length,
      byStatus,
      byPriority,
      unresolvedAssignees: Array.from(unresolvedAssignees).sort()
    };
  }, [rows]);

  async function submit() {
    if (counts.ok === 0 || submitting) return;
    setSubmitting(true);
    try {
      const payload = rows.filter((r) => r.ok).map((r) => r.task!);
      const res = await fetch("/api/clients/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rows: payload })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? `import failed (${res.status})`);
      setResult({ created: data.created, skipped: data.skipped });
      toast.success(`Imported ${data.created} tasks${data.skipped ? ` (${data.skipped} skipped)` : ""}.`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "import failed");
    } finally {
      setSubmitting(false);
    }
  }

  if (!canEdit) {
    return (
      <div className="max-w-2xl mx-auto p-8 text-center">
        <div className="text-sm text-ink/60">
          Leader access required to import from Notion.
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-5 max-w-3xl mx-auto">
      <Link
        href="/clients"
        className="inline-flex items-center gap-1.5 text-[12px] text-ink/60 hover:text-accent"
      >
        <ArrowLeft className="w-3.5 h-3.5" /> Back to Clients
      </Link>

      <header>
        <div className="text-[12px] uppercase tracking-[0.18em] font-semibold text-accent inline-flex items-center gap-1.5">
          <FileSpreadsheet className="w-3.5 h-3.5" /> Notion import
        </div>
        <h1 className="text-[28px] leading-tight font-bold text-ink mt-1 tracking-tight">
          Bring your Notion <span className="text-accent">task DB into DD</span>
        </h1>
        <p className="text-sm text-ink/60 mt-1 max-w-xl">
          Export from Notion as CSV (the &ldquo;Export&hellip; → Markdown &amp; CSV&rdquo; option), pick the
          full export (the file named like <code className="text-[11px] bg-slate-100 px-1 py-0.5 rounded">..._all.csv</code>),
          and drop it in below. Mapping rules are listed underneath.
        </p>
      </header>

      <section className="rounded-2xl border border-slate-200/70 bg-white p-5 shadow-soft space-y-3">
        <label className="block">
          <span className="text-[11px] uppercase tracking-wide text-ink/55 font-semibold">CSV file</span>
          <input
            type="file"
            accept=".csv,text/csv"
            onChange={(e) => onPick(e.target.files?.[0] ?? null)}
            disabled={parsing || submitting}
            className="mt-1 block w-full text-[13px] file:mr-3 file:px-3 file:py-1.5 file:rounded-full file:border-0 file:bg-accent/10 file:text-accent file:font-medium hover:file:bg-accent/15"
          />
        </label>
        {parsing && (
          <div className="text-[12px] text-ink/60 inline-flex items-center gap-1.5">
            <Loader2 className="w-3.5 h-3.5 animate-spin" /> Parsing…
          </div>
        )}
        {file && !parsing && rows.length > 0 && (
          <PreviewSummary counts={counts} />
        )}
      </section>

      {file && !parsing && rows.length > 0 && (
        <section className="rounded-2xl border border-slate-200/70 bg-white p-5 shadow-soft">
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <div className="text-[13px] text-ink/70">
              {result ? (
                <span className="inline-flex items-center gap-1.5 text-emerald-700">
                  <CheckCircle2 className="w-4 h-4" />
                  Imported {result.created} tasks. {result.skipped > 0 && `${result.skipped} skipped server-side.`}
                </span>
              ) : (
                <>
                  Ready to import <strong>{counts.ok}</strong> task{counts.ok === 1 ? "" : "s"}.
                  {counts.skipped > 0 && <span className="text-ink/55"> {counts.skipped} row{counts.skipped === 1 ? "" : "s"} will be skipped (missing title).</span>}
                </>
              )}
            </div>
            {!result && (
              <button
                type="button"
                onClick={submit}
                disabled={counts.ok === 0 || submitting}
                className={cn(
                  "inline-flex items-center gap-1.5 px-4 py-1.5 rounded-full text-xs font-semibold text-white shadow-sm transition-all hover:-translate-y-0.5 active:scale-95",
                  (counts.ok === 0 || submitting) && "opacity-60 cursor-not-allowed hover:translate-y-0"
                )}
                style={{ background: "linear-gradient(135deg, #2563EB 0%, #1e63ff 100%)" }}
              >
                {submitting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Upload className="w-3.5 h-3.5" />}
                {submitting ? "Importing…" : `Import ${counts.ok} tasks`}
              </button>
            )}
          </div>
        </section>
      )}

      <MappingReference />
    </div>
  );
}

function PreviewSummary({ counts }: {
  counts: {
    total: number; ok: number; skipped: number;
    byStatus: Record<string, number>;
    byPriority: Record<string, number>;
    unresolvedAssignees: string[];
  }
}) {
  return (
    <div className="space-y-2 text-[12px]">
      <div className="text-ink/70">
        Parsed <strong>{counts.total}</strong> rows · {counts.ok} ready · {counts.skipped} skipped
      </div>
      <div className="flex items-center flex-wrap gap-1.5">
        {Object.entries(counts.byStatus).map(([s, n]) => (
          <span key={s} className="inline-flex items-center px-2 py-0.5 rounded-full bg-slate-100 text-ink/70 text-[10px] font-medium">
            {s}: {n}
          </span>
        ))}
      </div>
      <div className="flex items-center flex-wrap gap-1.5">
        {Object.entries(counts.byPriority).map(([p, n]) => (
          <span key={p} className="inline-flex items-center px-2 py-0.5 rounded-full bg-indigo-50 text-indigo-700 text-[10px] font-medium">
            {p}: {n}
          </span>
        ))}
      </div>
      {counts.unresolvedAssignees.length > 0 && (
        <div className="rounded-lg bg-amber-50 border border-amber-200/60 p-2 text-amber-900/85 inline-flex items-start gap-1.5">
          <AlertTriangle className="w-3 h-3 mt-0.5 shrink-0" />
          <div>
            <div className="font-semibold">Couldn&rsquo;t match these names to a DD user — those tasks import unassigned:</div>
            <div className="mt-0.5 text-[11px]">{counts.unresolvedAssignees.join(" · ")}</div>
          </div>
        </div>
      )}
    </div>
  );
}

function MappingReference() {
  return (
    <details className="rounded-2xl border border-slate-200/70 bg-slate-50/60 p-4 text-[12px] text-ink/70">
      <summary className="cursor-pointer text-[12px] font-semibold text-ink/85 inline-flex items-center gap-1.5">
        <ListFilter className="w-3.5 h-3.5" /> How fields are mapped
      </summary>
      <div className="mt-3 space-y-2 leading-relaxed">
        <p>
          <strong>Status</strong> (Notion column <code>Status </code> with trailing space):
          <span className="text-ink/55"> Complete → done · Approval/Waiting for Client/Ready For Review → waiting_on_client · In Progress/Working/Co-Working/Edit round 1 → in_progress · Not Started (or blank) → pending</span>
        </p>
        <p>
          <strong>Priority</strong> (column <code>Priority Level</code>):
          <span className="text-ink/55"> Urgent / Priority 1 → critical · High / Priority 2 → high · Medium / Priority 3 → medium · Low / Priority 4 → low</span>
        </p>
        <p>
          <strong>Assignee</strong> (column <code>Assign</code>):
          <span className="text-ink/55"> first comma-separated name is fuzzy-matched against DD users by first-name. Unmatched names show in the warning above and import unassigned.</span>
        </p>
        <p>
          <strong>Client</strong> (the column called <code>Status</code> without trailing space, OR a column ending in <code>Clients Name</code>):
          <span className="text-ink/55"> stored verbatim in task.client_name — same text-match logic the existing /clients/[id] page already uses.</span>
        </p>
        <p>
          <strong>Notion-style metadata</strong>: <code>Website</code>, <code>Current Website</code>, <code>Markup Link</code>, <code>Staging Server</code>, <code>Hosting/Access</code>, <code>Front Thread</code> / <code>Missive Thread</code>, <code>Client Email</code>, <code>Client Folder</code> — all map 1:1 to the matching DD task fields. No data lost.
        </p>
        <p>
          <strong>Description</strong>: starts with <code>Imported from Notion.</code> so you can filter on it later if you ever want to delete the imported set in bulk.
        </p>
      </div>
    </details>
  );
}

// ============================ MAPPING ============================

function mapRow(raw: Record<string, string>, users: UserLight[]): RowResult {
  const title = getCol(raw, ["Name"]).trim();
  if (!title) return { ok: false, reason: "missing title" };

  // "Status " with the trailing space is the workflow column in Notion.
  // The bare "Status" column is misnamed and actually holds the client.
  // Fall back to "Clients Name" / "Client Name" if the bare-Status col
  // doesn't look like a client.
  const workflowRaw = getCol(raw, ["Status ", "status "]);
  const status = mapStatus(workflowRaw);

  const priority = mapPriority(getCol(raw, ["Priority Level"]));

  const assignRaw = getCol(raw, ["Assign"]).trim();
  const { id: assigneeId, raw: rawName } = resolveAssignee(assignRaw, users);

  const dueDate = parseDueDate(getCol(raw, ["Due Date"]));

  // The Notion column literally called "Status" (no trailing space)
  // holds the client. Some files also have an emoji-prefixed
  // "Clients Name" column; prefer that if both exist and non-blank.
  const clientByEmoji = getCol(raw, ["Clients Name", "Client Name"]).trim();
  const clientByStatusCol = getStatusColAsClient(raw).trim();
  const clientName = clientByEmoji || clientByStatusCol || null;

  const website = (getCol(raw, ["Website", "Current Website"]).trim()) || null;
  const clientEmail = stripMailto(getCol(raw, ["Client Email"])) || null;
  const clientFolderUrl = (getCol(raw, ["Client Folder"]).trim()) || null;
  const stagingServer = (getCol(raw, ["Staging Server"]).trim()) || null;
  const markupLink = (getCol(raw, ["Markup Link"]).trim()) || null;
  const hostingAccess = (getCol(raw, ["Hosting/Access"]).trim()) || null;
  const missiveThreadUrl = (getCol(raw, ["Missive Thread", "Front Thread"]).trim()) || null;

  const description = "Imported from Notion." +
    (workflowRaw ? `\nOriginal status: ${workflowRaw.trim()}` : "");

  return {
    ok: true,
    assigneeUnresolved: !assigneeId && rawName ? rawName : null,
    task: {
      title,
      status,
      priority,
      assigneeId,
      dueDate,
      clientName,
      website,
      clientEmail,
      clientFolderUrl,
      stagingServer,
      markupLink,
      hostingAccess,
      missiveThreadUrl,
      description
    }
  };
}

// Try a list of candidate column names; first hit wins. Matching is
// case-insensitive on the trimmed, BOM-stripped key. Suffix matches
// also work so the emoji-prefixed Notion headers ("📂 Client Folder")
// still resolve.
function getCol(row: Record<string, string>, candidates: string[]): string {
  const norm = (s: string) => s.replace(/^﻿/, "").trim().toLowerCase();
  for (const candidate of candidates) {
    const wanted = norm(candidate);
    for (const key of Object.keys(row)) {
      const k = norm(key);
      if (k === wanted) return row[key] ?? "";
    }
  }
  // Second pass: suffix match (handles emoji-prefixed Notion columns).
  for (const candidate of candidates) {
    const wanted = norm(candidate);
    for (const key of Object.keys(row)) {
      const k = norm(key);
      if (k.endsWith(wanted) && k !== wanted) return row[key] ?? "";
    }
  }
  return "";
}

// Reads the bare "Status" column (no trailing space) which in Notion's
// export is actually the client-name relation. Skips the trailing-space
// "Status " column.
function getStatusColAsClient(row: Record<string, string>): string {
  for (const key of Object.keys(row)) {
    const k = key.replace(/^﻿/, "");
    if (k === "Status") return row[key] ?? "";
  }
  return "";
}

function mapStatus(raw: string): TaskStatus {
  const s = raw.trim().toLowerCase();
  if (!s) return "pending";
  if (s === "not started") return "pending";
  if (s === "complete") return "done";
  if (s === "approval" || s.startsWith("waiting") || s.includes("ready for")) return "waiting_on_client";
  if (
    s === "in progress" || s === "working" || s === "co-working" ||
    s.startsWith("edit round")
  ) return "in_progress";
  return "pending";
}

function mapPriority(raw: string): TaskPriority {
  const s = raw.toLowerCase();
  if (s.includes("urgent") || s.includes("priority 1")) return "critical";
  // Notion misspells "Priority" as "Priortiy" in one export so match both.
  if (s.includes("high") || s.includes("priority 2") || s.includes("priortiy 2")) return "high";
  if (s.includes("medium") || s.includes("priority 3")) return "medium";
  if (s.includes("low") || s.includes("priority 4")) return "low";
  return "medium";
}

function parseDueDate(raw: string): string | null {
  const s = raw.trim();
  if (!s) return null;
  const d = new Date(s);
  if (isNaN(d.getTime())) return null;
  return d.toISOString();
}

function resolveAssignee(rawAssign: string, users: UserLight[]): { id: string | null; raw: string | null } {
  if (!rawAssign) return { id: null, raw: null };
  // Notion can list multiple assignees separated by commas. DD only
  // supports a single assignee per task — take the first match we
  // resolve, or the first name in the list as the "raw" hint.
  const candidates = rawAssign.split(",").map((s) => s.trim()).filter(Boolean);
  for (const candidate of candidates) {
    const lower = candidate.toLowerCase();
    const first = lower.split(/\s+/)[0];
    const match = users.find((u) => {
      const un = u.name.toLowerCase();
      const ufirst = un.split(/\s+/)[0];
      return un === lower || un.includes(lower) || lower.includes(un) || ufirst === first;
    });
    if (match) return { id: match.id, raw: candidate };
  }
  return { id: null, raw: candidates[0] ?? null };
}

function stripMailto(raw: string): string {
  return raw.replace(/^mailto:/i, "").trim();
}
