"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Check, ChevronDown, Loader2, PartyPopper, AlertTriangle, BookOpen, ListChecks, Copy, Rocket } from "lucide-react";
import { toast } from "sonner";
import { cn, relativeTime } from "@/lib/utils";
import { useCurrentUser } from "@/lib/user-context";
import { CheckRow, Segmented, TextField, LinkActions, CopyBlock, Group, type Ctx } from "@/components/FbOnboardingPanel";
import {
  META_CHECKLIST, META_CHECKLIST_INTRO, META_STEPS, META_SECTIONS, META_TRAPS, META_FLOW, META_FLOW_NOTE,
  META_HOW_IT_WORKS, META_BUILD_ORDER, META_CLIENT_KEY, META_ZAP_KEYS, META_ZAP_NAME,
  metaProgress, itemsForStep, fillClient, metaZapKeysTsv, metaClientName,
  type MetaStep, type MetaTable, type MetaProgress, type OnboardingState, type EntryValue
} from "@/lib/meta-onboarding";

// One client's Meta onboarding: the SOP (how it works, steps A–D, cadence,
// known traps) and its go-live checklist. The checklist is the only thing
// that counts; each SOP step shows the checklist boxes it covers, and they
// are the same keys, so a box ticked in either view is ticked in both.

interface UserRef { id: string; name: string }
type View = "sop" | "checklist";

