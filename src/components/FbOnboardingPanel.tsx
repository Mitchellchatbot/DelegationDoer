"use client";

import { useCallback, useMemo, useState } from "react";
import {
  Rocket, Check, AlertTriangle, Lock, Copy, ChevronDown, Loader2, PartyPopper, Wrench, Pause, Play
} from "lucide-react";
import { toast } from "sonner";
import { cn, relativeTime } from "@/lib/utils";
import { useCurrentUser } from "@/lib/user-context";
import {
  ACCESS_ITEMS, ZAPS, SLACK_CHANNELS, CLIENT_STREAMS, CLIENT_OTHER_KEY, PROVIDER_KEY, TEST_PHONE_NOTE,
  accessStatus, blockedKey, noteKey, zapBuiltKey, zapUrlKey, slackKey, clientKey, channelSlug,
  testCases, testResultKey, testNoteKey, caseAnswers, progress,
  MAIN_ZAP_STEPS, MAIN_ZAP_FAILURES, mainKey, mainStepKeys, fillTokens,
  stage, stagePhase, WAITING_ON_KEY, WAITING_NOTE_KEY, HOLD_KEY, HOLD_NOTE_KEY,
  type OnboardingState, type EntryValue, type AccessStatus, type TestCase, type AccessItem, type MainZapStep,
  type Phase
} from "@/lib/fb-onboarding";

// Facebook client onboarding checklist on a Facebook task. Access → Main Zap →
// Setup → Test. Everything after Access is soft-locked: editable early, but
// bannered until the phase before is done. Nothing here notifies anyone — blocked items are
// recorded for the onboarder to escalate themselves.

interface UserRef { id: string; name: string }