export function MetaOnboardingPanel({
  taskId, initialState, initialCompletedAt, users, canEdit
}: {
  taskId: string;
  initialState: OnboardingState | null;
  initialCompletedAt: string | null;
  users: UserRef[];
  canEdit: boolean;
}) {
  const [state, setState] = useState<OnboardingState | null>(initialState);
  const [completedAt, setCompletedAt] = useState<string | null>(initialCompletedAt);
  const [starting, setStarting] = useState(false);
  const [view, setView] = useState<View>("sop");
  // An anchor to scroll to once the view it lives in has rendered.
  const [jump, setJump] = useState<string | null>(null);
  const me = useCurrentUser();

  const p = useMemo(() => (state ? metaProgress(state) : null), [state]);

  useEffect(() => {
    if (!jump) return;
    document.getElementById(jump)?.scrollIntoView({ behavior: "smooth", block: "start" });
    setJump(null);
  }, [jump, view]);

  const go = (v: View, anchor?: string) => {
    setView(v);
    if (anchor) setJump(anchor);
    else window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const nameOf = (id: string | null) => (id ? users.find((u) => u.id === id)?.name ?? "someone" : "someone");

  async function start() {
    setStarting(true);
    try {
      const res = await fetch(`/api/tasks/${taskId}/meta-onboarding`, { method: "POST" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error ?? `failed (${res.status})`);
      setState(data.state ?? {});
      setCompletedAt(data.completedAt ?? null);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't start Meta onboarding");
    } finally {
      setStarting(false);
    }
  }

  // Optimistic and per-key, exactly as FB onboarding saves: the UI flips at
  // once, and a response only ever touches its own key, so a box ticked while
  // this request is in flight isn't briefly undone.
  const set = useCallback(async (key: string, value: EntryValue) => {
    if (!canEdit) return;
    let prevEntry: OnboardingState[string] | undefined;
    setState((cur) => {
      if (!cur) return cur;
      prevEntry = cur[key];
      return { ...cur, [key]: { v: value, by: me.id, at: new Date().toISOString() } };
    });
    try {
      const res = await fetch(`/api/tasks/${taskId}/meta-onboarding`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key, value })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error ?? `failed (${res.status})`);
      const saved = data.state?.[key];
      if (saved) setState((cur) => (cur && cur[key]?.v === saved.v ? { ...cur, [key]: saved } : cur));
      setCompletedAt((was) => {
        if (!was && data.completedAt) toast.success("Meta onboarding complete 🎉");
        return data.completedAt ?? null;
      });
    } catch (err) {
      setState((cur) => {
        if (!cur) return cur;
        const next = { ...cur };
        if (prevEntry) next[key] = prevEntry; else delete next[key];
        return next;
      });
      toast.error(err instanceof Error ? err.message : "Couldn't save");
    }
  }, [canEdit, me.id, taskId]);

  if (!state || !p) {
    return (
      <section className="card p-4 flex items-center justify-between gap-4">
        <div>
          <div className="text-sm font-medium">Meta onboarding</div>
          <div className="text-xs text-muted mt-0.5">
            The Meta Instant Form setup for this client: the SOP and its go-live checklist.
          </div>
        </div>
        {canEdit && (
          <button type="button" onClick={start} disabled={starting} className="btn-primary shrink-0">
            {starting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Rocket className="w-4 h-4" />}
            Start Meta onboarding
          </button>
        )}
      </section>
    );
  }

  const ctx: Ctx = { state, set, canEdit, nameOf };
  const client = metaClientName(state);

  return (
    <div className="grid gap-5 lg:grid-cols-[250px_minmax(0,1fr)] items-start">
      <aside className="card p-3 lg:sticky lg:top-4 space-y-1">
        <div className="px-2 pt-1 pb-3">
          <div className="text-[11px] uppercase tracking-wide text-muted">Client</div>
          <TextField ctx={ctx} k={META_CLIENT_KEY} placeholder="Name this client…" bare />
          {completedAt ? (
            <span className="mt-2 inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium border border-ok/30 bg-ok/10 text-ok">
              <PartyPopper className="w-3 h-3" /> Complete · {relativeTime(completedAt)}
            </span>
          ) : (
            <div className="text-[11px] text-muted mt-1">{p.done} of {p.total} go-live boxes ticked</div>
          )}
        </div>

        <ViewTab
          active={view === "sop"} onClick={() => go("sop")}
          icon={<BookOpen className="w-3.5 h-3.5" />} label="SOP"
          sub="How it works, steps A–D, cadence, traps"
        />
        <ViewTab
          active={view === "checklist"} onClick={() => go("checklist")}
          icon={<ListChecks className="w-3.5 h-3.5" />} label="Go-live checklist"
          done={p.done} total={p.total}
        />

        <div className="pt-2 mt-1 border-t border-border/60">
          {view === "sop" ? (
            <>
              <RailLink onClick={() => go("sop", "meta-how")} dot="bg-slate-200" label="How it works" />
              {META_STEPS.map((st) => {
                const items = itemsForStep(st.id);
                const done = items.filter((i) => state[i.key]?.v === true).length;
                return (
                  <RailLink
                    key={st.id}
                    onClick={() => go("sop", `meta-step-${st.id}`)}
                    dot={items.length === 0 ? "bg-slate-200" : done === items.length ? "bg-ok" : done > 0 ? "bg-accent" : "bg-slate-300"}
                    label={st.step === st.title ? st.step : `${st.step} · ${st.title}`}
                  />
                );
              })}
              <RailLink onClick={() => go("sop", "meta-traps")} dot="bg-slate-200" label="Known traps" />
            </>
          ) : (
            p.groups.map((g) => (
              <RailLink
                key={g.id}
                onClick={() => go("checklist", `meta-group-${g.id}`)}
                dot={g.done === g.total ? "bg-ok" : g.done > 0 ? "bg-accent" : "bg-slate-300"}
                label={g.title}
                count={`${g.done}/${g.total}`}
              />
            ))
          )}
        </div>
      </aside>

      <section className="card p-5 min-w-0">
        {view === "sop"
          ? <SopView ctx={ctx} client={client} />
          : <ChecklistView ctx={ctx} p={p} onStep={(id) => go("sop", `meta-step-${id}`)} />}
      </section>
    </div>
  );
}

// ---------------------------------------------------------------------------

function SopView({ ctx, client }: { ctx: Ctx; client: string }) {
  const steps = (section: string) => META_STEPS.filter((s) => s.section === section);
  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-lg font-semibold">Meta onboarding SOP</h2>
        <p className="text-xs text-muted mt-0.5">
          Meta Instant Form → Google Sheet → one Zap → Scaled Sync + Scaled Admissions. Each step&apos;s go-live boxes
          are the same boxes as the checklist, so tick them here as you go.
        </p>
      </div>

      <div id="meta-how" className="scroll-mt-4">
        <Group title="How it works">
          <p className="text-xs text-ink/80 leading-relaxed">{META_HOW_IT_WORKS}</p>
          <pre className="text-[11px] font-mono leading-snug overflow-x-auto whitespace-pre bg-surface2 border border-border rounded-lg p-2">{META_FLOW}</pre>
          <p className="text-xs text-muted">{META_FLOW_NOTE}</p>
        </Group>
      </div>

      {META_SECTIONS.map((sec) => (
        <div key={sec.id} className="space-y-2">
          {sec.id === "a" && (
            <div className="pt-1">
              <h3 className="text-sm font-semibold">Step by step</h3>
              <p className="text-xs text-muted mt-0.5">{META_BUILD_ORDER}</p>
            </div>
          )}
          <div className="label !mb-0">{sec.title}</div>
          {sec.intro && <p className="text-xs text-muted"><Rich text={sec.intro} /></p>}
          {sec.id === "c" && <CopyBlock label="Zap name (fill in the month)" text={fillClient(META_ZAP_NAME, client)} />}
          {steps(sec.id).map((st) => <MetaStepCard key={st.id} st={st} ctx={ctx} client={client} />)}
        </div>
      ))}

      <div id="meta-traps" className="scroll-mt-4 space-y-2">
        <div className="label !mb-0">Known traps</div>
        <p className="text-xs text-muted">Each of these came up during the Arrow Passage, Bright Mission or Changes setups.</p>
        <div className="rounded-xl border border-border divide-y divide-border/60 text-xs">
          <div className="hidden sm:grid grid-cols-[minmax(0,1.1fr)_minmax(0,1.4fr)_minmax(0,1.4fr)] gap-3 px-3 py-1.5 bg-surface2 text-muted font-medium rounded-t-xl">
            <span>Trap</span><span>What happens</span><span>Do this</span>
          </div>
          {META_TRAPS.map((t) => (
            <div key={t.trap} className="grid sm:grid-cols-[minmax(0,1.1fr)_minmax(0,1.4fr)_minmax(0,1.4fr)] gap-1 sm:gap-3 px-3 py-2">
              <span className="font-medium text-ink/90">{t.trap}</span>
              <span className="text-muted">{t.happens}</span>
              <span className="text-ink/80"><span className="sm:hidden font-medium">Do this: </span>{t.fix}</span>
            </div>
          ))}
        </div>
      </div>

      <div className="flex items-start gap-2 rounded-lg border border-warn/30 bg-warn/5 px-2.5 py-1.5 text-[11px] text-warn">
        <AlertTriangle className="w-3.5 h-3.5 mt-px shrink-0" />
        The Sheet holds names and phone numbers of people contacting a treatment centre. Keep it shared with as few people as possible.
      </div>
    </div>
  );
}