export function FbOnboardingPanel({
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
  const me = useCurrentUser();

  const p = useMemo(() => (state ? progress(state) : null), [state]);
  // Opens on the stage the client is actually in, via the same ladder the
  // board groups by — so the section a card sits in and the tab that opens
  // when you click it can never disagree.
  //
  // Stays a lazy initialiser on purpose. Deriving it on every render would
  // yank you out of the tab you're mid-sentence in the instant you tick its
  // last box; where you're looking is your business once you're in here.
  const [phase, setPhase] = useState<Phase>(() => (p ? stagePhase(stage(p, completedAt)) : "access"));

  const nameOf = (id: string | null) => (id ? users.find((u) => u.id === id)?.name ?? "someone" : "someone");

  async function start() {
    setStarting(true);
    try {
      const res = await fetch(`/api/tasks/${taskId}/fb-onboarding`, { method: "POST" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error ?? `failed (${res.status})`);
      setState(data.state ?? {});
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't start onboarding");
    } finally {
      setStarting(false);
    }
  }

  // Optimistic and per-key. The UI flips instantly (stamped with the real
  // user so the "who · when" line doesn't jump when the server answers), and
  // a response only ever touches its own key — replacing the whole state
  // would briefly undo any box ticked while this request was in flight.
  const set = useCallback(async (key: string, value: EntryValue) => {
    if (!canEdit) return;
    let prevEntry: OnboardingState[string] | undefined;
    setState((cur) => {
      if (!cur) return cur;
      prevEntry = cur[key];
      return { ...cur, [key]: { v: value, by: me.id, at: new Date().toISOString() } };
    });
    try {
      const res = await fetch(`/api/tasks/${taskId}/fb-onboarding`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key, value })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error ?? `failed (${res.status})`);
      const saved = data.state?.[key];
      if (saved) setState((cur) => (cur && cur[key]?.v === saved.v ? { ...cur, [key]: saved } : cur));
      setCompletedAt((was) => {
        if (!was && data.completedAt) toast.success("Onboarding complete 🎉");
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
          <div className="text-sm font-medium">Facebook onboarding</div>
          <div className="text-xs text-muted mt-0.5">Access checks, zap + Slack setup, and the Typeform test run for this client.</div>
        </div>
        {canEdit && (
          <button type="button" onClick={start} disabled={starting} className="btn-primary shrink-0">
            {starting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Rocket className="w-4 h-4" />}
            Start onboarding
          </button>
        )}
      </section>
    );
  }

  const ctx: Ctx = { state, set, canEdit, nameOf };
  const provider = str(state, PROVIDER_KEY);
  const slug = channelSlug(provider);

  const tabs: { id: Phase; label: string; done: number; total: number; warn?: boolean }[] = [
    { id: "access", label: "Access", done: p.accessCleared, total: p.accessTotal, warn: p.blocked > 0 },
    { id: "main", label: "Main Zap", done: p.mainDone, total: p.mainTotal },
    { id: "setup", label: "Setup", done: p.setupDone, total: p.setupTotal },
    { id: "test", label: "Test", done: p.testsDone, total: p.testsTotal, warn: p.testsFailed > 0 }
  ];

  const phaseTitle: Record<Phase, { title: string; sub: string }> = {
    access: { title: "Access", sub: "Everything the client has to clear before the build starts." },
    main: { title: ZAPS[0].name(provider || "{Provider}"), sub: "Typeform Client Intake SOP — dedup, filter, enrich and route each entry. About 60 minutes; work top to bottom." },
    setup: { title: "Setup", sub: "Calendly and Failsafe zaps, our Slack channels and the client's notifications." },
    test: { title: "Test", sub: "Live Typeform submissions through the finished build. Every case must pass before onboarding is complete." }
  };

  return (
    <div className="grid gap-5 lg:grid-cols-[250px_minmax(0,1fr)] items-start">
      <aside className="card p-3 lg:sticky lg:top-4 space-y-1">
        <div className="px-2 pt-1 pb-3">
          <div className="text-[11px] uppercase tracking-wide text-muted">Provider</div>
          <TextField ctx={ctx} k={PROVIDER_KEY} placeholder="Name this client…" bare />
          {completedAt ? (
            <span className="mt-2 inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium border border-ok/30 bg-ok/10 text-ok">
              <PartyPopper className="w-3 h-3" /> Complete · {relativeTime(completedAt)}
            </span>
          ) : (
            <div className="text-[11px] text-muted mt-1">Names every zap, sheet and channel.</div>
          )}
        </div>
        <FlowControls ctx={ctx} />
        {tabs.map((t, i) => {
          const full = t.done === t.total;
          const activeTab = phase === t.id;
          return (
            <button
              key={t.id}
              type="button"
              onClick={() => { setPhase(t.id); window.scrollTo({ top: 0, behavior: "smooth" }); }}
              className={cn(
                "w-full text-left rounded-xl px-2.5 py-2 transition-colors duration-150",
                activeTab ? "bg-accent/[0.07]" : "hover:bg-surface2"
              )}
            >
              <div className="flex items-center gap-2 text-sm">
                <span className={cn(
                  "w-5 h-5 rounded-full grid place-items-center text-[10px] font-semibold shrink-0 transition-colors",
                  full ? "bg-ok text-white" : activeTab ? "bg-accent text-white" : "bg-surface2 text-muted"
                )}>
                  {full ? <Check className="w-3 h-3" strokeWidth={3} /> : i + 1}
                </span>
                <span className={cn("flex-1", activeTab ? "font-semibold text-accent" : "font-medium")}>{t.label}</span>
                {t.warn && <AlertTriangle className="w-3.5 h-3.5 text-urgent" />}
                <span className="text-[11px] text-muted tabular-nums">{t.done}/{t.total}</span>
              </div>
              <div className="mt-1.5 ml-7 h-1 rounded-full bg-surface2 overflow-hidden">
                <div className={cn("h-full rounded-full transition-[width] duration-300", full ? "bg-ok" : "bg-accent")} style={{ width: `${(t.done / Math.max(t.total, 1)) * 100}%` }} />
              </div>
            </button>
          );
        })}
        {phase === "main" && (
          <div className="pt-2 mt-1 border-t border-border/60">
            {MAIN_ZAP_STEPS.map((st) => {
              const keys = mainStepKeys(st);
              const done = keys.filter(({ key, kind }) => (kind === "check" ? state[key]?.v === true : str(state, key) !== "")).length;
              return (
                <a key={st.id} href={`#step-${st.id}`} className="flex items-center gap-2 px-2.5 py-1 rounded-lg text-xs hover:bg-surface2 transition-colors">
                  <span className={cn("w-1.5 h-1.5 rounded-full shrink-0", done === keys.length ? "bg-ok" : done > 0 ? "bg-accent" : "bg-slate-300")} />
                  <span className="flex-1 truncate text-ink/80">{st.step === st.title ? st.step : `${st.step} · ${st.title}`}</span>
                </a>
              );
            })}
          </div>
        )}
      </aside>

      <section className="card p-5 min-w-0">
        <div className="mb-4">
          <h2 className="text-lg font-semibold">{phaseTitle[phase].title}</h2>
          <p className="text-xs text-muted mt-0.5">{phaseTitle[phase].sub}</p>
        </div>

        {state[HOLD_KEY]?.v === true && (
          <div className="mb-4">
            <SoftLock>
              On hold since {relativeTime(state[HOLD_KEY].at)}
              {str(state, HOLD_NOTE_KEY) ? ` — ${str(state, HOLD_NOTE_KEY)}` : ""}. Boxes still tick; the list dims this
              client and leaves it out of the nudge list.
            </SoftLock>
          </div>
        )}

      {phase === "access" && (
        <div className="space-y-3">
          {ACCESS_ITEMS.map((it) => <AccessCard key={it.id} item={it} ctx={ctx} />)}
        </div>
      )}

      {phase === "main" && (
        <div className="space-y-3">
          {p.accessCleared < p.accessTotal && (
            <SoftLock>Access isn&apos;t fully cleared ({p.accessCleared}/{p.accessTotal}). You can build ahead, but don&apos;t go live yet.</SoftLock>
          )}
          <TextField ctx={ctx} k={zapUrlKey("main")} placeholder="Zap URL once it exists" small />
          {MAIN_ZAP_STEPS.map((st) => <MainStepCard key={st.id} st={st} ctx={ctx} provider={provider} />)}
          <FailureModes />
        </div>
      )}

      {phase === "setup" && (
        <div className="space-y-4">
          {p.accessCleared < p.accessTotal && (
            <SoftLock>Access isn&apos;t fully cleared ({p.accessCleared}/{p.accessTotal}). You can build ahead, but don&apos;t go live yet.</SoftLock>
          )}

          <Group title="Other zaps">
            {ZAPS.filter((z) => z.id !== "main").map((z) => (
              <div key={z.id} className="space-y-1.5">
                <CheckRow ctx={ctx} k={zapBuiltKey(z.id)} label={<><span className="font-medium">{z.name(provider || "{Provider}")}</span> built &amp; turned on</>} hint={z.blurb} />
                <div className="pl-7">
                  <TextField ctx={ctx} k={zapUrlKey(z.id)} placeholder="Zap URL" small />
                </div>
              </div>
            ))}
          </Group>

          <Group title="Our Slack channels">
            {SLACK_CHANNELS.map((c) => (
              <CheckRow key={c.id} ctx={ctx} k={slackKey(c.id)} label={<ChannelName name={`${slug || "{provider}"}-${c.suffix}`} />} hint={c.blurb} />
            ))}
          </Group>

          <ClientDelivery ctx={ctx} slug={slug} />
        </div>
      )}

      {phase === "test" && (
        <div className="space-y-3">
          {(p.accessCleared < p.accessTotal || p.mainDone < p.mainTotal || p.setupDone < p.setupTotal) && (
            <SoftLock>The build isn&apos;t finished yet — results here won&apos;t mean much until the zaps and channels are in place.</SoftLock>
          )}
          <div className="text-xs text-muted">
            Submit each case through the client&apos;s live Typeform, then check every expected result. {TEST_PHONE_NOTE}
          </div>
          {testCases(slug).map((tc, i) => <TestCard key={tc.id} n={i + 1} tc={tc} ctx={ctx} />)}
        </div>
      )}
      </section>
    </div>
  );
}

// ---------------------------------------------------------------------------

interface Ctx {
  state: OnboardingState;
  set: (key: string, value: EntryValue) => void;
  canEdit: boolean;
  nameOf: (id: string | null) => string;
}

const str = (s: OnboardingState, k: string) => (typeof s[k]?.v === "string" ? (s[k].v as string) : "");

const STATUS_PILL: Record<AccessStatus, { label: string; cls: string }> = {
  not_started: { label: "Not started", cls: "border-border bg-surface2 text-muted" },
  in_progress: { label: "In progress", cls: "border-accent/20 bg-accent/5 text-accent" },
  cleared: { label: "Cleared", cls: "border-ok/30 bg-ok/10 text-ok" },
  blocked: { label: "Blocked", cls: "border-urgent/30 bg-urgent/10 text-urgent" }
};

function AccessCard({ item, ctx }: { item: AccessItem; ctx: Ctx }) {
  const status = accessStatus(ctx.state, item);
  const blocked = status === "blocked";
  const note = str(ctx.state, noteKey(item.id));
  const [showNote, setShowNote] = useState(blocked || !!note);
  const pill = STATUS_PILL[status];

  return (
    <div className={cn("rounded-xl border p-3", blocked ? "border-urgent/30 bg-urgent/[0.03]" : "border-border")}>
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-sm font-medium">{item.label}</div>
          <div className="text-xs text-muted mt-0.5">{item.blurb}</div>
        </div>
        <span className={cn("shrink-0 px-2 py-0.5 rounded-full text-[11px] font-medium border", pill.cls)}>{pill.label}</span>
      </div>

      <div className="mt-3 space-y-2">
        {item.choice && (
          <div>
            <div className="text-[11px] text-muted mb-1">{item.choice.label}</div>
            <Segmented ctx={ctx} k={item.choice.key} options={item.choice.options} />
          </div>
        )}
        {item.checks.map((c) => <CheckRow key={c.key} ctx={ctx} k={c.key} label={c.label} hint={c.hint} />)}
        {item.inputs?.map((inp) => (
          <div key={inp.key}>
            <div className="text-[11px] text-muted mb-1">{inp.label}</div>
            <TextField ctx={ctx} k={inp.key} placeholder={inp.placeholder} small />
          </div>
        ))}
      </div>

      <div className="mt-3 pt-2 border-t border-border/60 flex items-center gap-3 text-xs">
        {ctx.canEdit && (
          <button
            type="button"
            onClick={() => { ctx.set(blockedKey(item.id), !blocked); if (!blocked) setShowNote(true); }}
            className={cn("inline-flex items-center gap-1", blocked ? "text-ok hover:underline" : "text-urgent/80 hover:text-urgent")}
          >
            <AlertTriangle className="w-3.5 h-3.5" />
            {blocked ? "Unblock" : "Mark blocked"}
          </button>
        )}
        {!showNote && ctx.canEdit && (
          <button type="button" onClick={() => setShowNote(true)} className="text-muted hover:text-ink">Add note</button>
        )}
        {blocked && <span className="text-muted">Escalate it yourself — nobody is alerted.</span>}
      </div>
      {showNote && (
        <div className="mt-2">
          <TextField ctx={ctx} k={noteKey(item.id)} placeholder={blocked ? "What failed, and who you've escalated to" : "Note"} small />
        </div>
      )}
    </div>
  );
}

function ClientDelivery({ ctx, slug }: { ctx: Ctx; slug: string }) {
  const channel = str(ctx.state, "access.notify.channel");
  const target = str(ctx.state, "access.notify.target");
  return (
    <Group title={`Client delivery${channel ? ` — ${channel}` : ""}${target ? ` (${target})` : ""}`}>
      {!channel && <div className="text-xs text-muted">Pick the client&apos;s notification channel under Access → Notifications first.</div>}
      {channel === "slack" && CLIENT_STREAMS.map((c) => (
        <CheckRow key={c.id} ctx={ctx} k={clientKey("slack", c.id)}
          label={<>Created <ChannelName name={`${slug || "{provider}"}-${c.suffix}`} /> on their Slack</>}
          hint={`${c.blurb}. Same setup as ours — no failsafe channel on their side.`} />
      ))}
      {channel === "email" && CLIENT_STREAMS.map((c) => (
        <CheckRow key={c.id} ctx={ctx} k={clientKey("email", c.id)}
          label={<>Email set up for: {c.blurb.toLowerCase()}</>}
          hint="Uses the same template as the Slack message." />
      ))}
      {channel === "other" && (
        <CheckRow ctx={ctx} k={CLIENT_OTHER_KEY} label="Lead + booking notifications wired to their channel" hint="Same template as the Slack message." />
      )}
    </Group>
  );
}

function TestCard({ n, tc, ctx }: { n: number; tc: TestCase; ctx: Ctx }) {
  const result = str(ctx.state, testResultKey(tc.id));
  const [open, setOpen] = useState(false);
  const answers = caseAnswers(tc);
  const entry = ctx.state[testResultKey(tc.id)];

  function copyAnswers() {
    const text = answers.map(({ q, a }) => `${q}\n${a}`).join("\n\n");
    navigator.clipboard.writeText(text).then(() => toast.success("Answers copied"), () => toast.error("Couldn't copy"));
  }

  const options: { v: string; label: string; cls: string }[] = [
    { v: "pass", label: "Pass", cls: "border-ok/40 bg-ok/10 text-ok" },
    { v: "fail", label: "Fail", cls: "border-urgent/40 bg-urgent/10 text-urgent" },
    ...(tc.optional ? [{ v: "na", label: "N/A", cls: "border-border bg-surface2 text-ink" }] : [])
  ];

  return (
    <div className={cn("rounded-xl border", result === "fail" ? "border-urgent/30" : result === "pass" ? "border-ok/30" : "border-border")}>
      <div className="flex items-center gap-3 p-3">
        <button type="button" onClick={() => setOpen(!open)} className="flex-1 min-w-0 text-left flex items-center gap-2">
          <ChevronDown className={cn("w-4 h-4 text-muted shrink-0 transition-transform", !open && "-rotate-90")} />
          <span className="text-xs text-muted w-4">{n}</span>
          <span className="text-sm font-medium truncate">{tc.title}</span>
        </button>
        <div className="flex items-center gap-1 shrink-0">
          {options.map((o) => (
            <button
              key={o.v}
              type="button"
              disabled={!ctx.canEdit}
              onClick={() => ctx.set(testResultKey(tc.id), result === o.v ? "" : o.v)}
              className={cn(
                "px-2 py-0.5 rounded-full text-[11px] font-medium border transition-colors",
                result === o.v ? o.cls : "border-border text-muted hover:bg-surface2"
              )}
            >
              {o.label}
            </button>
          ))}
        </div>
      </div>
      {result && entry && (
        <div className="px-3 -mt-2 pb-2 pl-12 text-[11px] text-muted">{ctx.nameOf(entry.by)} · {relativeTime(entry.at)}</div>
      )}

      {open && (
        <div className="px-3 pb-3 pl-12 space-y-3 text-xs">
          <div className="text-muted">{tc.why}{tc.optional ? ` ${tc.optional}` : ""}</div>

          {tc.steps && (
            <ol className="list-decimal pl-4 space-y-0.5">{tc.steps.map((s) => <li key={s}>{s}</li>)}</ol>
          )}

          {tc.answers && (
            <div>
              <div className="flex items-center justify-between mb-1">
                <div className="label mb-0">Typeform answers</div>
                <button type="button" onClick={copyAnswers} className="inline-flex items-center gap-1 text-accent hover:underline">
                  <Copy className="w-3 h-3" /> Copy
                </button>
              </div>
              <div className="rounded-lg border border-border divide-y divide-border/60">
                {answers.map(({ q, a }) => {
                  const changed = tc.answers?.[q] !== undefined;
                  return (
                    <div key={q} className={cn("grid grid-cols-[1fr_auto] gap-3 px-2 py-1", changed && "bg-amber-50")}>
                      <span className="text-muted">{q}</span>
                      <span className={cn("text-right", changed && "font-medium", a === "(skip)" && "italic text-muted")}>{a}</span>
                    </div>
                  );
                })}
              </div>
              <div className="text-[11px] text-muted mt-1">Highlighted rows differ from the default answers.</div>
            </div>
          )}

          <div>
            <div className="label">Expect</div>
            <ul className="space-y-1">
              {tc.expect.map((e) => (
                <li key={e} className="flex gap-2"><Check className="w-3.5 h-3.5 text-muted shrink-0 mt-0.5" />{e}</li>
              ))}
            </ul>
          </div>

          <TextField ctx={ctx} k={testNoteKey(tc.id)} placeholder={result === "fail" ? "What went wrong" : "Note (optional)"} small />
        </div>
      )}
    </div>
  );
}

function MainStepCard({ st, ctx, provider }: { st: MainZapStep; ctx: Ctx; provider: string }) {
  const keys = mainStepKeys(st);
  const done = keys.filter(({ key, kind }) => (kind === "check" ? ctx.state[key]?.v === true : str(ctx.state, key) !== "")).length;
  const full = done === keys.length;
  // Open the steps still in play; finished ones fold away.
  const [open, setOpen] = useState(!full);

  return (
    <div id={`step-${st.id}`} className={cn("rounded-xl border scroll-mt-4 transition-colors", full ? "border-ok/30" : "border-border")}>
      <button type="button" onClick={() => setOpen(!open)} className="w-full flex items-center gap-2 p-3 text-left">
        <ChevronDown className={cn("w-4 h-4 text-muted shrink-0 transition-transform", !open && "-rotate-90")} />
        <span className="text-[11px] uppercase tracking-wide text-muted w-24 shrink-0">{st.step}</span>
        <span className="text-sm font-medium flex-1 min-w-0 truncate">{st.title}</span>
        <span className={cn("text-[11px] shrink-0 inline-flex items-center gap-1", full ? "text-ok" : "text-muted")}>
          {full && <Check className="w-3.5 h-3.5" />}{done}/{keys.length}
        </span>
      </button>

      {open && (
        <div className="px-3 pb-3 pl-9 space-y-2.5">
          {st.blurb && <div className="text-xs text-muted">{fillTokens(st.blurb, provider)}</div>}
          {st.checks.map((c) => (
            <CheckRow key={c.key} ctx={ctx} k={mainKey(st.id, c.key)} label={fillTokens(c.label, provider)} hint={c.hint} />
          ))}
          {st.choices?.map((c) => (
            <div key={c.key}>
              <div className="text-[11px] text-muted mb-1">{c.label}</div>
              <Segmented ctx={ctx} k={mainKey(st.id, c.key)} options={c.options} />
            </div>
          ))}
          {st.inputs?.map((i) => (
            <div key={i.key}>
              <div className="text-[11px] text-muted mb-1">{i.label}</div>
              <TextField ctx={ctx} k={mainKey(st.id, i.key)} placeholder={i.placeholder} small />
            </div>
          ))}
          {st.copies?.map((c) => <CopyBlock key={c.label} label={c.label} text={fillTokens(c.text, provider)} />)}
          {st.warn && (
            <div className="flex items-start gap-2 rounded-lg border border-warn/30 bg-warn/5 px-2.5 py-1.5 text-[11px] text-warn">
              <AlertTriangle className="w-3.5 h-3.5 mt-px shrink-0" />{st.warn}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function CopyBlock({ label, text }: { label: string; text: string }) {
  return (
    <div>
      <div className="flex items-center justify-between mb-1">
        <span className="text-[11px] text-muted">{label}</span>
        <button
          type="button"
          onClick={() => navigator.clipboard.writeText(text).then(() => toast.success("Copied"), () => toast.error("Couldn't copy"))}
          className="inline-flex items-center gap-1 text-[11px] text-accent hover:underline"
        >
          <Copy className="w-3 h-3" /> Copy
        </button>
      </div>
      <pre className="text-[11px] font-mono bg-surface2 border border-border rounded-lg p-2 overflow-x-auto whitespace-pre max-h-56">{text.replace(/\t/g, "  ·  ")}</pre>
    </div>
  );
}

function FailureModes() {
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded-xl border border-dashed border-border">
      <button type="button" onClick={() => setOpen(!open)} className="w-full flex items-center gap-2 p-3 text-left">
        <ChevronDown className={cn("w-4 h-4 text-muted shrink-0 transition-transform", !open && "-rotate-90")} />
        <Wrench className="w-3.5 h-3.5 text-muted" />
        <span className="text-sm font-medium">Common failure modes</span>
      </button>
      {open && (
        <div className="px-3 pb-3 pl-9">
          <div className="rounded-lg border border-border divide-y divide-border/60 text-xs">
            {MAIN_ZAP_FAILURES.map((f) => (
              <div key={f.symptom} className="grid grid-cols-[minmax(0,2fr)_minmax(0,3fr)] gap-3 px-2.5 py-1.5">
                <span className="font-medium">{f.symptom}</span>
                <span className="text-muted">{f.cause}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Primitives

// A whole-row toggle with a custom box. The tick animates in on the same
// frame as the click; the who/when stamp sits on the right so ticking a row
// never changes its height.
function CheckRow({ ctx, k, label, hint }: { ctx: Ctx; k: string; label: React.ReactNode; hint?: string }) {
  const entry = ctx.state[k];
  const on = entry?.v === true;
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={on}
      disabled={!ctx.canEdit}
      onClick={() => ctx.set(k, !on)}
      className={cn(
        "w-full flex items-start gap-2.5 text-sm text-left rounded-lg -mx-1.5 px-1.5 py-1 transition-colors duration-150",
        ctx.canEdit ? "hover:bg-surface2 active:bg-surface2/80" : "cursor-default"
      )}
    >
      <span
        className={cn(
          "mt-0.5 w-4 h-4 shrink-0 rounded-[5px] border grid place-items-center transition-all duration-150",
          on ? "bg-ok border-ok scale-100" : "bg-surface border-slate-300"
        )}
      >
        <Check className={cn("w-3 h-3 text-white transition-all duration-150", on ? "opacity-100 scale-100" : "opacity-0 scale-50")} strokeWidth={3} />
      </span>
      <span className="flex-1 min-w-0">
        <span className={cn("transition-colors duration-150", on ? "text-muted line-through decoration-muted/40" : "text-ink")}>{label}</span>
        {hint && <span className="block text-[11px] text-muted">{hint}</span>}
      </span>
      <span className={cn("shrink-0 text-[11px] text-ok whitespace-nowrap mt-0.5 transition-opacity duration-150", on && entry ? "opacity-100" : "opacity-0")}>
        {on && entry ? `${ctx.nameOf(entry.by)} · ${relativeTime(entry.at)}` : "\u00a0"}
      </span>
    </button>
  );
}

function Segmented({ ctx, k, options }: { ctx: Ctx; k: string; options: { value: string; label: string }[] }) {
  const cur = str(ctx.state, k);
  return (
    <div className="flex flex-wrap gap-1.5">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          disabled={!ctx.canEdit}
          onClick={() => ctx.set(k, o.value)}
          className={cn(
            "px-2.5 py-1 rounded-full text-xs border transition-colors",
            cur === o.value ? "border-accent/40 bg-accent/10 text-accent font-medium" : "border-border text-muted hover:bg-surface2"
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

// Saves on blur / Enter. Re-keyed on the stored value so an external update
// (e.g. the POST seeding the provider name) replaces a stale draft.
function TextField({ ctx, k, placeholder, small, bare }: { ctx: Ctx; k: string; placeholder?: string; small?: boolean; bare?: boolean }) {
  const stored = str(ctx.state, k);
  return <TextFieldInner key={stored} stored={stored} ctx={ctx} k={k} placeholder={placeholder} small={small} bare={bare} />;
}

function TextFieldInner({ stored, ctx, k, placeholder, small, bare }: { stored: string; ctx: Ctx; k: string; placeholder?: string; small?: boolean; bare?: boolean }) {
  const [draft, setDraft] = useState(stored);
  const commit = () => { if (draft.trim() !== stored) ctx.set(k, draft.trim()); };
  return (
    <input
      className={bare
        ? "w-full bg-transparent text-base font-semibold text-ink placeholder:text-muted/60 placeholder:font-normal rounded-md -mx-1 px-1 py-0.5 hover:bg-surface2 focus:bg-surface2 focus:outline-none transition-colors"
        : cn("input", small && "py-1 text-xs")}
      value={draft}
      placeholder={placeholder}
      disabled={!ctx.canEdit}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
    />
  );
}

// A span, not a button — it sits inside CheckRow's button.
function ChannelName({ name }: { name: string }) {
  return (
    <span
      role="button"
      tabIndex={0}
      onClick={(e) => { e.stopPropagation(); navigator.clipboard.writeText(name).then(() => toast.success(`Copied ${name}`)); }}
      className="font-mono text-xs px-1.5 py-0.5 rounded bg-surface2 border border-border hover:border-accent/40 cursor-copy"
      title="Copy channel name"
    >
      #{name}
    </span>
  );
}

function Group({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="label">{title}</div>
      <div className="rounded-xl border border-border p-3 space-y-3">{children}</div>
    </div>
  );
}

// Onboarding-level status: who the ball is with, and whether the whole thing
// is parked. Lives in the rail rather than a phase body because it applies in
// every stage — a phase body would read as scoped to that phase.
function FlowControls({ ctx }: { ctx: Ctx }) {
  const waiting = str(ctx.state, WAITING_ON_KEY);
  const held = ctx.state[HOLD_KEY]?.v === true;
  const heldAt = ctx.state[HOLD_KEY]?.at ?? null;
  const holdNoteText = str(ctx.state, HOLD_NOTE_KEY);
  const [showHoldNote, setShowHoldNote] = useState(held || !!holdNoteText);

  return (
    <div className="px-2 py-2.5 border-y border-border/60 space-y-2.5">
      <div className="text-[11px] uppercase tracking-wide text-muted">Status</div>

      <div>
        <div className="text-[11px] text-muted mb-1">Waiting on</div>
        <Segmented
          ctx={ctx}
          k={WAITING_ON_KEY}
          options={[
            { value: "", label: "No one" },
            { value: "us", label: "Us" },
            { value: "client", label: "Client" }
          ]}
        />
        {waiting && (
          <div className="mt-1.5">
            <TextField
              ctx={ctx}
              k={WAITING_NOTE_KEY}
              small
              placeholder={waiting === "client" ? "What we've asked them for" : "What we owe them"}
            />
          </div>
        )}
      </div>

      <div>
        {ctx.canEdit && (
          <button
            type="button"
            // No-op when the value already matches: the PATCH route stamps
            // `at` on every write, so re-setting true would reset "held since".
            onClick={() => {
              if (held) { ctx.set(HOLD_KEY, false); return; }
              ctx.set(HOLD_KEY, true);
              setShowHoldNote(true);
            }}
            className={cn(
              "w-full inline-flex items-center gap-1.5 rounded-lg border px-2 py-1.5 text-xs transition-colors",
              held ? "border-stalled/40 bg-stalled/10 text-stalled" : "border-border text-muted hover:bg-surface2 hover:text-ink"
            )}
          >
            {held ? <Play className="w-3.5 h-3.5" /> : <Pause className="w-3.5 h-3.5" />}
            {held ? "Resume" : "Put on hold"}
            {held && heldAt && <span className="ml-auto text-[11px]">{relativeTime(heldAt)}</span>}
          </button>
        )}
        {showHoldNote && (
          <div className="mt-1.5">
            <TextField ctx={ctx} k={HOLD_NOTE_KEY} small placeholder="Why it's paused, and what unpauses it" />
          </div>
        )}
      </div>
    </div>
  );
}

function SoftLock({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-2 rounded-xl border border-warn/30 bg-warn/5 px-3 py-2 text-xs text-warn">
      <Lock className="w-3.5 h-3.5 mt-0.5 shrink-0" />
      <span>{children}</span>
    </div>
  );
}