function MetaStepCard({ st, ctx, client }: { st: MetaStep; ctx: Ctx; client: string }) {
  const items = itemsForStep(st.id);
  const done = items.filter((i) => ctx.state[i.key]?.v === true).length;
  const full = items.length > 0 && done === items.length;
  // Steps still in play stay open; finished ones fold away.
  const [open, setOpen] = useState(!full);

  return (
    <div id={`meta-step-${st.id}`} className={cn("rounded-xl border scroll-mt-4 transition-colors", full ? "border-ok/30" : "border-border")}>
      <button type="button" onClick={() => setOpen(!open)} className="w-full flex items-center gap-2 p-3 text-left">
        <ChevronDown className={cn("w-4 h-4 text-muted shrink-0 transition-transform", !open && "-rotate-90")} />
        <span className="text-[11px] uppercase tracking-wide text-muted w-16 sm:w-28 shrink-0">{st.step}</span>
        <span className="text-sm font-medium flex-1 min-w-0 truncate">{st.title}</span>
        {items.length > 0 && (
          <span className={cn("text-[11px] shrink-0 inline-flex items-center gap-1 tabular-nums", full ? "text-ok" : "text-muted")}>
            {full && <Check className="w-3.5 h-3.5" />}{done}/{items.length}
          </span>
        )}
      </button>

      {open && (
        <div className="px-3 pb-3 sm:pl-9 space-y-2.5">
          {st.text?.map((t) => <p key={t} className="text-xs text-ink/80 leading-relaxed"><Rich text={fillClient(t, client)} /></p>)}
          {st.bullets && (
            <ul className="list-disc pl-4 space-y-1 text-xs text-ink/80 leading-relaxed">
              {st.bullets.map((b) => <li key={b}><Rich text={b} /></li>)}
            </ul>
          )}
          {st.table && <TableView table={st.table} copyText={st.table === META_ZAP_KEYS ? metaZapKeysTsv() : undefined} />}
          {st.after?.map((t) => <p key={t} className="text-xs text-ink/80 leading-relaxed"><Rich text={t} /></p>)}
          {st.copies?.map((c) => <CopyBlock key={c.label} label={c.label} text={fillClient(c.text, client)} />)}
          {st.warn && (
            <div className="flex items-start gap-2 rounded-lg border border-warn/30 bg-warn/5 px-2.5 py-1.5 text-[11px] text-warn">
              <AlertTriangle className="w-3.5 h-3.5 mt-px shrink-0" />{st.warn}
            </div>
          )}

          {items.length > 0 && (
            <div className="rounded-lg border border-border/70 bg-surface2/40 px-2.5 py-2">
              <div className="text-[10px] uppercase tracking-wide text-muted mb-1">Go-live checklist</div>
              <div className="space-y-0.5">
                {items.map((i) => <CheckRow key={i.key} ctx={ctx} k={i.key} label={<Rich text={i.label} />} />)}
              </div>
            </div>
          )}

          {st.choices?.map((c) => (
            <div key={c.key}>
              <div className="text-[11px] text-muted mb-1">{c.label}</div>
              <Segmented ctx={ctx} k={c.key} options={c.options} />
            </div>
          ))}
          {st.inputs?.map((i) => (
            <div key={i.key}>
              <div className="flex items-center justify-between gap-2 mb-1">
                <div className="text-[11px] text-muted">{i.label} <span className="text-muted/70">(for reference)</span></div>
                {i.url && <LinkActions value={str(ctx.state, i.key)} label={i.label} />}
              </div>
              <TextField ctx={ctx} k={i.key} placeholder={i.placeholder} small />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function ChecklistView({ ctx, p, onStep }: { ctx: Ctx; p: MetaProgress; onStep: (stepId: string) => void }) {
  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-lg font-semibold">Go-live checklist</h2>
        <p className="text-xs text-muted mt-0.5">
          {META_CHECKLIST_INTRO} The tag on each box opens the SOP step that does it.
        </p>
      </div>
      {META_CHECKLIST.map((g) => {
        const gp = p.groups.find((x) => x.id === g.id);
        return (
          <div key={g.id} id={`meta-group-${g.id}`} className="scroll-mt-4">
            <div className="flex items-center justify-between gap-2">
              <div className="label">{g.title}</div>
              {gp && <span className={cn("text-[11px] tabular-nums mb-1.5", gp.done === gp.total ? "text-ok" : "text-muted")}>{gp.done}/{gp.total}</span>}
            </div>
            <div className="rounded-xl border border-border p-3 space-y-1">
              {g.items.map((i) => (
                <div key={i.key} className="flex items-start gap-2">
                  <div className="flex-1 min-w-0">
                    <CheckRow ctx={ctx} k={i.key} label={<Rich text={i.label} />} />
                  </div>
                  <button
                    type="button"
                    onClick={() => onStep(i.step)}
                    title="Open this step in the SOP"
                    className="shrink-0 mt-1 whitespace-nowrap text-[10px] font-medium px-1.5 py-0.5 rounded border border-border text-muted hover:text-accent hover:border-accent/40 transition-colors"
                  >
                    {META_STEPS.find((s) => s.id === i.step)?.step ?? i.step}
                  </button>
                </div>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------

function ViewTab({ active, onClick, icon, label, sub, done, total }: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
  sub?: string;
  done?: number;
  total?: number;
}) {
  const counted = done !== undefined && total !== undefined;
  const full = counted && done === total;
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn("w-full text-left rounded-xl px-2.5 py-2 transition-colors duration-150", active ? "bg-accent/[0.07]" : "hover:bg-surface2")}
    >
      <div className="flex items-center gap-2 text-sm">
        <span className={cn(
          "w-5 h-5 rounded-full grid place-items-center shrink-0 transition-colors",
          full ? "bg-ok text-white" : active ? "bg-accent text-white" : "bg-surface2 text-muted"
        )}>
          {full ? <Check className="w-3 h-3" strokeWidth={3} /> : icon}
        </span>
        <span className={cn("flex-1", active ? "font-semibold text-accent" : "font-medium")}>{label}</span>
        {counted && <span className="text-[11px] text-muted tabular-nums">{done}/{total}</span>}
      </div>
      {sub && <div className="ml-7 mt-0.5 text-[11px] text-muted">{sub}</div>}
      {counted && (
        <div className="mt-1.5 ml-7 h-1 rounded-full bg-surface2 overflow-hidden">
          <div className={cn("h-full rounded-full transition-[width] duration-300", full ? "bg-ok" : "bg-accent")} style={{ width: `${(done / Math.max(total, 1)) * 100}%` }} />
        </div>
      )}
    </button>
  );
}

function RailLink({ onClick, dot, label, count }: { onClick: () => void; dot: string; label: string; count?: string }) {
  return (
    <button type="button" onClick={onClick} className="w-full flex items-center gap-2 px-2.5 py-1 rounded-lg text-xs text-left hover:bg-surface2 transition-colors">
      <span className={cn("w-1.5 h-1.5 rounded-full shrink-0", dot)} />
      <span className="flex-1 truncate text-ink/80">{label}</span>
      {count && <span className="text-[11px] text-muted tabular-nums">{count}</span>}
    </button>
  );
}

function TableView({ table, copyText }: { table: MetaTable; copyText?: string }) {
  return (
    <div className="rounded-lg border border-border overflow-hidden">
      {copyText && (
        <div className="flex justify-end px-2.5 py-1 border-b border-border/60">
          <button
            type="button"
            onClick={() => navigator.clipboard.writeText(copyText).then(() => toast.success("Copied"), () => toast.error("Couldn't copy"))}
            className="inline-flex items-center gap-1 text-[11px] text-accent hover:underline"
          >
            <Copy className="w-3 h-3" /> Copy table
          </button>
        </div>
      )}
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead className="bg-surface2 text-muted">
            <tr>{table.head.map((h) => <th key={h} className="text-left font-medium px-2.5 py-1.5">{h}</th>)}</tr>
          </thead>
          <tbody className="divide-y divide-border/60">
            {table.rows.map((r) => (
              <tr key={r.join("|")}>
                {r.map((c, i) => (
                  <td key={i} className={cn("px-2.5 py-1.5 align-top", i === 0 ? "font-medium text-ink/90" : "text-ink/80")}>
                    <Rich text={c} />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// The SOP's two inline markers: **bold** for a button or setting name,
// `code` for a literal value. Plain text otherwise, never HTML.
function Rich({ text }: { text: string }) {
  const parts = text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g);
  return (
    <>
      {parts.map((part, i) =>
        part.startsWith("**") && part.endsWith("**") && part.length > 4
          ? <strong key={i} className="font-semibold text-ink">{part.slice(2, -2)}</strong>
          : part.startsWith("`") && part.endsWith("`") && part.length > 2
            ? <code key={i} className="font-mono text-[0.92em] px-1 rounded bg-surface2 border border-border/70">{part.slice(1, -1)}</code>
            : part
      )}
    </>
  );
}

const str = (s: OnboardingState, k: string) => (typeof s[k]?.v === "string" ? (s[k].v as string) : "");
