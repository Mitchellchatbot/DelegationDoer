"use client";

import { useEffect, useLayoutEffect, useRef, useState, useCallback, useMemo, createContext, useContext } from "react";
import { Check, Clock, Minus, X, AlertTriangle, Plus, Bell, ArrowLeft, Focus, Coffee, Moon, Smile, Sparkles, Play, Square, Crown, Settings as SettingsIcon, LogOut, Camera, Mail, ScanText, LifeBuoy } from "lucide-react";
import { toast } from "sonner";
import { AvatarCropper } from "@/components/AvatarCropper";
import { Countdown } from "@/components/Countdown";
import { PersonAvatar } from "@/components/PersonAvatar";
import { MediaPicker } from "@/components/MediaPicker";
import { assignableTargets, assignableDepartments, canChooseDepartment, isLeader, isHead } from "@/lib/auth";
import { TAG_PRESETS } from "@/lib/mock-data";
import { findFirstImage, requestAttachmentAnalysis, buildAnalyzeNotice } from "@/lib/attachment-analysis";
import type { TaskMedia, User, Department } from "@/lib/types";

interface WidgetTask {
  id: string;
  title: string;
  description?: string | null;
  priority: "low" | "medium" | "high" | "critical";
  status: string;
  dueDate: string | null;
  estimatedHours: number;
  // Truth-value actual hours: server-side override-wins (override ??
  // time_entries-derived denorm). Drives "logged 1.5h" displays.
  actualHours?: number;
  actualHoursOverride?: number | null;
  inactiveFlag: boolean;
  needsAck: boolean;
}

interface WidgetKudos {
  id: string;
  message: string;
  emoji: string;
  createdAt: string;
  from: { name: string; avatarUrl: string | null } | null;
}

interface WidgetNotification {
  id: string;
  taskId: string;
  taskTitle: string;
  taskPriority: "low" | "medium" | "high" | "critical" | string;
  taskStatus: string;
  taskDueDate: string | null;
  kind: "mention" | "notified";
  note: string | null;
  from: { name: string; avatarUrl: string | null } | null;
  createdAt: string;
}

interface WidgetEmail {
  id: string;
  accountId: string;
  threadId: string;
  subject: string | null;
  fromName: string | null;
  fromEmail: string | null;
  preview: string | null;
  receivedAt: string;
}

interface WidgetSupport {
  id: string;
  conversationId: string;
  contactName: string | null;
  phone: string | null;
  preview: string | null;
  receivedAt: string;
}

// The Customer Support inbox selects a conversation via client state only —
// there's no per-conversation URL param — so the deep link just opens the tab.
const SUPPORT_PATH = "/customer-support";

// Canonical inbox deep link — opens the thread in the reading pane. Mirrors the
// legacy redirect at inboxes/[accountId]/threads/[threadId]/page.tsx; InboxSplit
// hydrates the pane from the `thread` + `acct` query params (both required).
function inboxThreadPath(accountId: string, threadId: string) {
  const a = encodeURIComponent(accountId);
  return `/inboxes/${a}?thread=${encodeURIComponent(threadId)}&acct=${a}`;
}

interface EomState {
  // Whether the *current user* is the Employee of the Month right now.
  // Drives the crown overlay on the bubble + the celebration banner.
  isMe: boolean;
  // Holder's name + month for the banner copy.
  name: string | null;
  month: string | null;
}

type WidgetState = "bubble" | "alert" | "panel";

const PRIORITY_RANK: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };

// Two-tone alarm via the Web Audio API. No asset file needed; works inside
// Electron's renderer without microphone-style permissions.
function playAlertSound() {
  try {
    const Ctx = (window as any).AudioContext || (window as any).webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    const tone = (freq: number, when: number, duration: number) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.setValueAtTime(freq, ctx.currentTime + when);
      gain.gain.setValueAtTime(0.0001, ctx.currentTime + when);
      gain.gain.exponentialRampToValueAtTime(0.35, ctx.currentTime + when + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + when + duration);
      osc.connect(gain).connect(ctx.destination);
      osc.start(ctx.currentTime + when);
      osc.stop(ctx.currentTime + when + duration);
    };
    tone(880, 0,    0.22);
    tone(660, 0.16, 0.22);
    tone(880, 0.32, 0.22);
    setTimeout(() => ctx.close(), 800);
  } catch { /* renderer doesn't support audio context */ }
}

// Coronation fanfare for "you just got crowned Employee of the Month".
// Bigger, more triumphant than the kudos chime — three rising chords
// with overlap so it actually feels like an event.
function playCoronationFanfare() {
  try {
    const Ctx = (window as any).AudioContext || (window as any).webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    const chord = (freqs: number[], when: number, dur: number) => {
      for (const f of freqs) {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = "triangle";
        osc.frequency.setValueAtTime(f, ctx.currentTime + when);
        gain.gain.setValueAtTime(0.0001, ctx.currentTime + when);
        gain.gain.exponentialRampToValueAtTime(0.18, ctx.currentTime + when + 0.04);
        gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + when + dur);
        osc.connect(gain).connect(ctx.destination);
        osc.start(ctx.currentTime + when);
        osc.stop(ctx.currentTime + when + dur);
      }
    };
    // C major → F → G → C, classic V-I lift.
    chord([523.25, 659.25, 783.99], 0,    0.45);
    chord([587.33, 698.46, 880.00], 0.20, 0.45);
    chord([659.25, 783.99, 987.77], 0.40, 0.55);
    chord([523.25, 659.25, 783.99, 1046.50], 0.65, 1.20);
    setTimeout(() => ctx.close(), 2200);
  } catch { /* ignore */ }
}

// Celebratory rising chime for kudos. Different from the task alarm so
// you can tell at a glance whether the widget is shouting at you (task)
// or hugging you (kudos).
function playKudosChime() {
  try {
    const Ctx = (window as any).AudioContext || (window as any).webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    const tone = (freq: number, when: number, duration: number) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "triangle";
      osc.frequency.setValueAtTime(freq, ctx.currentTime + when);
      gain.gain.setValueAtTime(0.0001, ctx.currentTime + when);
      gain.gain.exponentialRampToValueAtTime(0.3, ctx.currentTime + when + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + when + duration);
      osc.connect(gain).connect(ctx.destination);
      osc.start(ctx.currentTime + when);
      osc.stop(ctx.currentTime + when + duration);
    };
    // C5 → E5 → G5 ascending major triad — happy.
    tone(523.25, 0,     0.18);
    tone(659.25, 0.10,  0.18);
    tone(783.99, 0.20,  0.30);
    setTimeout(() => ctx.close(), 700);
  } catch { /* ignore */ }
}

// Email "ping" — softer than the task alarm, brighter than the kudos
// chime. Two close-spaced bell tones so it's recognizably an inbox
// sound at a glance.
function playEmailChime() {
  try {
    const Ctx = (window as any).AudioContext || (window as any).webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    const tone = (freq: number, when: number, duration: number) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.setValueAtTime(freq, ctx.currentTime + when);
      gain.gain.setValueAtTime(0.0001, ctx.currentTime + when);
      gain.gain.exponentialRampToValueAtTime(0.22, ctx.currentTime + when + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + when + duration);
      osc.connect(gain).connect(ctx.destination);
      osc.start(ctx.currentTime + when);
      osc.stop(ctx.currentTime + when + duration);
    };
    // B5 → E6 — quick inbox-style "ding-ding".
    tone(987.77, 0,    0.16);
    tone(1318.5, 0.13, 0.26);
    setTimeout(() => ctx.close(), 700);
  } catch { /* ignore */ }
}

export default function WidgetPage() {
  const [state, setState] = useState<WidgetState>("bubble");
  const [tasks, setTasks] = useState<WidgetTask[]>([]);
  const [kudos, setKudos] = useState<WidgetKudos[]>([]);
  const [notifications, setNotifications] = useState<WidgetNotification[]>([]);
  const [emails, setEmails] = useState<WidgetEmail[]>([]);
  const [support, setSupport] = useState<WidgetSupport[]>([]);
  // Tracks whether the widget's API polls are returning 401. When true
  // we render a sign-in prompt instead of the normal task/kudos UI.
  const [signedOut, setSignedOut] = useState(false);
  const [eom, setEom] = useState<EomState>({ isMe: false, name: null, month: null });
  // Birthdays: who's celebrating today (year-agnostic match), plus whether
  // the current user has filled in their own bday. Drives a celebratory
  // banner and a one-time prompt card respectively.
  const [birthdays, setBirthdays] = useState<{
    hasBirthday: boolean;
    celebrantsToday: { id: string; name: string; avatarUrl: string | null; isMe: boolean }[];
  }>({ hasBirthday: true, celebrantsToday: [] });
  // Per-user customization for the bubble image. Falls back to the
  // shared brand logo when null. Fetched once on auth + whenever the
  // settings view saves.
  const [widgetIconUrl, setWidgetIconUrl] = useState<string | null>(null);
  // Mandatory end-of-day client check-in reminder (Website team / leader
  // / admin). Polled alongside tasks; when due=true we surface a toast
  // every poll (15s) and the bubble gets a violet pulse ring so it's
  // visually unmistakable even when collapsed.
  const [eodReminderDue, setEodReminderDue] = useState(false);
  const eodReminderToastShownRef = useRef(false);
  // On-shift state for the bubble's online dot. Polled alongside the
  // other 15s fetches in fetchTasks below so the bubble shows the
  // green dot in sync with the panel's ClockSection.
  const [onShift, setOnShift] = useState(false);
  const fetchMe = useCallback(async () => {
    try {
      const r = await fetch("/api/users/me", { cache: "no-store" });
      if (!r.ok) return;
      const d = await r.json();
      setWidgetIconUrl(d.user?.widgetIconUrl ?? null);
    } catch { /* leave default */ }
  }, []);
  useEffect(() => { void fetchMe(); }, [fetchMe]);
  const seenIdsRef = useRef<Set<string>>(new Set());
  const seenKudosRef = useRef<Set<string>>(new Set());
  const seenNotifIdsRef = useRef<Set<string>>(new Set());
  const seenEmailIdsRef = useRef<Set<string>>(new Set());
  const seenSupportIdsRef = useRef<Set<string>>(new Set());
  // Freshness high-water marks (ms since epoch). The seen*IdsRef sets above are
  // rebuilt every poll from only the fetched window (newest N unseen by
  // received_at desc), so an OLD unseen row that later slides into that window —
  // e.g. after dismissing a newer one when >N are unseen — would look brand-new
  // and wrongly re-chime/re-notify. Gating freshness on received_at being newer
  // than everything seen so far prevents that. Start at 0 so the first poll still
  // primes exactly as before (all rows count as fresh once).
  const emailHighWaterRef = useRef<number>(0);
  const supportHighWaterRef = useRef<number>(0);
  // Client meetings we've already fired a ~30-min reminder for this session.
  // Belt-and-suspenders on top of the server-side dedup table.
  const seenMeetingEventIdsRef = useRef<Set<string>>(new Set());
  // First successful poll only primes the seen* sets — it must NOT fire OS
  // notifications, or every pre-existing task/mention/email would toast on
  // launch (the old main.js used `lastTaskIds.size > 0` for the same reason).
  // Reset on sign-out so a later account switch re-baselines silently too.
  const notifsPrimedRef = useRef(false);
  const seenEomMonthRef = useRef<string | null>(null);
  const lastFetchedRef = useRef<number>(0);

  // Make the BrowserWindow's transparent flag actually show through, and
  // lock document scroll — the window is exactly the size of its content.
  useEffect(() => {
    document.documentElement.style.background = "transparent";
    document.body.style.background = "transparent";
    document.documentElement.style.overflow = "hidden";
    document.body.style.overflow = "hidden";
  }, []);

  // Push the renderer's logical state to the main process so it resizes the
  // BrowserWindow accordingly.
  useEffect(() => {
    (window as any).widgetAPI?.setState?.(state);
  }, [state]);

  // Tray menu can still drive expansion remotely.
  useEffect(() => {
    (window as any).widgetAPI?.onSetExpanded?.((v: boolean) => {
      setState(v ? "panel" : "bubble");
    });
  }, []);

  const fetchTasks = useCallback(async () => {
    try {
      // Lead request first, awaited on its own: it's a single pass through
      // middleware, so it alone performs any Supabase token refresh. The
      // parallel batch below then runs against the freshly-rotated cookie and
      // triggers no second refresh. Firing all seven at once used to race the
      // refresh across separate responses, corrupt the auth cookie, and log
      // the widget out every few minutes.
      const taskRes = await fetch("/api/widget/my-tasks", { cache: "no-store" });
      // 401 → no session in this Electron renderer. Show the sign-in
      // prompt and stop trying to render normal UI on stale/empty data.
      if (taskRes.status === 401) {
        setSignedOut(true);
        notifsPrimedRef.current = false;
        setState((prev) => prev === "panel" ? "panel" : "bubble");
        return;
      }
      if (!taskRes.ok) return;

      // The rest are independent reads — safe to run in parallel now that the
      // session cookie is already fresh.
      const [kudosRes, eomRes, bdayRes, eodRes, clockRes, emailRes, meetingRes, supportRes] = await Promise.all([
        fetch("/api/widget/kudos", { cache: "no-store" }),
        fetch("/api/eom", { cache: "no-store" }),
        fetch("/api/widget/birthdays", { cache: "no-store" }),
        fetch("/api/widget/eod-reminder", { cache: "no-store" }),
        fetch("/api/clock", { cache: "no-store" }),
        fetch("/api/email-notifications?unseenOnly=1&limit=20", { cache: "no-store" }),
        fetch("/api/widget/meeting-reminder", { cache: "no-store" }),
        fetch("/api/support-notifications?limit=5", { cache: "no-store" })
      ]);
      if (clockRes.ok) {
        const c = await clockRes.json().catch(() => null);
        setOnShift(!!c?.open);
      }
      setSignedOut(false);
      const taskData = await taskRes.json();
      const next: WidgetTask[] = taskData.tasks ?? [];
      const unackedNow = next.filter((t) => t.needsAck);
      const nextNotifs: WidgetNotification[] = taskData.notifications ?? [];

      const kudosData = kudosRes.ok ? await kudosRes.json() : { kudos: [] };
      const nextKudos: WidgetKudos[] = kudosData.kudos ?? [];

      // Employee of the Month — celebrate the first time we see "isMe"
      // for a fresh month. Also drive the bubble crown overlay.
      if (eomRes.ok) {
        const eomData = await eomRes.json();
        const month = eomData.month ?? null;
        const isMe = !!eomData.isMe;
        const name = eomData.eom?.name ?? null;
        // Fire the fanfare once per crowned-month for "me". Tracking by
        // month means re-crowning in the same month doesn't re-trigger,
        // but a fresh month will.
        if (isMe && month && seenEomMonthRef.current !== month) {
          seenEomMonthRef.current = month;
          playCoronationFanfare();
        }
        // Reset the ref when no longer EOM so a future re-crown fires.
        if (!isMe) seenEomMonthRef.current = null;
        setEom({ isMe, name, month });
      }

      // Pull unseen email notifications. We treat seen_at=null as the
      // "still actionable" set — once the user clicks "Got it" the row
      // gets stamped and disappears from the widget on the next poll.
      let nextEmails: WidgetEmail[] = [];
      if (emailRes.ok) {
        const emailData = await emailRes.json().catch(() => ({}));
        const all = (emailData?.notifications ?? []) as Array<{
          id: string; accountId: string; threadId: string; subject: string | null;
          fromName: string | null; fromEmail: string | null;
          preview: string | null; receivedAt: string; seenAt: string | null;
        }>;
        nextEmails = all
          .filter((r) => r.seenAt === null)
          .map((r) => ({
            id: r.id, accountId: r.accountId, threadId: r.threadId, subject: r.subject,
            fromName: r.fromName, fromEmail: r.fromEmail,
            preview: r.preview, receivedAt: r.receivedAt
          }));
      }

      // Unseen customer-support notifications — same seen_at=null "still
      // actionable" model as emails. Only support-visible users get rows.
      let nextSupport: WidgetSupport[] = [];
      if (supportRes.ok) {
        const supportData = await supportRes.json().catch(() => ({}));
        const all = (supportData?.notifications ?? []) as Array<{
          id: string; conversationId: string; contactName: string | null;
          phone: string | null; preview: string | null;
          receivedAt: string; seenAt: string | null;
        }>;
        nextSupport = all
          .filter((r) => r.seenAt === null)
          .map((r) => ({
            id: r.id, conversationId: r.conversationId, contactName: r.contactName,
            phone: r.phone, preview: r.preview, receivedAt: r.receivedAt
          }));
      }

      // Fresh task → harsh alarm. Fresh kudos → celebratory chime.
      // Fresh mention/notify → same harsh alarm so the user looks.
      // Fresh email → softer inbox ding, distinct from the task alarm.
      const fresh = unackedNow.filter((t) => !seenIdsRef.current.has(t.id));
      const freshNotifs = nextNotifs.filter((n) => !seenNotifIdsRef.current.has(n.id));
      if (fresh.length > 0 || freshNotifs.length > 0) playAlertSound();
      const freshKudos = nextKudos.filter((k) => !seenKudosRef.current.has(k.id));
      if (freshKudos.length > 0) playKudosChime();
      const freshEmails = nextEmails.filter(
        (e) => !seenEmailIdsRef.current.has(e.id)
          && new Date(e.receivedAt).getTime() > emailHighWaterRef.current
      );
      if (freshEmails.length > 0) playEmailChime();
      const freshSupport = nextSupport.filter(
        (s) => !seenSupportIdsRef.current.has(s.id)
          && new Date(s.receivedAt).getTime() > supportHighWaterRef.current
      );
      if (freshSupport.length > 0) playEmailChime();

      // OS-level system notifications (Electron only). The main process
      // delivers them — native on Windows, node-notifier on macOS. We drive
      // it from here because this is the single place that knows what's fresh
      // (the seen*Ref dedup). Kudos stays sound-only by design.
      const notify = (window as any).widgetAPI?.notify;
      if (notify && notifsPrimedRef.current) {
        for (const t of fresh)
          notify({ title: "New task assigned", body: t.title });
        for (const n of freshNotifs)
          notify({
            title: n.kind === "mention"
              ? `${n.from?.name ?? "Someone"} mentioned you`
              : `${n.from?.name ?? "Someone"} pinged you on a task`,
            body: n.note ? `${n.taskTitle} — "${n.note}"` : n.taskTitle,
          });
        // Cap the burst: now that we fetch up to 20 unseen, a flood of new mail
        // (a sync backfill, a mailing) must not fire 20 native toasts at once.
        // Above a small threshold collapse to a single summary linking to inbox.
        if (freshEmails.length > 3) {
          notify({
            title: `${freshEmails.length} new emails`,
            body: "Open the widget to review them.",
            path: "/inboxes",
          });
        } else {
          for (const e of freshEmails)
            notify({
              title: "New email",
              body: `${e.fromName ?? e.fromEmail ?? "Someone"}: ${e.subject ?? "(no subject)"}`,
              path: inboxThreadPath(e.accountId, e.threadId),
            });
        }
        for (const s of freshSupport)
          notify({
            title: "New support message",
            body: `${s.contactName ?? s.phone ?? "Someone"}: ${s.preview ?? "(no preview)"}`,
            path: SUPPORT_PATH,
          });
      }
      notifsPrimedRef.current = true;

      // Client meeting starting in ~30 min → native heads-up that deep-links
      // to the Schedule tab (the prep panel auto-generates the brief on
      // arrival). The server dedups per (user, event), so each meeting fires
      // exactly once; we intentionally do NOT gate on notifsPrimedRef —
      // opening the widget shortly before a call should still warn you.
      if (meetingRes.ok) {
        const md = await meetingRes.json().catch(() => ({}));
        const dueMeetings = (md?.meetings ?? []) as Array<{
          id: string; clientName: string | null; summary: string;
        }>;
        const freshMeetings = dueMeetings.filter((m) => !seenMeetingEventIdsRef.current.has(m.id));
        if (notify) {
          for (const m of freshMeetings)
            notify({ title: "Client meeting in ~30 min", body: m.clientName ?? m.summary, path: "/schedule" });
        }
        if (freshMeetings.length > 0) playAlertSound();
        for (const m of freshMeetings) seenMeetingEventIdsRef.current.add(m.id);
      }

      seenIdsRef.current = new Set(unackedNow.map((t) => t.id));
      seenKudosRef.current = new Set(nextKudos.map((k) => k.id));
      seenNotifIdsRef.current = new Set(nextNotifs.map((n) => n.id));
      seenEmailIdsRef.current = new Set(nextEmails.map((e) => e.id));
      seenSupportIdsRef.current = new Set(nextSupport.map((s) => s.id));
      // Advance the freshness high-water marks to the newest received_at in this
      // poll's window (NaN-safe: skip unparseable timestamps). Rows that later
      // slide in from outside the window are older than this, so they won't ring.
      for (const e of nextEmails) {
        const t = new Date(e.receivedAt).getTime();
        if (Number.isFinite(t) && t > emailHighWaterRef.current) emailHighWaterRef.current = t;
      }
      for (const s of nextSupport) {
        const t = new Date(s.receivedAt).getTime();
        if (Number.isFinite(t) && t > supportHighWaterRef.current) supportHighWaterRef.current = t;
      }

      setTasks(next);
      setKudos(nextKudos);
      setNotifications(nextNotifs);
      setEmails(nextEmails);
      setSupport(nextSupport);
      if (bdayRes.ok) {
        const bd = await bdayRes.json();
        setBirthdays({
          hasBirthday: !!bd.hasBirthday,
          celebrantsToday: bd.celebrantsToday ?? []
        });
      }
      let eodDue = false;
      if (eodRes.ok) {
        const er = await eodRes.json();
        const due = !!er.due;
        eodDue = due;
        setEodReminderDue(due);
        // First-edge toast so it surfaces even if the user has the
        // bubble collapsed. Resets when due flips back to false (so a
        // next-day re-fire works).
        if (due && !eodReminderToastShownRef.current) {
          eodReminderToastShownRef.current = true;
          playAlertSound();
          toast.error("File your end-of-day client check-ins before clocking out", {
            duration: 8000,
            action: {
              label: "Open",
              onClick: () => {
                (window as any).widgetAPI?.openMainWindow?.("/eod");
              }
            }
          });
        } else if (!due) {
          eodReminderToastShownRef.current = false;
        }
      }
      lastFetchedRef.current = Date.now();

      // Auto state transitions based on whether there's something to
      // surface (tasks need ack OR there's an unread kudos OR there's
      // an open mention / notify-teammates ping).
      setState((prev) => {
        if (prev === "panel") return "panel"; // user is already looking
        return unackedNow.length > 0 || nextKudos.length > 0 || nextNotifs.length > 0 || nextEmails.length > 0 || nextSupport.length > 0 || eodDue
          ? "alert"
          : "bubble";
      });
    } catch { /* ignore network blips */ }
  }, []);

  // Initial fetch + 15s polling. (Tighter than the old 60s so the alarm
  // feels live; cheap because it's a single Postgres query each time.)
  useEffect(() => {
    fetchTasks();
    const id = setInterval(fetchTasks, 15_000);
    return () => clearInterval(id);
  }, [fetchTasks]);

  const unacked = tasks.filter((t) => t.needsAck);

  async function acknowledgeKudos(kudosId: string) {
    // Optimistic — drop it from local state, fire the server in the
    // background. Failures will resurface on the next poll.
    setKudos((cur) => cur.filter((k) => k.id !== kudosId));
    seenKudosRef.current.delete(kudosId);
    try {
      await fetch(`/api/widget/kudos/${kudosId}/acknowledge`, { method: "POST" });
    } catch { /* ignore */ }
    setState((prev) => {
      if (prev === "panel") return "panel";
      const remainingKudos = kudos.filter((k) => k.id !== kudosId);
      return unacked.length > 0 || remainingKudos.length > 0 ? "alert" : "bubble";
    });
  }

  async function dismissNotification(notifId: string) {
    // Optimistic — drop from local state.
    setNotifications((cur) => cur.filter((n) => n.id !== notifId));
    seenNotifIdsRef.current.delete(notifId);
    try {
      await fetch(`/api/widget/notifications/${notifId}/seen`, { method: "POST" });
    } catch { /* surfaces on next poll if it actually failed */ }
    setState((prev) => {
      if (prev === "panel") return "panel";
      const remaining = notifications.filter((n) => n.id !== notifId);
      return unacked.length > 0 || kudos.length > 0 || remaining.length > 0 || emails.length > 0 ? "alert" : "bubble";
    });
  }

  async function dismissEmail(emailId: string) {
    // Optimistic — drop from local state, then stamp seen_at on the
    // server. mark-seen accepts a specific id list so other unseen
    // emails are unaffected.
    setEmails((cur) => cur.filter((e) => e.id !== emailId));
    seenEmailIdsRef.current.delete(emailId);
    try {
      await fetch("/api/email-notifications/mark-seen", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids: [emailId] })
      });
    } catch { /* surfaces on next poll if it actually failed */ }
    setState((prev) => {
      if (prev === "panel") return "panel";
      const remaining = emails.filter((e) => e.id !== emailId);
      return unacked.length > 0 || kudos.length > 0 || notifications.length > 0 || remaining.length > 0
        || support.length > 0 || eodReminderDue ? "alert" : "bubble";
    });
  }

  async function markAllEmailsSeen() {
    // Optimistic — clear all shown emails locally, then stamp exactly those
    // ids server-side. Passing explicit ids (not a bodyless call) scopes the
    // mark to what's on screen, so emails that arrived since the last poll — or
    // that live outside the fetched window — aren't silently swallowed.
    const ids = emails.map((e) => e.id);
    if (ids.length === 0) return;
    setEmails([]);
    // Intentionally do NOT delete these ids from seenEmailIdsRef: if a 15s poll
    // races the in-flight mark-seen POST (rows still read as unseen), leaving the
    // ids in the ref keeps them flagged as "already chimed" so they don't re-ding.
    // The ref self-heals on the next poll's rebuild once the server excludes them.
    try {
      await fetch("/api/email-notifications/mark-seen", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids })
      });
    } catch { /* surfaces on next poll if it actually failed */ }
    setState((prev) => {
      if (prev === "panel") return "panel";
      return unacked.length > 0 || kudos.length > 0 || notifications.length > 0
        || support.length > 0 || eodReminderDue ? "alert" : "bubble";
    });
  }

  // Open the email's thread in DD. New widget shell: deep-link straight to the
  // reading pane in the default browser, and mark it handled (same end state as
  // "Got it"). Old shell — a not-yet-reinstalled .exe whose preload predates the
  // openMainWindow IPC — falls back to expanding the panel like every other alert,
  // and deliberately does NOT mark seen, so the email isn't silently swallowed.
  function openEmail(email: WidgetEmail) {
    const api = (window as any).widgetAPI;
    if (api?.openMainWindow) {
      api.openMainWindow(inboxThreadPath(email.accountId, email.threadId));
      void dismissEmail(email.id);
    } else {
      expandToPanel();
    }
  }

  async function dismissSupport(supportId: string) {
    // Optimistic — drop from local state, then stamp seen_at on the server.
    // Mirrors dismissEmail: mark-seen accepts a specific id list so other
    // unseen support messages are unaffected.
    setSupport((cur) => cur.filter((s) => s.id !== supportId));
    seenSupportIdsRef.current.delete(supportId);
    try {
      await fetch("/api/support-notifications/mark-seen", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids: [supportId] })
      });
    } catch { /* surfaces on next poll if it actually failed */ }
    setState((prev) => {
      if (prev === "panel") return "panel";
      const remaining = support.filter((s) => s.id !== supportId);
      return unacked.length > 0 || kudos.length > 0 || notifications.length > 0 || emails.length > 0 || remaining.length > 0 ? "alert" : "bubble";
    });
  }

  // Open the Customer Support tab and mark the message handled (same end state
  // as "Got it"). Old widget shells without the openMainWindow IPC fall back to
  // expanding the panel and deliberately do NOT mark seen, so nothing is
  // silently swallowed.
  function openSupport(item: WidgetSupport) {
    const api = (window as any).widgetAPI;
    if (api?.openMainWindow) {
      api.openMainWindow(SUPPORT_PATH);
      void dismissSupport(item.id);
    } else {
      expandToPanel();
    }
  }

  async function acknowledge(taskId: string) {
    // Optimistic
    setTasks((cur) => cur.map((t) => t.id === taskId ? { ...t, needsAck: false } : t));
    seenIdsRef.current.delete(taskId);
    try {
      await fetch("/api/widget/acknowledge", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ taskId })
      });
    } catch { /* surfaced via next poll if it actually failed */ }
    // After acking the last one, drop back to bubble (unless user opened panel).
    setState((prev) => {
      if (prev === "panel") return "panel";
      const remaining = tasks.filter((t) => t.needsAck && t.id !== taskId);
      return remaining.length > 0 ? "alert" : "bubble";
    });
  }

  function expandToPanel() { setState("panel"); }
  function collapseToBubble() {
    // From the panel, going back to bubble or alert depending on unacked count.
    setState(unacked.length > 0 ? "alert" : "bubble");
  }

  // Fit the Electron alert window to the actual notification card so the whole
  // thing pops complete on both macOS and Windows. The old shell used a FIXED
  // window height and center-aligned the card, so any card taller than that
  // window got its top + bottom clipped once mentions/emails stacked up. We
  // measure the rendered card (.anim-pop-bubble) and report its height; the
  // shell resizes the window to fit (+ the 20px shadow padding each side). A
  // ResizeObserver keeps it correct as rows are added/acked. Old widget shells
  // without setAlertSize simply keep the fixed ALERT size — no-op, no crash.
  const lastAlertH = useRef(0);
  useLayoutEffect(() => {
    const api = (window as any).widgetAPI;
    if (state !== "alert" || !api?.setAlertSize) { lastAlertH.current = 0; return; }
    const card = document.querySelector(".anim-pop-bubble") as HTMLElement | null;
    if (!card) return;
    const report = () => {
      const h = Math.ceil(card.getBoundingClientRect().height) + 40; // + 20px shadow padding × 2
      if (Math.abs(h - lastAlertH.current) > 2) {
        lastAlertH.current = h;
        api.setAlertSize({ h });
      }
    };
    report();
    const ro = new ResizeObserver(report);
    ro.observe(card);
    return () => ro.disconnect();
  }, [state, unacked.length, notifications.length, emails.length, support.length, kudos.length, eodReminderDue]);

  // Signed-out state takes priority. Bubble shows a generic icon (no
  // notif badge), panel shows the sign-in prompt. We don't want to show
  // task alerts or kudos banners when we have no session at all.
  if (signedOut) {
    if (state === "panel") return <SignInPanel onCollapse={collapseToBubble} />;
    return <Bubble onExpand={expandToPanel} unackedCount={0} iconUrl={widgetIconUrl} />;
  }

  if (state === "panel") return (
    <ClockProvider>
      <Panel tasks={tasks} unacked={unacked} kudos={kudos} notifications={notifications} emails={emails} eom={eom} birthdays={birthdays} onAck={acknowledge} onAckKudos={acknowledgeKudos} onDismissNotif={dismissNotification} onDismissEmail={dismissEmail} onMarkAllEmailsSeen={markAllEmailsSeen} onCollapse={collapseToBubble} onUpdated={fetchTasks} widgetIconUrl={widgetIconUrl} onIconChanged={fetchMe} online={onShift} />
    </ClockProvider>
  );
  if (state === "alert") {
    // Priority order: task ack > mention/notify ping > kudos. A new
    // task is the loudest signal; mentions are real-time pings; kudos
    // is celebratory and can wait.
    if (unacked.length > 0) {
      return <Alert task={unacked[0]} unackedCount={unacked.length} emailCount={emails.length} onAck={acknowledge} onExpand={expandToPanel} crowned={eom.isMe} iconUrl={widgetIconUrl} />;
    }
    if (notifications.length > 0) {
      return <NotifAlert notif={notifications[0]} count={notifications.length} emailCount={emails.length} onDismiss={dismissNotification} onExpand={expandToPanel} crowned={eom.isMe} iconUrl={widgetIconUrl} />;
    }
    if (emails.length > 0) {
      return <EmailAlert emails={emails} onDismiss={dismissEmail} onMarkAllSeen={markAllEmailsSeen} onOpen={openEmail} onExpand={expandToPanel} crowned={eom.isMe} iconUrl={widgetIconUrl} />;
    }
    if (support.length > 0) {
      return <SupportAlert item={support[0]} count={support.length} onDismiss={dismissSupport} onOpen={() => openSupport(support[0])} onExpand={expandToPanel} crowned={eom.isMe} iconUrl={widgetIconUrl} />;
    }
    if (kudos.length > 0) {
      return <KudosAlert kudos={kudos[0]} count={kudos.length} onAck={acknowledgeKudos} onExpand={expandToPanel} crowned={eom.isMe} iconUrl={widgetIconUrl} />;
    }
    if (eodReminderDue) {
      return <EodReminderAlert onExpand={expandToPanel} crowned={eom.isMe} iconUrl={widgetIconUrl} />;
    }
  }
  return <Bubble onExpand={expandToPanel} unackedCount={unacked.length + kudos.length + notifications.length + emails.length + support.length + (eodReminderDue ? 1 : 0)} crowned={eom.isMe} iconUrl={widgetIconUrl} />;
}

// Banner that appears when the worker's scheduled day has ended and
// they haven't filed any EOD client check-ins. Clicking it expands
// the widget panel so they can hop straight to the EOD form.
function EodReminderAlert({
  onExpand, crowned, iconUrl
}: { onExpand: () => void; crowned: boolean; iconUrl: string | null }) {
  return (
    <button
      type="button"
      onClick={onExpand}
      className="group flex items-center gap-2 px-3 py-2 rounded-2xl bg-gradient-to-br from-violet-600 to-fuchsia-600 text-white shadow-[0_12px_24px_-10px_rgba(124,58,237,0.55)] hover:-translate-y-0.5 transition-transform"
      title="File your end-of-day client check-ins"
    >
      <BubbleIcon unackedCount={1} crowned={crowned} iconUrl={iconUrl} />
      <div className="text-left">
        <div className="text-[10px] uppercase tracking-wide font-bold opacity-85">End of day</div>
        <div className="text-xs font-semibold leading-tight">File client check-ins</div>
      </div>
    </button>
  );
}

/* ============================ ICON ============================ */
// Shared bubble icon used in both `bubble` and `alert` states. Putting the
// drop-shadow filter on the <img> (not the <button>) so the shadow follows
// the icon's circular alpha mask rather than the rectangular button box —
// otherwise the bubble reads as a squircle even though the icon is round.

function BubbleIcon({
  unackedCount, crowned = false, iconUrl
}: {
  unackedCount: number;
  crowned?: boolean;
  iconUrl?: string | null;
}) {
  return (
    <div style={{ position: "relative", width: 64, height: 64 }}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={iconUrl || "/widget-icon.png"}
        alt="Scaled Operations"
        draggable={false}
        style={{
          width: 64,
          height: 64,
          display: "block",
          objectFit: "cover",
          borderRadius: "50%",
          userSelect: "none",
          pointerEvents: "none",
          filter: crowned
            ? "drop-shadow(0 4px 10px rgba(0,0,0,0.35)) drop-shadow(0 0 12px rgba(245,158,11,0.55))"
            : "drop-shadow(0 4px 10px rgba(0,0,0,0.35))"
        }}
      />
      {/* Employee of the Month — small crowned dot at the bottom-left
          corner. Small enough to leave the bubble uncluttered; the
          panel header shows the green "online" dot when the user is
          actually clocked in. */}
      {crowned && (
        <span
          aria-label="Employee of the Month"
          title="Employee of the Month"
          style={{
            position: "absolute",
            bottom: 2,
            left: 2,
            width: 18,
            height: 18,
            borderRadius: "50%",
            background: "linear-gradient(135deg, #FCD34D 0%, #F59E0B 70%, #D97706 100%)",
            border: "2px solid white",
            boxShadow: "0 2px 6px rgba(180,120,0,0.55)",
            pointerEvents: "none",
            display: "grid",
            placeItems: "center"
          }}
        >
          <svg viewBox="0 0 24 24" width={11} height={11}>
            <path
              d="M3 7l4 4 5-7 5 7 4-4-1.6 11H4.6L3 7z"
              fill="#FFFBEB"
              stroke="#92400E"
              strokeWidth="1.2"
              strokeLinejoin="round"
            />
          </svg>
        </span>
      )}
      {unackedCount > 0 && (
        <span style={{
          position: "absolute", top: -2, right: -2,
          minWidth: 18, height: 18, padding: "0 5px",
          borderRadius: 999,
          background: "#DC2626",
          color: "white",
          fontSize: 11, fontWeight: 600,
          display: "flex", alignItems: "center", justifyContent: "center",
          border: "2px solid white",
          boxShadow: "0 2px 4px rgba(0,0,0,0.25)"
        }}>{unackedCount}</span>
      )}
    </div>
  );
}

/* ============================ BUBBLE ============================ */

const DRAG_THRESHOLD = 4;

function Bubble({ onExpand, unackedCount, crowned = false, iconUrl, }: { onExpand: () => void; unackedCount: number; crowned?: boolean; iconUrl?: string | null }) {
  const startRef = useRef<{ x: number; y: number; dragging: boolean } | null>(null);
  function api() { return (window as any).widgetAPI; }

  function onPointerDown(e: React.PointerEvent<HTMLButtonElement>) {
    e.currentTarget.setPointerCapture(e.pointerId);
    startRef.current = { x: e.screenX, y: e.screenY, dragging: false };
  }
  function onPointerMove(e: React.PointerEvent<HTMLButtonElement>) {
    const s = startRef.current;
    if (!s) return;
    if (!s.dragging) {
      if (Math.hypot(e.screenX - s.x, e.screenY - s.y) > DRAG_THRESHOLD) {
        s.dragging = true;
        api()?.dragStart?.(e.screenX, e.screenY);
      } else return;
    }
    api()?.dragMove?.(e.screenX, e.screenY);
  }
  function onPointerUp(e: React.PointerEvent<HTMLButtonElement>) {
    const s = startRef.current;
    startRef.current = null;
    try { e.currentTarget.releasePointerCapture(e.pointerId); } catch {}
    if (!s) return;
    if (s.dragging) api()?.dragEnd?.();
    else onExpand();
  }
  function onPointerCancel() {
    if (startRef.current?.dragging) api()?.dragEnd?.();
    startRef.current = null;
  }

  return (
    <div style={{ width: "100vw", height: "100vh", display: "flex", alignItems: "center", justifyContent: "center", background: "transparent" }}>
      <button
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerCancel}
        title="Click to open · drag to move"
        aria-label="Open Scaled Operations"
        className="wg-bubble-btn anim-scale-in"
        style={{
          padding: 0, margin: 0, border: "none",
          background: "transparent", display: "block",
          cursor: "grab"
        }}
      >
        <BubbleIcon unackedCount={unackedCount} crowned={crowned} iconUrl={iconUrl} />
      </button>
    </div>
  );
}

/* ============================ ALERT (speech bubble) ============================ */

function Alert({
  task, unackedCount, emailCount = 0, onAck, onExpand, crowned = false, iconUrl,
}: {
  task: WidgetTask | undefined;
  unackedCount: number;
  emailCount?: number;
  onAck: (id: string) => void;
  onExpand: () => void;
  crowned?: boolean;
  iconUrl?: string | null;

}) {
  if (!task) return null;
  return (
    <div
      // Drag region on the speech bubble area so it can still be moved.
      // @ts-ignore — Electron-only
      style={{ width: "100vw", height: "100vh", display: "flex", alignItems: "center", justifyContent: "flex-end", padding: 20, gap: 8, background: "transparent", WebkitAppRegion: "drag" } as any}
    >
      {/* Speech bubble */}
      <div
        onClick={onExpand}
        // @ts-ignore
        style={{ WebkitAppRegion: "no-drag" } as any}
        className="relative flex-1 min-w-0 max-w-lg cursor-pointer anim-pop-bubble"
      >
        <div className="bg-white rounded-2xl border border-amber-300 shadow-[0_8px_24px_rgba(60,40,20,0.25)] px-4 py-3.5 pr-5">
          <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wide text-amber-700 font-semibold">
            <Bell className="w-3 h-3" />
            New {priorityLabel(task.priority)} task
            {unackedCount > 1 && <span className="ml-auto text-amber-700/70">+{unackedCount - 1} more</span>}
          </div>
          {emailCount > 0 && (
            <button
              onClick={(e) => { e.stopPropagation(); onExpand(); }}
              // @ts-ignore
              style={{ WebkitAppRegion: "no-drag" } as any}
              className="mt-1 inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-sky-100 hover:bg-sky-200 text-sky-700 text-[10px] font-medium border border-sky-300/70 transition-colors"
            >
              <Mail className="w-3 h-3" /> {emailCount} new email{emailCount > 1 ? "s" : ""}
            </button>
          )}
          <div className="text-[13px] text-slate-900 font-medium leading-snug mt-0.5 line-clamp-2">
            {task.title}
          </div>
          <div className="mt-1.5 flex items-center justify-between gap-2">
            <span className="text-[10px] inline-flex items-center gap-1">
              <Clock className="w-3 h-3 text-slate-400" />
              <Countdown iso={task.dueDate} className="text-[10px]" />
            </span>
            <button
              onClick={(e) => { e.stopPropagation(); onAck(task.id); }}
              // @ts-ignore
              style={{ WebkitAppRegion: "no-drag" } as any}
              className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full bg-emerald-500 hover:bg-emerald-600 text-white text-[11px] font-medium shadow-sm"
            >
              <Check className="w-3 h-3" /> Got it
            </button>
          </div>
        </div>

        {/* Tail pointing right toward the bubble */}
        <div
          className="absolute"
          style={{
            right: -7, top: "50%", transform: "translateY(-50%) rotate(45deg)",
            width: 14, height: 14,
            background: "white",
            borderRight: "1px solid #FCD34D",
            borderTop: "1px solid #FCD34D"
          }}
        />
      </div>

      {/* Bubble icon (right) — same component as the no-notif state so they
          look identical. */}
      <button
        onClick={onExpand}
        // @ts-ignore
        style={{ WebkitAppRegion: "no-drag", padding: 0, border: "none", background: "transparent" } as any}
        className="shrink-0 wg-bubble-btn anim-scale-in"
        aria-label="Open"
      >
        <BubbleIcon unackedCount={unackedCount} crowned={crowned} iconUrl={iconUrl} />
      </button>

    </div>
  );
}

function priorityLabel(p: WidgetTask["priority"]) {
  return p === "critical" ? "CRITICAL" : p;
}

/* ============================ SIGN-IN PANEL ============================ */
// Rendered when the widget's API polls return 401 — i.e. no session in
// the Electron cookie jar. Click "Open in browser" to sign in via the
// main app; once the cookie is set the next 15s poll picks it up and the
// widget transitions to the normal task/kudos UI on its own.

function SignInPanel({ onCollapse }: { onCollapse: () => void }) {
  function signIn() {
    // Navigate the widget itself to the login form. Once submitted, the
    // login page redirects back to /widget (via the `next` param), and
    // the auth cookie sticks in Electron's session. No browser hand-off
    // needed — Electron doesn't share cookies with Chrome.
    window.location.href = "/login?next=/widget";
  }
  function openMain() {
    (window as any).widgetAPI?.openMain?.();
  }
  return (
    <div className="h-screen w-screen p-5 anim-fade-in">
      <div className="h-full w-full flex flex-col text-slate-900 rounded-[28px] overflow-hidden border border-slate-200/70 bg-white shadow-[0_20px_60px_-20px_rgba(15,23,42,0.25),0_8px_24px_-12px_rgba(15,23,42,0.15)]">
        <div
          className="h-12 flex items-center justify-between px-4 border-b border-slate-100"
          // @ts-ignore — Electron-only
          style={{ WebkitAppRegion: "drag" }}
        >
          <div className="flex items-center gap-2 text-xs">
            <div className="w-6 h-6 rounded-full overflow-hidden border border-slate-200 ring-1 ring-white shadow-sm">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src="/widget-icon.png" alt="" className="w-full h-full object-cover" draggable={false} />
            </div>
            <span className="font-semibold text-ink">Scaled Operations</span>
          </div>
          <div className="flex items-center gap-0.5" style={{ WebkitAppRegion: "no-drag" } as any}>
            <button title="Collapse" className="p-1.5 rounded-lg text-slate-500 hover:text-ink hover:bg-slate-100 transition-colors" onClick={onCollapse}>
              <Minus className="w-3.5 h-3.5" />
            </button>
            <button title="Hide" className="p-1.5 rounded-lg text-slate-500 hover:text-ink hover:bg-slate-100 transition-colors" onClick={() => (window as any).widgetAPI?.hide?.()}>
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>

        <div className="flex-1 flex flex-col items-center justify-center text-center px-6 py-8">
          <div className="text-[11px] uppercase tracking-[0.18em] font-semibold text-accent mb-2">
            Welcome
          </div>
          <div className="w-14 h-14 rounded-2xl bg-blue-50 ring-1 ring-blue-200/60 grid place-items-center mb-4">
            <Sparkles className="w-7 h-7 text-accent" />
          </div>
          <div className="text-lg font-bold text-ink leading-tight tracking-tight">
            Sign in to <span className="text-accent">Scaled Operations</span>
          </div>
          <div className="text-[12px] text-ink/60 mt-1.5 max-w-[260px] leading-relaxed">
            Sign in right here in the widget — it keeps its own login, separate from your browser.
          </div>
          <button
            onClick={signIn}
            className="mt-5 inline-flex items-center gap-1.5 px-4 py-2 rounded-full text-sm font-medium text-white bg-accent hover:bg-accent/90 shadow-sm transition-all hover:-translate-y-0.5"
          >
            Sign in here →
          </button>
          <button
            onClick={openMain}
            className="mt-2 text-[11px] text-muted hover:text-ink underline-offset-2 hover:underline transition-colors"
          >
            or open the main app in your browser
          </button>
          <div className="mt-3 text-[11px] text-muted">
            The widget keeps its own session — sign in here once and it sticks.
          </div>
        </div>
      </div>
    </div>
  );
}

/* ============================ KUDOS ALERT ============================ */
// Same speech-bubble shape as Alert(), but tinted fuchsia and pointing at
// the bubble icon. Fires when there's a new kudos and no task alerts.

function KudosAlert({
  kudos: k, count, onAck, onExpand, crowned = false, iconUrl,
}: {
  kudos: WidgetKudos;
  count: number;
  onAck: (id: string) => void;
  onExpand: () => void;
  crowned?: boolean;
  iconUrl?: string | null;

}) {
  return (
    <div
      // @ts-ignore — Electron-only
      style={{ width: "100vw", height: "100vh", display: "flex", alignItems: "center", justifyContent: "flex-end", padding: 20, gap: 8, background: "transparent", WebkitAppRegion: "drag" } as any}
    >
      <div
        onClick={onExpand}
        // @ts-ignore
        style={{ WebkitAppRegion: "no-drag" } as any}
        className="relative flex-1 min-w-0 max-w-lg cursor-pointer anim-pop-bubble"
      >
        <div className="bg-gradient-to-br from-fuchsia-50 to-pink-50 rounded-2xl border border-fuchsia-300 shadow-[0_8px_24px_rgba(120,40,120,0.25)] px-4 py-3.5 pr-5">
          <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wide text-fuchsia-700 font-semibold">
            <Sparkles className="w-3 h-3" />
            {k.from?.name ?? "Someone"} sent you kudos
            {count > 1 && <span className="ml-auto text-fuchsia-700/70">+{count - 1} more</span>}
          </div>
          <div className="text-[13px] text-slate-900 font-medium leading-snug mt-0.5 line-clamp-3 flex items-start gap-1.5">
            <span className="text-base shrink-0 leading-none mt-0.5">{k.emoji || "👏"}</span>
            <span>{k.message}</span>
          </div>
          <div className="mt-1.5 flex items-center justify-end gap-2">
            <button
              onClick={(e) => { e.stopPropagation(); onAck(k.id); }}
              // @ts-ignore
              style={{ WebkitAppRegion: "no-drag" } as any}
              className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full bg-fuchsia-500 hover:bg-fuchsia-600 text-white text-[11px] font-medium shadow-sm"
            >
              <Check className="w-3 h-3" /> Thanks
            </button>
          </div>
        </div>

        <div
          className="absolute"
          style={{
            right: -7, top: "50%", transform: "translateY(-50%) rotate(45deg)",
            width: 14, height: 14,
            background: "rgb(253, 232, 247)",
            borderRight: "1px solid #E879F9",
            borderTop: "1px solid #E879F9"
          }}
        />
      </div>

      <button
        onClick={onExpand}
        // @ts-ignore
        style={{ WebkitAppRegion: "no-drag", padding: 0, border: "none", background: "transparent" } as any}
        className="shrink-0 wg-bubble-btn anim-scale-in"
        aria-label="Open"
      >
        <BubbleIcon unackedCount={count} crowned={crowned} iconUrl={iconUrl} />
      </button>
    </div>
  );
}

/* ============================ NOTIF ALERT (mention / notify-teammates) ============================ */

function NotifAlert({
  notif, count, emailCount = 0, onDismiss, onExpand, crowned = false, iconUrl,
}: {
  notif: WidgetNotification;
  count: number;
  emailCount?: number;
  onDismiss: (id: string) => void;
  onExpand: () => void;
  crowned?: boolean;
  iconUrl?: string | null;

}) {
  const headline = notif.kind === "mention"
    ? `${notif.from?.name ?? "Someone"} mentioned you`
    : `${notif.from?.name ?? "Someone"} pinged you on a task`;
  return (
    <div
      // @ts-ignore — Electron-only
      style={{ width: "100vw", height: "100vh", display: "flex", alignItems: "center", justifyContent: "flex-end", padding: 20, gap: 8, background: "transparent", WebkitAppRegion: "drag" } as any}
    >
      <div
        onClick={onExpand}
        // @ts-ignore
        style={{ WebkitAppRegion: "no-drag" } as any}
        className="relative flex-1 min-w-0 max-w-lg cursor-pointer anim-pop-bubble"
      >
        <div className="bg-gradient-to-br from-violet-50 to-blue-50 rounded-2xl border border-violet-300 shadow-[0_8px_24px_rgba(80,40,150,0.25)] px-4 py-3.5 pr-5">
          <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wide text-violet-700 font-semibold">
            <Bell className="w-3 h-3" />
            {headline}
            {count > 1 && <span className="ml-auto text-violet-700/70">+{count - 1} more</span>}
          </div>
          {emailCount > 0 && (
            <button
              onClick={(e) => { e.stopPropagation(); onExpand(); }}
              // @ts-ignore
              style={{ WebkitAppRegion: "no-drag" } as any}
              className="mt-1 inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-sky-100 hover:bg-sky-200 text-sky-700 text-[10px] font-medium border border-sky-300/70 transition-colors"
            >
              <Mail className="w-3 h-3" /> {emailCount} new email{emailCount > 1 ? "s" : ""}
            </button>
          )}
          <div className="text-[13px] text-slate-900 font-medium leading-snug mt-0.5 line-clamp-2">
            {notif.taskTitle}
          </div>
          {notif.note && (
            <div className="text-[11px] text-slate-600 mt-0.5 line-clamp-3 italic">
              "{notif.note}"
            </div>
          )}
          <div className="mt-1.5 flex items-center justify-end gap-2">
            <button
              onClick={(e) => { e.stopPropagation(); onDismiss(notif.id); }}
              // @ts-ignore
              style={{ WebkitAppRegion: "no-drag" } as any}
              className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full bg-violet-500 hover:bg-violet-600 text-white text-[11px] font-medium shadow-sm"
            >
              <Check className="w-3 h-3" /> Got it
            </button>
          </div>
        </div>

        <div
          className="absolute"
          style={{
            right: -7, top: "50%", transform: "translateY(-50%) rotate(45deg)",
            width: 14, height: 14,
            background: "rgb(245, 243, 255)",
            borderRight: "1px solid #C4B5FD",
            borderTop: "1px solid #C4B5FD"
          }}
        />
      </div>

      <button
        onClick={onExpand}
        // @ts-ignore
        style={{ WebkitAppRegion: "no-drag", padding: 0, border: "none", background: "transparent" } as any}
        className="shrink-0 wg-bubble-btn anim-scale-in"
        aria-label="Open"
      >
        <BubbleIcon unackedCount={count} crowned={crowned} iconUrl={iconUrl} />
      </button>
    </div>
  );
}

/* ============================ EMAIL ALERT (new inbound email) ============================ */

function EmailAlert({
  emails, onDismiss, onMarkAllSeen, onOpen, onExpand, crowned = false, iconUrl,
}: {
  emails: WidgetEmail[];
  onDismiss: (id: string) => void;
  onMarkAllSeen: () => void;
  onOpen: (email: WidgetEmail) => void;
  onExpand: () => void;
  crowned?: boolean;
  iconUrl?: string | null;
}) {
  const count = emails.length;
  if (count === 0) return null;
  return (
    <div
      // @ts-ignore — Electron-only
      style={{ width: "100vw", height: "100vh", display: "flex", alignItems: "center", justifyContent: "flex-end", padding: 20, gap: 8, background: "transparent", WebkitAppRegion: "drag" } as any}
    >
      <div
        // @ts-ignore
        style={{ WebkitAppRegion: "no-drag" } as any}
        className="relative flex-1 min-w-0 max-w-lg anim-pop-bubble"
      >
        <div
          className="flex flex-col bg-gradient-to-br from-sky-50 to-cyan-50 rounded-2xl border border-sky-300 shadow-[0_8px_24px_rgba(2,132,199,0.25)] overflow-hidden"
          // Keep the card COMPACT — the classic single-glance design: header
          // (count + Mark all seen), the newest row visible, the rest reachable
          // by scrolling the list, then the footer. Cap keeps it small so it
          // doesn't grow into a tall panel. The shell now measures THIS card and
          // fits the window snugly around it (see the measuring effect +
          // widget:set-alert-size), so the compact card always displays
          // complete — header, row, and footer — never center-clipped. Preview
          // text is dropped here (shown in the panel) to keep each row compact.
          style={{ maxHeight: 112 }}
        >
          <div className="shrink-0 flex items-center gap-1.5 px-3 pt-2.5 pb-1.5 text-[10px] uppercase tracking-wide text-sky-700 font-semibold">
            <Mail className="w-3 h-3" />
            {count === 1 ? "New email" : `${count} new emails`}
            {count > 1 && (
              <button
                onClick={(e) => { e.stopPropagation(); onMarkAllSeen(); }}
                className="ml-auto normal-case tracking-normal text-[10px] font-medium text-sky-700 hover:text-sky-900"
              >
                Mark all seen
              </button>
            )}
          </div>
          <div className="flex-1 min-h-0 overflow-y-auto px-2 py-1 space-y-1.5">
            {emails.map((email) => (
              <div
                key={email.id}
                onClick={() => onOpen(email)}
                className="rounded-xl bg-white/80 border border-sky-200/70 px-2.5 py-1.5 cursor-pointer hover:bg-white transition-colors"
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="min-w-0">
                    <div className="text-[11px] text-slate-700 font-medium truncate">
                      {email.fromName || email.fromEmail || "New email"}
                    </div>
                    <div className="text-[13px] text-slate-900 font-semibold leading-snug truncate">
                      {email.subject || "(no subject)"}
                    </div>
                  </div>
                  <button
                    onClick={(e) => { e.stopPropagation(); onDismiss(email.id); }}
                    className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-sky-600 hover:bg-sky-700 text-white text-[10px] font-medium shadow-sm shrink-0"
                  >
                    <Check className="w-3 h-3" /> Got it
                  </button>
                </div>
              </div>
            ))}
          </div>
          {count > 1 && (
            <button
              onClick={(e) => { e.stopPropagation(); onExpand(); }}
              className="shrink-0 w-full text-center text-[10px] font-medium text-sky-700 hover:text-sky-900 border-t border-sky-200/60 py-1.5"
            >
              See all in widget
            </button>
          )}
        </div>

        <div
          className="absolute"
          style={{
            right: -7, top: "50%", transform: "translateY(-50%) rotate(45deg)",
            width: 14, height: 14,
            background: "rgb(240, 249, 255)",
            borderRight: "1px solid #7DD3FC",
            borderTop: "1px solid #7DD3FC"
          }}
        />
      </div>

      <button
        onClick={onExpand}
        // @ts-ignore
        style={{ WebkitAppRegion: "no-drag", padding: 0, border: "none", background: "transparent" } as any}
        className="shrink-0 wg-bubble-btn anim-scale-in"
        aria-label="Open"
      >
        <BubbleIcon unackedCount={count} crowned={crowned} iconUrl={iconUrl} />
      </button>
    </div>
  );
}

// Customer-support speech bubble. Cloned from EmailAlert with support copy +
// an emerald tint so it's visually distinct from the sky-blue email alert.
function SupportAlert({
  item, count, onDismiss, onOpen, onExpand, crowned = false, iconUrl,
}: {
  item: WidgetSupport;
  count: number;
  onDismiss: (id: string) => void;
  onOpen: () => void;
  onExpand: () => void;
  crowned?: boolean;
  iconUrl?: string | null;
}) {
  const sender = item.contactName || item.phone || "New message";
  const preview = item.preview || "(no preview)";
  return (
    <div
      // @ts-ignore — Electron-only
      style={{ width: "100vw", height: "100vh", display: "flex", alignItems: "center", justifyContent: "flex-end", padding: 20, gap: 8, background: "transparent", WebkitAppRegion: "drag" } as any}
    >
      <div
        onClick={onOpen}
        // @ts-ignore
        style={{ WebkitAppRegion: "no-drag" } as any}
        className="relative flex-1 min-w-0 max-w-lg cursor-pointer anim-pop-bubble"
      >
        <div className="bg-gradient-to-br from-emerald-50 to-teal-50 rounded-2xl border border-emerald-300 shadow-[0_8px_24px_rgba(5,150,105,0.25)] px-4 py-3.5 pr-5">
          <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wide text-emerald-700 font-semibold">
            <LifeBuoy className="w-3 h-3" />
            New support message
            {count > 1 && <span className="ml-auto text-emerald-700/70">+{count - 1} more</span>}
          </div>
          <div className="text-[12px] text-slate-700 font-medium truncate mt-0.5">
            {sender}
          </div>
          <div className="text-[13px] text-slate-900 font-semibold leading-snug mt-0.5 line-clamp-3">
            {preview}
          </div>
          <div className="mt-1.5 flex items-center justify-end gap-2">
            <button
              onClick={(e) => { e.stopPropagation(); onDismiss(item.id); }}
              // @ts-ignore
              style={{ WebkitAppRegion: "no-drag" } as any}
              className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full bg-emerald-600 hover:bg-emerald-700 text-white text-[11px] font-medium shadow-sm"
            >
              <Check className="w-3 h-3" /> Got it
            </button>
          </div>
        </div>

        <div
          className="absolute"
          style={{
            right: -7, top: "50%", transform: "translateY(-50%) rotate(45deg)",
            width: 14, height: 14,
            background: "rgb(236, 253, 245)",
            borderRight: "1px solid #6EE7B7",
            borderTop: "1px solid #6EE7B7"
          }}
        />
      </div>

      <button
        onClick={onExpand}
        // @ts-ignore
        style={{ WebkitAppRegion: "no-drag", padding: 0, border: "none", background: "transparent" } as any}
        className="shrink-0 wg-bubble-btn anim-scale-in"
        aria-label="Open"
      >
        <BubbleIcon unackedCount={count} crowned={crowned} iconUrl={iconUrl} />
      </button>
    </div>
  );
}

/* ============================ PRESENCE ============================ */

type PresenceState = "available" | "focus" | "eating" | "away";

const PRESENCE_OPTIONS: {
  value: PresenceState;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  cls: string;
  activeCls: string;
}[] = [
  { value: "available", label: "Available", icon: Smile, cls: "text-emerald-600", activeCls: "bg-gradient-to-r from-emerald-500 to-teal-500 text-white" },
  { value: "focus",     label: "Focus",     icon: Focus, cls: "text-indigo-600", activeCls: "bg-gradient-to-r from-indigo-500 to-blue-500 text-white" },
  { value: "eating",    label: "Eating",    icon: Coffee, cls: "text-amber-600", activeCls: "bg-gradient-to-r from-amber-500 to-orange-500 text-white" },
  { value: "away",      label: "Away",      icon: Moon,  cls: "text-slate-600", activeCls: "bg-gradient-to-r from-slate-500 to-slate-600 text-white" }
];

// Cache key for the last-known presence so the widget can render
// immediately on cold launch without flashing "Available" then snapping
// to whatever the server actually has.
const PRESENCE_CACHE_KEY = "wg.presence.v1";

function readCachedPresence(): PresenceState | null {
  if (typeof window === "undefined") return null;
  try {
    const v = window.localStorage.getItem(PRESENCE_CACHE_KEY);
    if (v === "available" || v === "focus" || v === "eating" || v === "away") return v;
  } catch { /* private mode etc. */ }
  return null;
}

function writeCachedPresence(v: PresenceState) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(PRESENCE_CACHE_KEY, v);
  } catch { /* ignore */ }
}

function PresenceRow() {
  // Lazy initial state from localStorage — instant render, no network.
  const [state, setStateInternal] = useState<PresenceState>(
    () => readCachedPresence() ?? "available"
  );

  // Wraps the state setter so every change persists to the cache too.
  function setState(next: PresenceState) {
    setStateInternal(next);
    writeCachedPresence(next);
  }

  // Background refresh: hit the server in the background. If the value
  // matches what we already had, no re-render. If it's different, take
  // the server's word for it. Avoids spurious flicker on cold open.
  useEffect(() => {
    let cancelled = false;
    fetch("/api/users/me/presence", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (cancelled || !d) return;
        const next = (d.state as PresenceState) ?? "available";
        // Only update if it actually differs from the cached value.
        // Prevents an unnecessary re-render every time the panel opens.
        setStateInternal((cur) => (cur === next ? cur : next));
        writeCachedPresence(next);
      })
      .catch(() => { /* offline; cached state stands */ });
    return () => { cancelled = true; };
  }, []);

  async function pick(next: PresenceState) {
    if (next === state) return;
    // Optimistic: paint the new state immediately. Cache the new value
    // so a quick reopen also shows it. If the network call fails, roll
    // back both.
    const prev = state;
    setState(next);
    try {
      const res = await fetch("/api/users/me/presence", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ state: next })
      });
      if (!res.ok) throw new Error(`failed (${res.status})`);
    } catch {
      setState(prev);
    }
  }

  return (
    <div className="px-3 pt-3">
      <div className="text-[10px] uppercase tracking-[0.18em] text-accent mb-1.5 font-semibold">Status</div>
      <div className="grid grid-cols-4 gap-1">
        {PRESENCE_OPTIONS.map((opt) => {
          const Icon = opt.icon;
          const active = state === opt.value;
          return (
            <button
              key={opt.value}
              onClick={() => pick(opt.value)}
              className={
                "flex flex-col items-center gap-0.5 px-1 py-2 rounded-xl text-[10px] font-medium transition-all border " +
                (active
                  ? opt.activeCls + " border-transparent shadow-sm"
                  : "bg-white border-slate-200/70 text-ink/65 hover:text-ink hover:border-slate-300 hover:bg-slate-50")
              }
            >
              <Icon className={"w-4 h-4 " + (active ? "text-white" : opt.cls)} />
              <span>{opt.label}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

/* ============================ EOM BANNER ============================ */
// Triumphant strip that lives at the top of the panel when the current
// user is Employee of the Month. Animated gradient sweep + sparkles +
// rotating crown so it actually feels like a celebration the first time
// someone sees it.

function EomBanner({ month }: { month: string | null }) {
  const monthLabel = month ? prettyMonth(month) : "this month";
  return (
    <div className="px-3 pt-3">
      <div
        className="relative overflow-hidden rounded-2xl border border-amber-300/70 px-3 py-2.5 shadow-sm"
        style={{
          background:
            "linear-gradient(120deg, #FEF3C7 0%, #FDE68A 50%, #FBBF24 100%)"
        }}
      >
        {/* Diagonal sheen that drifts across the banner forever */}
        <span
          aria-hidden
          className="absolute inset-y-0 -inset-x-1/4 pointer-events-none"
          style={{
            background:
              "linear-gradient(115deg, transparent 35%, rgba(255,255,255,0.55) 50%, transparent 65%)",
            animation: "ddSheen 2.6s ease-in-out infinite"
          }}
        />
        <div className="relative flex items-center gap-2.5">
          <div className="w-8 h-8 rounded-xl bg-gradient-to-br from-amber-400 to-orange-500 grid place-items-center shadow-sm">
            <Crown className="w-4 h-4 text-white" />
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-[10px] uppercase tracking-[0.16em] font-semibold text-amber-700 leading-none">
              Employee of the month
            </div>
            <div className="text-[13px] font-bold text-amber-900 mt-0.5 leading-tight">
              You're crowned for {monthLabel} 👑
            </div>
          </div>
        </div>
      </div>
      <style>{`
        @keyframes ddSheen {
          0%   { transform: translateX(-30%); opacity: 0; }
          25%  { opacity: 0.8; }
          75%  { opacity: 0.8; }
          100% { transform: translateX(60%);  opacity: 0; }
        }
      `}</style>
    </div>
  );
}

function prettyMonth(key: string): string {
  const [y, m] = key.split("-");
  const d = new Date(Number(y), Number(m) - 1, 1);
  return d.toLocaleDateString(undefined, { month: "long", year: "numeric" });
}

// Compact celebration banner shown in the panel when one or more
// teammates are celebrating today. The self-variant ("Happy birthday,
// you!") only fires if the celebrant list contains the current user.
function BirthdayBanner({ celebrants }: {
  celebrants: { id: string; name: string; avatarUrl: string | null; isMe: boolean }[];
}) {
  const meCelebrating = celebrants.find((c) => c.isMe);
  const others = celebrants.filter((c) => !c.isMe);
  let headline: string;
  let subline: string;
  if (meCelebrating && others.length === 0) {
    headline = "🎂 Happy birthday, you!";
    subline = "The team's wishing you well today.";
  } else if (meCelebrating && others.length > 0) {
    const names = others.slice(0, 2).map((c) => c.name).join(" & ");
    headline = `🎂 It's your birthday — and ${names}'s too!`;
    subline = "Big day. Send each other a kudos maybe.";
  } else if (others.length === 1) {
    headline = `🎂 It's ${others[0].name}'s birthday today`;
    subline = "Drop a note in Slack or send a kudos.";
  } else {
    const names = others.slice(0, 2).map((c) => c.name).join(", ");
    const more = others.length > 2 ? ` (+${others.length - 2})` : "";
    headline = `🎂 Birthdays today: ${names}${more}`;
    subline = "Send some love.";
  }
  return (
    <div className="px-3 pt-3">
      <div
        className="rounded-2xl p-3 border border-fuchsia-200/70 shadow-sm"
        style={{ background: "linear-gradient(120deg, #FCE7F3 0%, #EEF2FF 100%)" }}
      >
        <div className="text-[13px] font-semibold text-fuchsia-700 leading-snug">
          {headline}
        </div>
        <div className="text-[11px] text-fuchsia-700/70 mt-0.5">{subline}</div>
        <div className="flex items-center gap-1 mt-2 -space-x-1.5">
          {celebrants.slice(0, 6).map((c) => (
            <PersonAvatar
              key={c.id}
              userId={c.id}
              name={c.name}
              imageUrl={c.avatarUrl ?? undefined}
              size={26}
              className="ring-2 ring-white shadow-sm"
            />
          ))}
        </div>
      </div>
    </div>
  );
}

// One-time prompt: shown when the current user hasn't set their
// birthday yet. PUT /api/users/me/birthday saves it; the banner
// disappears on next poll.
function BirthdayPrompt({ onSaved }: { onSaved: () => void }) {
  const [value, setValue] = useState("");
  const [saving, setSaving] = useState(false);
  const [dismissed, setDismissed] = useState(false);

  async function save() {
    if (!value || saving) return;
    setSaving(true);
    try {
      const res = await fetch("/api/users/me/birthday", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ birthday: value })
      });
      if (!res.ok) throw new Error(`status ${res.status}`);
      toast.success("Saved your birthday 🎂");
      setDismissed(true);
      onSaved();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "couldn't save");
    } finally {
      setSaving(false);
    }
  }

  if (dismissed) return null;
  return (
    <div className="px-3 pt-3">
      <div className="rounded-2xl p-3 border border-amber-200/70 bg-amber-50/60 shadow-sm">
        <div className="flex items-center justify-between gap-2">
          <div className="text-[12px] font-semibold text-amber-800 leading-snug">
            🎂 When's your birthday?
          </div>
          <button
            type="button"
            onClick={() => setDismissed(true)}
            className="text-[10px] text-amber-800/60 hover:text-amber-900 underline"
            title="Hide this prompt for now"
          >
            later
          </button>
        </div>
        <div className="text-[11px] text-amber-800/70 mt-0.5">
          So the team can celebrate you. Visible to everyone in the org.
        </div>
        <div className="mt-2 flex items-center gap-1.5">
          <input
            type="date"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            className="flex-1 px-2.5 py-1.5 rounded-lg border border-amber-200/80 bg-white text-[12px] outline-none focus:ring-2 focus:ring-amber-300"
          />
          <button
            type="button"
            onClick={save}
            disabled={!value || saving}
            className="px-3 py-1.5 rounded-lg text-[12px] font-semibold bg-amber-500 text-white shadow-sm disabled:opacity-50 disabled:cursor-not-allowed active:scale-95 transition-all"
          >
            {saving ? "…" : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ============================ CLOCK SECTION ============================ */
// Clock-in / clock-out + task timer for the widget. ClockProvider is the
// single source of truth that polls /api/clock every 10s; ClockSection
// (header) and the per-task Start/Stop buttons both subscribe via useClock.

function formatHMS(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => n.toString().padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

// Clock state cached per-widget so reopening doesn't flash the off-shift
// state before the network catches up.
const CLOCK_CACHE_KEY = "wg.clock.v2";

interface ClockCache {
  open: { id: string; startedAt: string; taskId: string | null } | null;
  dailyCapacityHours: number;
}

function readCachedClock(): ClockCache | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(CLOCK_CACHE_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as ClockCache;
  } catch { return null; }
}

function writeCachedClock(c: ClockCache) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(CLOCK_CACHE_KEY, JSON.stringify(c));
  } catch { /* ignore */ }
}

interface ClockState {
  open: { id: string; startedAt: string; taskId: string | null } | null;
  todayMs: number;
  dailyCapacityHours: number;
  workdayRemainingMs: number;
  // Hours logged today per task id (closed segments + live-running). Lets
  // task rows render "1.5h today" alongside the per-task lifetime actual.
  hoursByTask: Record<string, number>;
}

interface ClockApi {
  clock: ClockState;
  refresh: () => Promise<void>;
  toggleShift: () => Promise<void>;
  startTask: (taskId: string) => Promise<void>;
  stopTask: (taskId: string) => Promise<void>;
  // Ticks every second while a shift is open so consumers re-render the
  // live timer smoothly. The value is meaningless; subscribe to force
  // re-render.
  tick: number;
}

const ClockContext = createContext<ClockApi | null>(null);

function useClock(): ClockApi {
  const v = useContext(ClockContext);
  if (!v) throw new Error("useClock used outside <ClockProvider>");
  return v;
}

function ClockProvider({ children }: { children: React.ReactNode }) {
  const cached = typeof window !== "undefined" ? readCachedClock() : null;
  const [clock, setClock] = useState<ClockState>(() => ({
    open: cached?.open ?? null,
    todayMs: 0,
    dailyCapacityHours: cached?.dailyCapacityHours ?? 8,
    workdayRemainingMs: (cached?.dailyCapacityHours ?? 8) * 3_600_000,
    hoursByTask: {}
  }));
  const [tick, setTick] = useState(0);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/clock", { cache: "no-store" });
      if (!res.ok) return;
      const data = await res.json();
      const next: ClockState = {
        open: data.open ?? null,
        todayMs: Number(data.todayMs ?? 0),
        dailyCapacityHours: Number(data.dailyCapacityHours ?? 8),
        workdayRemainingMs: Number(data.workdayRemainingMs ?? 0),
        hoursByTask: (data.hoursByTask as Record<string, number>) ?? {}
      };
      setClock(next);
      writeCachedClock({ open: next.open, dailyCapacityHours: next.dailyCapacityHours });
    } catch { /* ignore */ }
  }, []);

  useEffect(() => {
    refresh();
    const poll = setInterval(refresh, 10_000);
    return () => clearInterval(poll);
  }, [refresh]);

  // Live tick while anything is open (shift or task segment).
  useEffect(() => {
    if (!clock.open) return;
    const t = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [clock.open]);

  const toggleShift = useCallback(async () => {
    const prev = clock;
    const isOn = Boolean(prev.open);
    // Optimistic flip.
    setClock((c) => ({
      ...c,
      open: isOn
        ? null
        : { id: `tmp_${Date.now().toString(36)}`, startedAt: new Date().toISOString(), taskId: null }
    }));
    try {
      const res = await fetch("/api/clock", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: isOn ? "out" : "in" })
      });
      if (!res.ok) throw new Error(`failed (${res.status})`);
      await refresh();
    } catch {
      setClock(prev);
    }
  }, [clock, refresh]);

  const startTask = useCallback(async (taskId: string) => {
    const prev = clock;
    // Optimistic: pretend the segment is already running.
    setClock((c) => ({
      ...c,
      open: { id: `tmp_${Date.now().toString(36)}`, startedAt: new Date().toISOString(), taskId }
    }));
    try {
      const res = await fetch(`/api/tasks/${taskId}/timer`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "start" })
      });
      if (!res.ok) throw new Error(`failed (${res.status})`);
      await refresh();
    } catch {
      setClock(prev);
      toast.error("Couldn't start timer");
    }
  }, [clock, refresh]);

  const stopTask = useCallback(async (taskId: string) => {
    const prev = clock;
    setClock((c) => ({
      ...c,
      open: c.open && c.open.taskId === taskId
        ? { id: c.open.id, startedAt: new Date().toISOString(), taskId: null }
        : c.open
    }));
    try {
      const res = await fetch(`/api/tasks/${taskId}/timer`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "stop" })
      });
      if (!res.ok) throw new Error(`failed (${res.status})`);
      await refresh();
    } catch {
      setClock(prev);
      toast.error("Couldn't stop timer");
    }
  }, [clock, refresh]);

  return (
    <ClockContext.Provider value={{ clock, refresh, toggleShift, startTask, stopTask, tick }}>
      {children}
    </ClockContext.Provider>
  );
}

// localStorage cache so the widget knows on first render whether to
// show the clock section. Without this, salaried users see the
// section flash for one fetch round-trip and then disappear, which
// looks broken.
const CLOCK_ENABLED_CACHE_KEY = "wg.clockEnabled.v1";
function readCachedClockEnabled(): boolean | null {
  if (typeof window === "undefined") return null;
  const v = window.localStorage.getItem(CLOCK_ENABLED_CACHE_KEY);
  if (v === "true") return true;
  if (v === "false") return false;
  return null;
}
function writeCachedClockEnabled(v: boolean) {
  if (typeof window === "undefined") return;
  try { window.localStorage.setItem(CLOCK_ENABLED_CACHE_KEY, String(v)); }
  catch { /* private mode / quota */ }
}

function ClockSection() {
  // Leader can turn the clock off per user (salaried roles etc.).
  // We hide this whole block when disabled. To avoid the "renders
  // briefly, then disappears" flash, we read the cached value
  // synchronously before paint; the fetch only reconciles if the
  // server's answer differs.
  const [clockEnabled, setClockEnabled] = useState<boolean | null>(
    () => readCachedClockEnabled()
  );
  useEffect(() => {
    let cancelled = false;
    fetch("/api/users/me", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (cancelled) return;
        const enabled = d?.user?.clockEnabled === false ? false : true;
        setClockEnabled(enabled);
        writeCachedClockEnabled(enabled);
      })
      .catch(() => {
        // Network failure — if we have a cached value, trust it.
        // Otherwise default to "enabled" so the clock-using majority
        // doesn't lose access on a flaky connection.
        if (cancelled) return;
        setClockEnabled((cur) => (cur === null ? true : cur));
      });
    return () => { cancelled = true; };
  }, []);

  const { clock, toggleShift, tick } = useClock();
  void tick;
  // Hide while we genuinely don't know (first ever launch, no cache)
  // AND when the cached/fetched value says disabled.
  if (clockEnabled !== true) return null;
  const open = clock.open;
  const liveElapsed = open ? Date.now() - new Date(open.startedAt).getTime() : 0;
  // Workday remaining ticks down live while on shift. We anchor it to the
  // last poll's workdayRemainingMs and subtract the seconds since we got
  // it (only while a shift is open; otherwise it's frozen).
  const remainingMs = open
    ? Math.max(0, clock.workdayRemainingMs - liveElapsed + (open.startedAt ? 0 : 0))
    : clock.workdayRemainingMs;
  void remainingMs;
  // Actually: workdayRemainingMs from the server already accounts for the
  // open segment up to the moment of the request. The smooth countdown
  // = workdayRemainingMs as of last poll, minus (now - lastPollAt). We
  // don't track lastPollAt explicitly — instead just show the polled
  // value; it updates every 10s. Good enough for a "Workday remaining"
  // pill — precision-to-the-second is unnecessary.
  const wrHours = clock.workdayRemainingMs / 3_600_000;
  const dailyCap = clock.dailyCapacityHours;
  const pctUsed = Math.min(1, Math.max(0, 1 - wrHours / Math.max(1, dailyCap)));

  return (
    <div className="px-3 pt-3 space-y-2">
      <div className="text-[10px] uppercase tracking-[0.18em] text-accent font-semibold flex items-center justify-between">
        <span>Time clock</span>
        <span className="text-muted normal-case font-medium tracking-normal">
          {formatHMS(clock.todayMs)} today
        </span>
      </div>
      {open ? (
        <button
          onClick={toggleShift}
          className="w-full inline-flex items-center justify-between gap-2 px-3 py-2.5 rounded-xl bg-gradient-to-r from-emerald-500 to-teal-500 text-white shadow-sm hover:shadow-lift transition-all active:scale-[0.98]"
        >
          <span className="inline-flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-white anim-pulse-dot" />
            <span className="text-[13px] font-semibold">
              {open.taskId ? "On task" : "On shift"}
            </span>
          </span>
          <span className="text-[13px] font-mono tabular-nums">
            {formatHMS(liveElapsed)}
          </span>
          <span className="inline-flex items-center gap-1 text-[11px] font-medium opacity-90">
            <Square className="w-3 h-3" />
            Clock out
          </span>
        </button>
      ) : (
        <button
          onClick={toggleShift}
          className="w-full inline-flex items-center justify-center gap-2 px-3 py-2.5 rounded-xl border border-slate-200 bg-white text-ink hover:border-accent/40 hover:bg-accent/5 transition-colors"
        >
          <Play className="w-4 h-4 text-accent" />
          <span className="text-[13px] font-semibold">Clock in</span>
        </button>
      )}
      <div>
        <div className="flex items-center justify-between text-[10px] text-muted">
          <span>Workday remaining</span>
          <span className="font-mono tabular-nums text-ink/80">
            {wrHours.toFixed(1)}h / {dailyCap}h
          </span>
        </div>
        <div className="h-1.5 rounded-full bg-slate-100 overflow-hidden mt-1">
          <div
            className={
              "h-full rounded-full transition-all " +
              (pctUsed > 0.85
                ? "bg-rose-500"
                : pctUsed > 0.7
                ? "bg-amber-400"
                : "bg-emerald-500")
            }
            style={{ width: `${Math.round(pctUsed * 100)}%` }}
          />
        </div>
      </div>
    </div>
  );
}

// Tiny inline Start/Stop pill for a task row inside the widget panel. Uses
// the shared ClockProvider so all rows agree on which task is active.
function TaskTimerButton({ taskId, compact = false }: { taskId: string; compact?: boolean }) {
  const { clock, startTask, stopTask, tick } = useClock();
  void tick;
  const isActive = clock.open?.taskId === taskId;
  const hoursToday = clock.hoursByTask?.[taskId] ?? 0;
  const liveBoost =
    isActive && clock.open
      ? (Date.now() - new Date(clock.open.startedAt).getTime()) / 3_600_000
      : 0;
  // The server-side hoursByTask already includes the open segment up to
  // its computation time; adding liveBoost would double-count for ~10s
  // until the next poll. Cheap fix: only show the polled value; it
  // refreshes every 10s.
  void liveBoost;
  const onClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (isActive) stopTask(taskId);
    else startTask(taskId);
  };
  if (compact) {
    return (
      <button
        type="button"
        onClick={onClick}
        title={isActive ? "Stop timer" : "Start timer"}
        className={
          "inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium transition-all active:scale-95 border " +
          (isActive
            ? "bg-emerald-500 border-emerald-600 text-white"
            : "bg-white border-slate-200 text-slate-600 hover:border-accent/40 hover:text-accent")
        }
      >
        {isActive ? <Square className="w-2.5 h-2.5" /> : <Play className="w-2.5 h-2.5" />}
        <span className="tabular-nums">
          {hoursToday > 0 ? `${hoursToday.toFixed(1)}h` : isActive ? "stop" : "start"}
        </span>
      </button>
    );
  }
  return (
    <button
      type="button"
      onClick={onClick}
      className={
        "inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-[11px] font-medium transition-all active:scale-95 border " +
        (isActive
          ? "bg-emerald-500 border-emerald-600 text-white"
          : "bg-white border-slate-200 text-slate-700 hover:border-accent/40 hover:text-accent")
      }
    >
      {isActive ? <Square className="w-3 h-3" /> : <Play className="w-3 h-3" />}
      {isActive ? "Stop timer" : "Start timer"}
      {hoursToday > 0 && (
        <span className="ml-1 text-[10px] opacity-80 tabular-nums">{hoursToday.toFixed(1)}h today</span>
      )}
    </button>
  );
}

/* ============================ PANEL ============================ */

function Panel({
  tasks, unacked, kudos, notifications, emails, eom, birthdays, onAck, onAckKudos, onDismissNotif,
  onDismissEmail, onMarkAllEmailsSeen, onCollapse, onUpdated,
  widgetIconUrl, onIconChanged, online
}: {
  tasks: WidgetTask[];
  unacked: WidgetTask[];
  kudos: WidgetKudos[];
  notifications: WidgetNotification[];
  emails: WidgetEmail[];
  eom: EomState;
  birthdays: {
    hasBirthday: boolean;
    celebrantsToday: { id: string; name: string; avatarUrl: string | null; isMe: boolean }[];
  };
  onAck: (id: string) => void;
  onAckKudos: (id: string) => void;
  onDismissNotif: (id: string) => void;
  onDismissEmail: (id: string) => void;
  onMarkAllEmailsSeen: () => void;
  onCollapse: () => void;
  onUpdated: () => void;
  widgetIconUrl: string | null;
  onIconChanged: () => void;
  // Clock-in state — true when the user is actively on a shift. Used
  // by the panel header to render a small green presence dot next to
  // the brand text. Optional so older callers without the prop don't
  // become invalid; defaults to false.
  online?: boolean;
}) {
  void online; // Header rendering will read this once the panel-dot UI lands.
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [showingSettings, setShowingSettings] = useState(false);
  // Whether this desktop shell exposes the openMainWindow IPC (deep-link a
  // thread). Read in an effect, never at render — /widget is prerendered, so
  // `window` is undefined during the build pass. Older .exe shells whose preload
  // predates openMainWindow return false, so the email row below renders as a
  // plain card (the "Got it" button still dismisses) instead of a pointer that
  // does nothing.
  const [canOpenThreads, setCanOpenThreads] = useState(false);
  useEffect(() => { setCanOpenThreads(!!(window as any).widgetAPI?.openMainWindow); }, []);
  // Emails get their own tab so a stack of email cards doesn't push the task
  // lists below the fold. The toggle only appears when there are unseen emails;
  // deriving `tab` from emails.length means dismissing the last email falls back
  // to Tasks and hides the toggle with no extra bookkeeping. Panel unmounts on
  // collapse, so this resets to "tasks" every time the widget is opened.
  const [panelTab, setPanelTab] = useState<"tasks" | "emails">("tasks");
  const tab = emails.length > 0 ? panelTab : "tasks";
  const acked = tasks.filter((t) => !t.needsAck).sort(
    (a, b) => PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority]
  );

  const selected = selectedId ? tasks.find((t) => t.id === selectedId) : null;
  if (selected) {
    return (
      <UpdateView
        task={selected}
        onClose={() => setSelectedId(null)}
        onUpdated={() => { onUpdated(); setSelectedId(null); }}
      />
    );
  }

  if (showingSettings) {
    return (
      <SettingsView
        onClose={() => setShowingSettings(false)}
        onIconChanged={onIconChanged}
        widgetIconUrl={widgetIconUrl}
      />
    );
  }

  if (creating) {
    return (
      <CreateTaskView
        onClose={() => setCreating(false)}
        onCreated={() => { onUpdated(); setCreating(false); }}
      />
    );
  }

  return (
    <div className="h-screen w-screen p-5 anim-fade-in">
      <div className="h-full w-full flex flex-col text-slate-900 rounded-[28px] overflow-hidden border border-slate-200/70 bg-white shadow-[0_20px_60px_-20px_rgba(15,23,42,0.25),0_8px_24px_-12px_rgba(15,23,42,0.15)]">
        <div
          className="h-12 flex items-center justify-between px-4 border-b border-slate-100"
          // @ts-ignore — Electron-only
          style={{ WebkitAppRegion: "drag" }}
        >
          <div className="flex items-center gap-2 text-xs">
            <div className="w-6 h-6 rounded-full overflow-hidden border border-slate-200 ring-1 ring-white shadow-sm">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={widgetIconUrl || "/widget-icon.png"} alt="" className="w-full h-full object-cover" draggable={false} />
            </div>
            <span className="font-semibold text-ink">Scaled Operations</span>
          </div>
          <div className="flex items-center gap-0.5" style={{ WebkitAppRegion: "no-drag" } as any}>
            <button
              title="New task"
              onClick={() => setCreating(true)}
              className="p-1.5 rounded-lg text-accent hover:bg-accent hover:text-white transition-colors"
            >
              <Plus className="w-3.5 h-3.5" />
            </button>
            <button
              title="Settings"
              onClick={() => setShowingSettings(true)}
              className="p-1.5 rounded-lg text-slate-500 hover:text-ink hover:bg-slate-100 transition-colors"
            >
              <SettingsIcon className="w-3.5 h-3.5" />
            </button>
            <button title="Collapse" className="p-1.5 rounded-lg text-slate-500 hover:text-ink hover:bg-slate-100 transition-colors" onClick={onCollapse}>
              <Minus className="w-3.5 h-3.5" />
            </button>
            <button title="Hide" className="p-1.5 rounded-lg text-slate-500 hover:text-ink hover:bg-slate-100 transition-colors" onClick={() => (window as any).widgetAPI?.hide?.()}>
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>

        <PresenceRow />
        <ClockSection />

        {/* Tasks | Emails toggle — only shown when there are unseen emails, so
            the panel is unchanged for users with none. Mirrors the PresenceRow
            pill idiom. Pinned here (not in the scroll area) so switching is
            always one tap away. */}
        {emails.length > 0 && (
          <div className="px-3 pt-3">
            <div className="grid grid-cols-2 gap-1">
              <button
                onClick={() => setPanelTab("tasks")}
                className={
                  "flex items-center justify-center gap-1.5 px-2 py-1.5 rounded-xl text-[11px] font-semibold transition-all border " +
                  (tab === "tasks"
                    ? "bg-gradient-to-r from-slate-700 to-slate-800 text-white border-transparent shadow-sm"
                    : "bg-white border-slate-200/70 text-ink/65 hover:text-ink hover:border-slate-300 hover:bg-slate-50")
                }
              >
                Tasks
                {unacked.length > 0 && (
                  <span className={"inline-flex items-center justify-center min-w-[16px] h-4 px-1 rounded-full text-[10px] font-bold " + (tab === "tasks" ? "bg-white/25 text-white" : "bg-amber-100 text-amber-700")}>{unacked.length}</span>
                )}
              </button>
              <button
                onClick={() => setPanelTab("emails")}
                className={
                  "flex items-center justify-center gap-1.5 px-2 py-1.5 rounded-xl text-[11px] font-semibold transition-all border " +
                  (tab === "emails"
                    ? "bg-gradient-to-r from-sky-500 to-cyan-500 text-white border-transparent shadow-sm"
                    : "bg-white border-slate-200/70 text-ink/65 hover:text-ink hover:border-slate-300 hover:bg-slate-50")
                }
              >
                <Mail className="w-3.5 h-3.5" /> Emails
                <span className={"inline-flex items-center justify-center min-w-[16px] h-4 px-1 rounded-full text-[10px] font-bold " + (tab === "emails" ? "bg-white/25 text-white" : "bg-sky-100 text-sky-700")}>{emails.length}</span>
              </button>
            </div>
          </div>
        )}

        {/* Everything below scrolls — including kudos, banners, birthdays,
            today's focus, and the task list. Status + clock stay pinned
            up top so the widget always shows the bits the user needs to
            interact with first, even when the task list grows long. */}
        <div className="flex-1 overflow-y-auto">
          {tab === "tasks" && eom.isMe && <EomBanner month={eom.month} />}
          {tab === "tasks" && birthdays.celebrantsToday.length > 0 && (
            <BirthdayBanner celebrants={birthdays.celebrantsToday} />
          )}
          {tab === "tasks" && !birthdays.hasBirthday && <BirthdayPrompt onSaved={onUpdated} />}
          {tab === "tasks" && notifications.length > 0 && (
            <div className="px-3 pt-3">
              <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-violet-600 mb-2 inline-flex items-center gap-1.5">
                <Bell className="w-3 h-3" /> Mentions · {notifications.length}
              </div>
              <div className="space-y-2">
                {notifications.map((n, i) => (
                  <div
                    key={n.id}
                    role="button"
                    onClick={() => setSelectedId(n.taskId)}
                    style={{ animationDelay: `${i * 35}ms` }}
                    className="wg-card anim-fade-in-up rounded-2xl bg-gradient-to-br from-violet-50 to-blue-50/60 border border-violet-200/80 p-3 cursor-pointer hover:bg-violet-100/40 transition-colors shadow-sm"
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <div className="text-[11px] font-semibold text-violet-700">
                          {n.from?.name ?? "Someone"} {n.kind === "mention" ? "mentioned you" : "pinged you"}
                        </div>
                        <div className="text-[13px] text-slate-900 leading-snug mt-0.5">{n.taskTitle}</div>
                        {n.note && (
                          <div className="text-[11px] text-slate-600 mt-1 line-clamp-2 italic">"{n.note}"</div>
                        )}
                      </div>
                      <button
                        onClick={(e) => { e.stopPropagation(); onDismissNotif(n.id); }}
                        className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full bg-white/85 hover:bg-white text-violet-700 text-[11px] font-medium border border-violet-300/70 transition-all active:scale-95 shrink-0"
                      >
                        <Check className="w-3 h-3" /> Got it
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
          {tab === "tasks" && kudos.length > 0 && (
            <div className="px-3 pt-3">
              <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-fuchsia-600 mb-2 inline-flex items-center gap-1.5">
                <Sparkles className="w-3 h-3" /> Kudos · {kudos.length}
              </div>
              <div className="space-y-2">
                {kudos.map((k, i) => (
                  <div
                    key={k.id}
                    style={{ animationDelay: `${i * 35}ms` }}
                    className="wg-card anim-fade-in-up rounded-2xl p-3 border bg-gradient-to-br from-fuchsia-50 to-pink-50/60 border-fuchsia-200/70 shadow-sm"
                  >
                    <div className="flex items-start gap-2.5">
                      <div className="text-2xl shrink-0 leading-none mt-0.5">
                        {k.emoji || "👏"}
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="text-[11px] font-semibold text-fuchsia-700">
                          {k.from?.name ?? "Someone"} sent you a kudos
                        </div>
                        <div className="text-[13px] text-slate-900 leading-snug mt-0.5">
                          {k.message}
                        </div>
                      </div>
                      <button
                        onClick={() => onAckKudos(k.id)}
                        className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full bg-white/85 hover:bg-white text-fuchsia-700 text-[11px] font-medium border border-fuchsia-300/70 transition-all active:scale-95 shrink-0"
                      >
                        <Check className="w-3 h-3" /> Thanks
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {tab === "emails" && (
            <div className="px-3 pt-3">
              <div className="mb-2 flex items-center justify-between">
                <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-sky-600 inline-flex items-center gap-1.5">
                  <Mail className="w-3 h-3" /> Emails · {emails.length}
                </div>
                {emails.length > 1 && (
                  <button
                    onClick={onMarkAllEmailsSeen}
                    className="text-[10px] font-medium text-sky-700 hover:text-sky-900"
                  >
                    Mark all seen
                  </button>
                )}
              </div>
              <div className="space-y-2">
                {emails.map((e, i) => (
                  <div
                    key={e.id}
                    role={canOpenThreads ? "button" : undefined}
                    onClick={canOpenThreads ? () => {
                      (window as any).widgetAPI?.openMainWindow?.(inboxThreadPath(e.accountId, e.threadId));
                      onDismissEmail(e.id);
                    } : undefined}
                    style={{ animationDelay: `${i * 35}ms` }}
                    className={"wg-card anim-fade-in-up rounded-2xl bg-gradient-to-br from-sky-50 to-cyan-50/60 border border-sky-200/80 p-3 transition-colors shadow-sm" + (canOpenThreads ? " cursor-pointer hover:bg-sky-100/40" : "")}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <div className="text-[11px] font-semibold text-sky-700 truncate">
                          {e.fromName || e.fromEmail || "New email"}
                        </div>
                        <div className="text-[13px] text-slate-900 leading-snug mt-0.5 truncate">
                          {e.subject || "(no subject)"}
                        </div>
                        {e.preview && (
                          <div className="text-[11px] text-slate-600 mt-1 line-clamp-2">{e.preview}</div>
                        )}
                      </div>
                      <button
                        onClick={(ev) => { ev.stopPropagation(); onDismissEmail(e.id); }}
                        className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full bg-white/85 hover:bg-white text-sky-700 text-[11px] font-medium border border-sky-300/70 transition-all active:scale-95 shrink-0"
                      >
                        <Check className="w-3 h-3" /> Got it
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {tab === "tasks" && unacked.length > 0 && (
            <div className="px-3 pt-3">
              <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-amber-600 mb-2 inline-flex items-center gap-1.5">
                <AlertTriangle className="w-3 h-3" /> Action required · {unacked.length}
              </div>
              <div className="space-y-2">
                {unacked.map((t, i) => (
                  <div
                    key={t.id}
                    role="button"
                    onClick={() => setSelectedId(t.id)}
                    style={{ animationDelay: `${i * 35}ms` }}
                    className="wg-card anim-fade-in-up rounded-2xl bg-amber-50 border border-amber-200/80 p-3 cursor-pointer hover:bg-amber-100/70 transition-colors shadow-sm"
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="text-[13px] font-medium leading-snug">{t.title}</div>
                      <span className="badge-pill">{t.priority}</span>
                    </div>
                    {t.description && <div className="text-[11px] text-slate-600 mt-1 line-clamp-2">{t.description}</div>}
                    <div className="mt-2 flex items-center justify-between text-[11px] text-slate-500">
                      <span className="inline-flex items-center gap-1"><Clock className="w-3 h-3" /><Countdown iso={t.dueDate} /></span>
                      <div className="flex items-center gap-1.5">
                        <TaskTimerButton taskId={t.id} compact />
                        <button
                          onClick={(e) => { e.stopPropagation(); onAck(t.id); }}
                          className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full bg-emerald-500 hover:bg-emerald-600 text-white text-[11px] font-medium transition-all active:scale-90"
                        >
                          <Check className="w-3 h-3" /> Acknowledge
                        </button>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {tab === "tasks" && acked.length > 0 && (
            <div className="px-3 pt-4 pb-3">
              <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-accent mb-2 inline-flex items-center gap-1.5">
                <Bell className="w-3 h-3" /> Today's focus
              </div>
              <div className="space-y-2">
                {acked.map((t, i) => (
                  <div
                    key={t.id}
                    role="button"
                    onClick={() => setSelectedId(t.id)}
                    style={{ animationDelay: `${(unacked.length + i) * 35}ms` }}
                    className={"wg-card anim-fade-in-up rounded-2xl bg-white p-3 border cursor-pointer hover:border-accent/30 hover:shadow-sm transition-all " + (t.inactiveFlag ? "border-amber-300/70" : "border-slate-200/70")}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="text-[13px] leading-snug font-medium">{t.title}</div>
                      <span className="badge-pill">{t.priority}</span>
                    </div>
                    <div className="mt-1.5 flex items-center justify-between text-[11px] text-slate-500">
                      <span className="inline-flex items-center gap-1"><Clock className="w-3 h-3" /><Countdown iso={t.dueDate} /></span>
                      <span className="text-slate-400">
                        {typeof t.actualHours === "number" && t.actualHours > 0
                          ? `${t.actualHours.toFixed(1)} / ${t.estimatedHours}h`
                          : `est ${t.estimatedHours}h`}
                      </span>
                    </div>
                    <div className="mt-2 flex justify-end" onClick={(e) => e.stopPropagation()}>
                      <TaskTimerButton taskId={t.id} compact />
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {tab === "tasks" && unacked.length === 0 && acked.length === 0 && kudos.length === 0 && (
            <div className="text-xs text-slate-400 text-center py-10">All clear.</div>
          )}
        </div>

        <div className="border-t border-slate-100 px-4 py-2 flex items-center justify-between text-[11px] text-slate-600">
          <button onClick={() => (window as any).widgetAPI?.openMain?.()} className="font-medium text-accent hover:text-accent/80 transition-colors">Open full app →</button>
          <span className="text-slate-400">tap a card to update</span>
        </div>

        <style>{`
          .badge-pill {
            display: inline-flex; align-items: center; padding: 1px 8px;
            border-radius: 999px; font-size: 10px; font-weight: 500; border: 1px solid;
            background: #F1F5F9; color: #475569; border-color: #E2E8F0;
          }
        `}</style>
      </div>
    </div>
  );
}

/* ============================ UPDATE VIEW ============================ */

const STATUS_OPTIONS: { value: string; label: string; tone: string }[] = [
  { value: "pending",            label: "Pending",            tone: "border-slate-300 bg-slate-50 text-slate-700" },
  { value: "in_progress",        label: "In progress",        tone: "border-blue-300 bg-blue-50 text-blue-800" },
  { value: "urgent",             label: "Urgent",             tone: "border-rose-300 bg-rose-50 text-rose-700" },
  { value: "waiting_on_client",  label: "Waiting on client",  tone: "border-amber-300 bg-amber-50 text-amber-800" },
  { value: "done",               label: "Done",               tone: "border-emerald-300 bg-emerald-50 text-emerald-800" }
];

function UpdateView({
  task, onClose, onUpdated
}: {
  task: WidgetTask;
  onClose: () => void;
  onUpdated: () => void;
}) {
  const [status, setStatus] = useState<string>(task.status);
  const [comment, setComment] = useState("");
  // MediaPicker handles uploads itself; we just hold the resulting URLs.
  const [media, setMedia] = useState<TaskMedia[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const dirty = status !== task.status || comment.trim().length > 0 || media.length > 0;

  async function save() {
    if (!dirty || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      // First image among the picked files goes onto the activity-log
      // row as image_url (back-compat with the conversation thumbnail).
      // All files — image or not — also land on task.media_urls via
      // addMediaUrls so they show up on the detail page gallery.
      const firstImage = media.find((m) => (m.contentType ?? "").startsWith("image/"));
      const imageUrl = firstImage?.url ?? null;
      const addMediaUrls = media.length > 0 ? media : undefined;

      const res = await fetch(`/api/tasks/${task.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status, comment: comment.trim() || null, imageUrl, addMediaUrls })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? "save failed");

      onUpdated();
    } catch (e) {
      setError(e instanceof Error ? e.message : "failed");
      setSubmitting(false);
    }
  }

  return (
    <div className="h-screen w-screen p-5 anim-slide-in-right">
      <div className="h-full w-full flex flex-col bg-white text-slate-900 rounded-[28px] overflow-hidden border border-slate-200 shadow-[0_20px_60px_-20px_rgba(0,0,0,0.35),0_8px_24px_-12px_rgba(0,0,0,0.2)]">
        <div
          className="h-10 flex items-center justify-between px-2 border-b border-slate-100"
          // @ts-ignore — Electron-only
          style={{ WebkitAppRegion: "drag" }}
        >
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-slate-500 hover:text-slate-900 hover:bg-slate-100 transition-colors"
            // @ts-ignore
            style={{ WebkitAppRegion: "no-drag" } as any}
            title="Back"
          >
            <ArrowLeft className="w-4 h-4" />
          </button>
          <div className="text-xs font-medium text-slate-700 truncate flex-1 text-center px-2">Update task</div>
          <button
            onClick={() => (window as any).widgetAPI?.hide?.()}
            className="p-1.5 rounded-lg text-slate-400 hover:text-slate-700 hover:bg-slate-100"
            // @ts-ignore
            style={{ WebkitAppRegion: "no-drag" } as any}
            title="Hide"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-3 space-y-3">
          <div>
            <div className="flex items-start justify-between gap-2">
              <div className="text-sm font-semibold leading-snug">{task.title}</div>
              <span className="badge-pill shrink-0">{task.priority}</span>
            </div>
            {task.description && (
              <div className="text-[11px] text-slate-600 mt-1 line-clamp-3 whitespace-pre-wrap">{task.description}</div>
            )}
            <div className="mt-1.5 flex items-center justify-between gap-2">
              <div className="text-[11px] text-slate-500 inline-flex items-center gap-1">
                <Clock className="w-3 h-3" />
                <Countdown iso={task.dueDate} className="text-[11px]" />
                <span className="ml-2 text-slate-400 tabular-nums">
                  {typeof task.actualHours === "number" && task.actualHours > 0
                    ? `${task.actualHours.toFixed(1)} / ${task.estimatedHours}h`
                    : `est ${task.estimatedHours}h`}
                </span>
              </div>
              <TaskTimerButton taskId={task.id} />
            </div>
          </div>

          <div>
            <div className="text-[10px] font-medium text-slate-500 uppercase tracking-wide mb-1.5">New status</div>
            <div className="grid grid-cols-2 gap-1.5">
              {STATUS_OPTIONS.map((s) => (
                <button
                  key={s.value}
                  type="button"
                  onClick={() => setStatus(s.value)}
                  className={
                    "text-left text-[11px] px-2.5 py-1.5 rounded-lg border transition-all duration-150 active:scale-[0.97] " +
                    (status === s.value
                      ? `${s.tone} font-medium ring-1 ring-inset ring-slate-400/20 scale-[1.01]`
                      : "border-slate-200 hover:border-slate-300 text-slate-700")
                  }
                >
                  {s.label}
                  {s.value === task.status && status !== s.value && <span className="text-[9px] ml-1 text-slate-400">(now)</span>}
                </button>
              ))}
            </div>
          </div>

          <div>
            <div className="text-[10px] font-medium text-slate-500 uppercase tracking-wide mb-1.5">Comment <span className="text-slate-400 normal-case">(optional)</span></div>
            <textarea
              className="w-full px-2.5 py-2 text-xs rounded-lg bg-white border border-slate-200 placeholder:text-slate-400 focus:outline-none focus:border-slate-400 min-h-[60px]"
              placeholder="What changed? Anything blocking?"
              value={comment}
              onChange={(e) => setComment(e.target.value)}
            />
          </div>

          <div>
            <div className="text-[10px] font-medium text-slate-500 uppercase tracking-wide mb-1.5">Attachments <span className="text-slate-400 normal-case">(optional)</span></div>
            <MediaPicker
              value={media}
              onChange={setMedia}
              taskId={task.id}
              compact
              label="Add files"
            />
          </div>
        </div>

        <div className="border-t border-slate-100 p-2 flex items-center gap-2">
          {error && <span className="text-[10px] text-rose-600 truncate flex-1">⚠ {error}</span>}
          <div className="ml-auto flex items-center gap-1.5">
            <button
              onClick={onClose}
              className="px-3 py-1.5 text-xs rounded-lg border border-slate-200 hover:bg-slate-50 transition-colors active:scale-[0.97]"
              disabled={submitting}
            >
              Cancel
            </button>
            <button
              onClick={save}
              disabled={!dirty || submitting}
              className="px-3 py-1.5 text-xs rounded-lg bg-slate-900 text-white hover:bg-slate-700 disabled:opacity-50 disabled:cursor-not-allowed transition-all active:scale-[0.97]"
            >
              {submitting ? "Saving…" : "Save"}
            </button>
          </div>
        </div>

        <style>{`
          .badge-pill {
            display: inline-flex; align-items: center; padding: 1px 8px;
            border-radius: 999px; font-size: 10px; font-weight: 500; border: 1px solid;
            background: #F1F5F9; color: #475569; border-color: #E2E8F0;
          }
        `}</style>
      </div>
    </div>
  );
}

function fmtDate(iso: string | null) {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/* ============================ CREATE TASK VIEW ============================ */

interface WidgetUser {
  id: string;
  name: string;
  email: string;
  avatarUrl?: string | null;
  // Role + memberships drive the department picker and assignee scoping
  // (workers self-assign only). /api/users carries these for everyone.
  role: "leader" | "department_head" | "worker";
  isAdmin?: boolean;
  departmentIds: string[];
  managerId?: string | null;
}

interface WidgetDept {
  id: string;
  name: string;
}

// Slim view of /api/clients — only what the Website picker needs.
interface WidgetClient {
  name: string;
  website: string | null;
  websites: string[];
}

const PRIORITY_OPTIONS: { value: "low" | "medium" | "high" | "critical"; label: string; tone: string }[] = [
  { value: "low",      label: "Low",      tone: "border-slate-300 bg-slate-50 text-slate-700" },
  { value: "medium",   label: "Medium",   tone: "border-blue-300 bg-blue-50 text-blue-800" },
  { value: "high",     label: "High",     tone: "border-amber-300 bg-amber-50 text-amber-800" },
  { value: "critical", label: "Critical", tone: "border-rose-300 bg-rose-50 text-rose-700" }
];

// Full-screen create-task view inside the widget. Mirrors UpdateView's
// layout (title strip, scrollable body, footer). Submits POST /api/tasks
// then bounces back to the panel so the new task appears in the list.

function CreateTaskView({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [priority, setPriority] = useState<"low" | "medium" | "high" | "critical">("medium");
  const [estimateHours, setEstimateHours] = useState<number>(2);
  const [assigneeId, setAssigneeId] = useState<string>("");
  const [departmentId, setDepartmentId] = useState<string>("");
  const [users, setUsers] = useState<WidgetUser[]>([]);
  const [departments, setDepartments] = useState<WidgetDept[]>([]);
  const [me, setMe] = useState<WidgetUser | null>(null);
  const [media, setMedia] = useState<TaskMedia[]>([]);
  const [busy, setBusy] = useState(false);
  // Tags / client / website — populated either manually or by "Analyze
  // attachment with AI" below. Sent on submit (the /api/tasks POST already
  // accepts all three); the browser NewTaskForm carries the same fields.
  const [tags, setTags] = useState<string[]>([]);
  const [clientName, setClientName] = useState("");
  const [website, setWebsite] = useState("");
  // Canonical client roster — drives the Website picker so the user can
  // select a client's site (primary + the `websites` array, e.g. the
  // Villa cohort) instead of retyping a URL. Same source the browser
  // NewTaskForm reads; the widget hydrates it directly (no TeamProvider).
  const [clientRoster, setClientRoster] = useState<WidgetClient[]>([]);
  // Open-state for the Client autocomplete panel (mirrors NewTaskForm).
  const [clientDropdownOpen, setClientDropdownOpen] = useState(false);
  // "Analyze attachment with AI" — reads an attached screenshot/image with
  // Claude vision (shared POST /api/tasks/analyze-attachment) and pre-fills
  // the form. It only POPULATES fields, never submits — the user still
  // reviews and clicks "Create task". Loading/error/notice drive the button
  // + a small banner.
  const [analyzing, setAnalyzing] = useState(false);
  const [analyzeError, setAnalyzeError] = useState<string | null>(null);
  const [analyzeNotice, setAnalyzeNotice] = useState<string | null>(null);
  // The first image attachment, if any — what "Analyze" reads.
  const firstImage = useMemo(() => findFirstImage(media), [media]);

  // Pull the roster, departments, and current user together. The widget
  // has no TeamProvider/UserProvider (unlike the main app's NewTaskForm),
  // so we hydrate from the same APIs directly. The current user's role +
  // department memberships come from finding ourselves in the roster
  // (/api/users carries departmentIds for everyone; /api/users/me only
  // tells us *which* id is us).
  useEffect(() => {
    let cancelled = false;
    Promise.all([
      fetch("/api/users", { cache: "no-store" }).then((r) => (r.ok ? r.json() : { users: [] })),
      fetch("/api/departments", { cache: "no-store" }).then((r) => (r.ok ? r.json() : { departments: [] })),
      fetch("/api/users/me", { cache: "no-store" }).then((r) => (r.ok ? r.json() : null))
    ])
      .then(([usersData, deptData, meData]) => {
        if (cancelled) return;
        const pool: WidgetUser[] = usersData?.users ?? [];
        setUsers(pool);
        setDepartments(
          (deptData?.departments ?? []).map((d: { id: string; name: string }) => ({ id: d.id, name: d.name }))
        );
        const myId: string | undefined = meData?.user?.id;
        const self = pool.find((u) => u.id === myId) ?? null;
        // Fall back to the /me payload if the roster join didn't surface us
        // (defensive — /api/users lists everyone, so this is rare).
        setMe(
          self ??
            (meData?.user
              ? {
                  id: meData.user.id,
                  name: meData.user.name,
                  email: meData.user.email,
                  avatarUrl: meData.user.avatarUrl ?? null,
                  role: meData.user.role,
                  isAdmin: meData.user.isAdmin === true,
                  departmentIds: [],
                  managerId: null
                }
              : null)
        );
      })
      .catch(() => { /* widget still works; submit surfaces any real error */ });
    return () => { cancelled = true; };
  }, []);

  // Client roster for the Website picker. Fetched separately so a slow or
  // failed /api/clients never blocks the roster/department hydration above.
  useEffect(() => {
    let cancelled = false;
    fetch("/api/clients", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : { clients: [] }))
      .then((d) => {
        if (cancelled) return;
        setClientRoster(((d.clients ?? []) as WidgetClient[])
          .map((c) => ({ name: c.name, website: c.website ?? null, websites: c.websites ?? [] })));
      })
      .catch(() => { /* picker just stays empty — Website is still free-text */ });
    return () => { cancelled = true; };
  }, []);

  // Website suggestions for the datalist. The selected client's own sites
  // come first; every other client's sites follow as a fallback.
  const websiteOptions = useMemo(() => {
    const match = clientRoster.find(
      (c) => c.name.toLowerCase() === clientName.trim().toLowerCase()
    );
    const own = match
      ? [match.website, ...match.websites].filter((s): s is string => !!s && s.trim().length > 0)
      : [];
    const rest = clientRoster
      .flatMap((c) => [c.website, ...c.websites])
      .filter((s): s is string => !!s && s.trim().length > 0);
    return Array.from(new Set([...own, ...rest]));
  }, [clientRoster, clientName]);

  // Client autocomplete (mirrors NewTaskForm). The widget has no live
  // task pool, so suggestions come purely from the canonical roster.
  const clientMatches = useMemo(() => {
    const q = clientName.trim().toLowerCase();
    const names = clientRoster.map((c) => c.name);
    if (!q) return names.slice(0, 10);
    return names.filter((n) => n.toLowerCase().includes(q)).slice(0, 10);
  }, [clientRoster, clientName]);
  // Pick a client from the panel. Auto-fills the website iff we know one
  // for this client and the user hasn't already typed one — their typing
  // always wins (same rule as NewTaskForm).
  function pickClient(name: string) {
    setClientName(name);
    setClientDropdownOpen(false);
    const c = clientRoster.find((x) => x.name === name);
    const site = c?.website ?? c?.websites[0] ?? null;
    if (site && !website.trim()) setWebsite(site);
  }

  // Department scoping mirrors NewTaskForm (and the /api/tasks server gate):
  //   - leaders/admins may target any department,
  //   - department heads may switch among the departments they lead,
  //   - workers are locked to their own department and self-assign only.
  const canDelegate = me ? (isLeader(me as unknown as User) || isHead(me as unknown as User)) : false;
  const canPickDept = me ? canChooseDepartment(me as unknown as User) : false;
  const selectableDepartments = useMemo(
    () => (me ? assignableDepartments(me as unknown as User, departments as unknown as Department[]) : []),
    [me, departments]
  );
  const hasNoDepartment = !!me && !isLeader(me as unknown as User) && me.departmentIds.length === 0;

  // Auto-pick the caller's home department on open, clamped to what they're
  // allowed to choose (mirrors NewTaskForm's effect).
  useEffect(() => {
    if (!me) return;
    if (isLeader(me as unknown as User)) {
      if (!departmentId && departments.length > 0) setDepartmentId(departments[0].id);
      return;
    }
    const ownIds = me.departmentIds;
    if (ownIds.length === 0) return; // hasNoDepartment banner handles this
    if (!departmentId || !ownIds.includes(departmentId)) setDepartmentId(ownIds[0]);
  }, [me, departments, departmentId]);

  // Assignee options: people the caller may delegate to, narrowed to the
  // selected department — only show assignees from that team.
  const assigneeOptions = useMemo(() => {
    if (!me) return [] as WidgetUser[];
    const targets = assignableTargets(me as unknown as User, users as unknown as User[]) as unknown as WidgetUser[];
    if (!departmentId) return targets;
    return targets.filter((u) => u.departmentIds.includes(departmentId));
  }, [me, users, departmentId]);

  // Keep the selection coherent with role + department:
  //   - workers are always forced onto themselves (no picker),
  //   - a delegator's pick is cleared when it leaves the chosen department.
  useEffect(() => {
    if (!me) return;
    if (!canDelegate) {
      if (assigneeId !== me.id) setAssigneeId(me.id);
      return;
    }
    if (assigneeId && !assigneeOptions.some((u) => u.id === assigneeId)) {
      setAssigneeId("");
    }
  }, [me, canDelegate, assigneeOptions, assigneeId]);

  // Read the attached image with Claude vision and pre-fill the form.
  // Mirrors NewTaskForm: applies only what the AI returned, never clobbers
  // text the user already typed, and respects the same permission gates —
  // a suggested department only lands when the caller may actually pick one
  // (workers stay locked to their own dept), and assignee is left to the
  // form's own role-scoped picker. It never submits.
  async function analyzeAttachment() {
    if (analyzing) return;
    if (!firstImage) {
      setAnalyzeError("Attach an image first, then analyze it.");
      return;
    }
    setAnalyzing(true);
    setAnalyzeError(null);
    setAnalyzeNotice(null);
    try {
      const result = await requestAttachmentAnalysis(firstImage);
      const f = result.fields;
      const filled: string[] = [];
      if (f.title && !title.trim()) { setTitle(f.title); filled.push("title"); }
      if (f.description && !description.trim()) { setDescription(f.description); filled.push("description"); }
      // Department is permission-clamped server-side too; only apply it when
      // the caller can actually change it (workers are locked to their own).
      if (f.department && canPickDept) { setDepartmentId(f.department); filled.push("department"); }
      if (f.priority && PRIORITY_OPTIONS.some((p) => p.value === f.priority)) {
        setPriority(f.priority as typeof PRIORITY_OPTIONS[number]["value"]);
        filled.push("priority");
      }
      if (typeof f.estimatedHours === "number") { setEstimateHours(f.estimatedHours); filled.push("estimate"); }
      if (Array.isArray(f.tags) && f.tags.length > 0) {
        setTags((cur) => Array.from(new Set([...cur, ...f.tags!])));
        filled.push("tags");
      }
      if (f.clientName && !clientName.trim()) { setClientName(f.clientName); filled.push("client"); }
      if (f.website && !website.trim()) { setWebsite(f.website); filled.push("website"); }
      setAnalyzeNotice(buildAnalyzeNotice(filled, result));
    } catch (err) {
      setAnalyzeError(err instanceof Error ? err.message : "network error");
    } finally {
      setAnalyzing(false);
    }
  }

  async function submit() {
    if (!title.trim()) {
      toast.error("Title required");
      return;
    }
    if (hasNoDepartment) {
      toast.error("You have no department yet — ask a leader to add you to one.");
      return;
    }
    setBusy(true);
    try {
      // Workers always create for themselves; delegators send their pick.
      const effectiveAssignee = canDelegate ? assigneeId : (me?.id ?? "");
      const res = await fetch("/api/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: title.trim(),
          description: description.trim() || undefined,
          priority,
          estimatedHours: estimateHours,
          departmentId: departmentId || undefined,
          assigneeId: effectiveAssignee || undefined,
          tags,
          clientName: clientName.trim() || undefined,
          website: website.trim() || undefined,
          mediaUrls: media
        })
      });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error ?? "couldn't create task");
        return;
      }
      const mine = !!effectiveAssignee && effectiveAssignee === me?.id;
      const target = effectiveAssignee ? users.find((u) => u.id === effectiveAssignee) : null;
      toast.success(mine ? "Task created for you ✨" : target ? `Assigned to ${target.name} ✨` : "Task created ✨");
      onCreated();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "network error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="h-screen w-screen p-5 anim-fade-in">
      <div className="h-full w-full flex flex-col text-slate-900 rounded-[28px] overflow-hidden border border-slate-200/70 bg-white shadow-[0_20px_60px_-20px_rgba(15,23,42,0.25),0_8px_24px_-12px_rgba(15,23,42,0.15)]">
        {/* Header — drag region + back/close. */}
        <div
          className="h-12 flex items-center justify-between px-3 border-b border-slate-100"
          // @ts-ignore — Electron-only
          style={{ WebkitAppRegion: "drag" }}
        >
          <button
            onClick={onClose}
            className="inline-flex items-center gap-1 px-2 py-1 rounded-lg text-xs font-medium text-slate-600 hover:text-ink hover:bg-slate-100 transition-colors"
            style={{ WebkitAppRegion: "no-drag" } as any}
          >
            <ArrowLeft className="w-3.5 h-3.5" /> Back
          </button>
          <span className="text-[12px] font-semibold text-ink inline-flex items-center gap-1.5">
            <Sparkles className="w-3.5 h-3.5 text-accent" /> New task
          </span>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-slate-500 hover:text-ink hover:bg-slate-100 transition-colors"
            style={{ WebkitAppRegion: "no-drag" } as any}
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>

        {/* Form body */}
        <div className="flex-1 overflow-y-auto p-3 space-y-3">
          <div>
            <label className="text-[10px] uppercase tracking-wide font-semibold text-slate-500 px-1">Title</label>
            <input
              autoFocus
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="What needs doing?"
              className="mt-1 w-full px-3 py-2 text-[13px] bg-white border border-slate-200/80 rounded-xl outline-none focus:ring-2 focus:ring-accent/30 focus:border-accent/40 transition-all"
            />
          </div>

          <div>
            <label className="text-[10px] uppercase tracking-wide font-semibold text-slate-500 px-1">Description</label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Optional notes, links, requirements…"
              rows={3}
              className="mt-1 w-full px-3 py-2 text-[13px] bg-white border border-slate-200/80 rounded-xl outline-none focus:ring-2 focus:ring-accent/30 focus:border-accent/40 transition-all resize-none"
            />
          </div>

          <div>
            <label className="text-[10px] uppercase tracking-wide font-semibold text-slate-500 px-1">Priority</label>
            <div className="mt-1 grid grid-cols-2 gap-1.5">
              {PRIORITY_OPTIONS.map((p) => {
                const active = priority === p.value;
                return (
                  <button
                    key={p.value}
                    type="button"
                    onClick={() => setPriority(p.value)}
                    className={"text-left text-[12px] font-medium border rounded-lg px-2.5 py-1.5 transition-all active:scale-95 " +
                      (active ? p.tone : "border-slate-200 bg-white text-slate-600 hover:border-slate-300")
                    }
                  >
                    {p.label}
                  </button>
                );
              })}
            </div>
          </div>

          <div>
            <label className="text-[10px] uppercase tracking-wide font-semibold text-slate-500 px-1">Tags</label>
            <div className="mt-1 flex flex-wrap gap-1">
              {TAG_PRESETS.map((t) => {
                const on = tags.includes(t);
                return (
                  <button
                    key={t}
                    type="button"
                    onClick={() => setTags((cur) => on ? cur.filter((x) => x !== t) : [...cur, t])}
                    className={
                      "text-[11px] px-2 py-0.5 rounded-full border transition-colors active:scale-95 " +
                      (on
                        ? "bg-accent/10 border-accent/40 text-accent"
                        : "bg-white border-slate-200 text-slate-600 hover:border-slate-300")
                    }
                  >
                    #{t}
                  </button>
                );
              })}
            </div>
          </div>

          {me && !hasNoDepartment && (
            <div>
              <label className="text-[10px] uppercase tracking-wide font-semibold text-slate-500 px-1">Department</label>
              {canPickDept ? (
                <select
                  value={departmentId}
                  onChange={(e) => setDepartmentId(e.target.value)}
                  className="mt-1 w-full px-3 py-2 text-[13px] bg-white border border-slate-200/80 rounded-xl outline-none focus:ring-2 focus:ring-accent/30 focus:border-accent/40 transition-all"
                >
                  {selectableDepartments.map((d) => (
                    <option key={d.id} value={d.id}>{d.name}</option>
                  ))}
                </select>
              ) : (
                <div className="mt-1 px-3 py-2 text-[13px] bg-slate-50 border border-slate-200/80 rounded-xl text-slate-600">
                  {departments.find((d) => d.id === departmentId)?.name ?? "Your department"}
                  <span className="block text-[10px] text-slate-400 mt-0.5">
                    Locked — only leaders and heads can change it.
                  </span>
                </div>
              )}
            </div>
          )}

          <div>
            <label className="text-[10px] uppercase tracking-wide font-semibold text-slate-500 px-1">Estimate</label>
            <div className="mt-1 flex items-center gap-2">
              <input
                type="number"
                min={0.5}
                step={0.5}
                value={estimateHours}
                onChange={(e) => setEstimateHours(Math.max(0.5, Number(e.target.value) || 0))}
                className="w-20 px-2.5 py-1.5 text-[13px] bg-white border border-slate-200/80 rounded-lg outline-none focus:ring-2 focus:ring-accent/30 focus:border-accent/40 tabular-nums"
              />
              <span className="text-[11px] text-slate-500">hours</span>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-2">
            <div className="relative">
              <label className="text-[10px] uppercase tracking-wide font-semibold text-slate-500 px-1">Client</label>
              <input
                type="text"
                value={clientName}
                onChange={(e) => { setClientName(e.target.value); setClientDropdownOpen(true); }}
                onFocus={() => setClientDropdownOpen(true)}
                // Delay so a click on a panel row registers before blur closes it.
                onBlur={() => setTimeout(() => setClientDropdownOpen(false), 120)}
                onKeyDown={(e) => {
                  if (e.key === "Escape") setClientDropdownOpen(false);
                  if (e.key === "Enter" && clientDropdownOpen && clientMatches.length > 0) {
                    e.preventDefault();
                    pickClient(clientMatches[0]);
                  }
                }}
                placeholder="e.g. Acme"
                autoComplete="off"
                className="mt-1 w-full px-3 py-2 text-[13px] bg-white border border-slate-200/80 rounded-xl outline-none focus:ring-2 focus:ring-accent/30 focus:border-accent/40 transition-all"
              />
              {clientDropdownOpen && clientMatches.length > 0 && (
                <div className="absolute left-0 right-0 top-full mt-1 z-20 rounded-xl border border-slate-200 bg-white shadow-lg overflow-hidden">
                  {clientMatches.map((c) => {
                    const isExact = c.toLowerCase() === clientName.trim().toLowerCase();
                    return (
                      <button
                        key={c}
                        type="button"
                        onMouseDown={(e) => { e.preventDefault(); pickClient(c); }}
                        className={
                          "w-full text-left px-3 py-2 flex items-center gap-2 hover:bg-accent/5 transition-colors " +
                          (isExact ? "bg-accent/5" : "")
                        }
                      >
                        {/* Client name only — the site lands in the Website
                            field (auto-filled on pick), not on this row. */}
                        <span className="text-[13px] flex-1 truncate">{c}</span>
                      </button>
                    );
                  })}
                  {clientName.trim() && !clientMatches.some((c) => c.toLowerCase() === clientName.trim().toLowerCase()) && (
                    <div className="px-3 py-1.5 text-[10px] text-slate-500 border-t border-slate-100 bg-slate-50/60">
                      No match — &quot;{clientName.trim()}&quot; will be saved as a new client.
                    </div>
                  )}
                </div>
              )}
            </div>
            <div>
              <label className="text-[10px] uppercase tracking-wide font-semibold text-slate-500 px-1">Website</label>
              <input
                type="text"
                list="widget-website-options"
                value={website}
                onChange={(e) => setWebsite(e.target.value)}
                placeholder="e.g. acme.com"
                className="mt-1 w-full px-3 py-2 text-[13px] bg-white border border-slate-200/80 rounded-xl outline-none focus:ring-2 focus:ring-accent/30 focus:border-accent/40 transition-all"
              />
              <datalist id="widget-website-options">
                {websiteOptions.map((w) => <option key={w} value={w} />)}
              </datalist>
            </div>
          </div>

          <div>
            <div className="flex items-center justify-between px-1">
              <label className="text-[10px] uppercase tracking-wide font-semibold text-slate-500">Attachments</label>
              <button
                type="button"
                onClick={analyzeAttachment}
                disabled={analyzing || !firstImage}
                title={firstImage
                  ? "Read the attached image with AI and fill the form"
                  : "Attach an image first to analyze it"}
                className={
                  "inline-flex items-center gap-1 px-2 py-1 rounded-lg text-[10px] font-medium border transition-colors " +
                  (analyzing || !firstImage
                    ? "border-slate-200 text-slate-400 cursor-not-allowed"
                    : "border-accent/40 text-accent hover:bg-accent/5")
                }
              >
                <ScanText className={"w-3 h-3 " + (analyzing ? "animate-pulse" : "")} />
                {analyzing ? "Analyzing…" : "Analyze with AI"}
              </button>
            </div>
            <div className="mt-1">
              <MediaPicker
                value={media}
                onChange={setMedia}
                compact
                label="Add files"
                hint="Attach a screenshot and let AI fill the form."
              />
            </div>
            {analyzeError && (
              <div className="mt-1.5 flex items-start gap-1.5 text-[11px] text-rose-600">
                <AlertTriangle className="w-3 h-3 mt-0.5 shrink-0" />
                <span>{analyzeError}</span>
              </div>
            )}
            {analyzeNotice && (
              <div className="mt-1.5 flex items-start gap-1.5 text-[11px] text-accent">
                <Sparkles className="w-3 h-3 mt-0.5 shrink-0" />
                <span>{analyzeNotice}</span>
              </div>
            )}
          </div>

          {hasNoDepartment ? (
            <div className="rounded-xl border border-rose-200 bg-rose-50 px-3 py-2.5 text-[12px] text-rose-700">
              You don&apos;t belong to a department yet, so you can&apos;t create tasks. Ask a leader to add you to one.
            </div>
          ) : canDelegate ? (
            <div>
              <label className="text-[10px] uppercase tracking-wide font-semibold text-slate-500 px-1">Assign to</label>
              <div className="mt-1 space-y-1 max-h-44 overflow-y-auto pr-1">
                <AssigneeRow
                  userId=""
                  name="Leave unassigned"
                  email=""
                  selected={assigneeId === ""}
                  onPick={() => setAssigneeId("")}
                />
                {assigneeOptions.map((u) => (
                  <AssigneeRow
                    key={u.id}
                    userId={u.id}
                    name={u.name}
                    email={u.email}
                    avatarUrl={u.avatarUrl ?? null}
                    selected={assigneeId === u.id}
                    onPick={() => setAssigneeId(u.id)}
                  />
                ))}
                {assigneeOptions.length === 0 && (
                  <div className="px-2 py-2 text-[11px] text-slate-500">
                    No one in this department to assign to — pick another department or leave it unassigned.
                  </div>
                )}
              </div>
            </div>
          ) : (
            <div>
              <label className="text-[10px] uppercase tracking-wide font-semibold text-slate-500 px-1">Assign to</label>
              <div className="mt-1 flex items-center gap-2 px-3 py-2 rounded-xl border border-accent/30 bg-accent/5">
                {me?.avatarUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={me.avatarUrl}
                    alt={me.name}
                    className="w-6 h-6 rounded-full object-cover ring-1 ring-white shadow-sm"
                  />
                ) : (
                  <div className="w-6 h-6 rounded-full bg-gradient-to-br from-blue-200 to-blue-100 text-blue-700 grid place-items-center text-[10px] font-semibold">
                    {(me?.name ?? "?").split(" ").map((w) => w[0]).slice(0, 2).join("").toUpperCase() || "?"}
                  </div>
                )}
                <div className="flex-1 min-w-0">
                  <div className="text-[12px] font-medium truncate">{me?.name ?? "You"}</div>
                  <div className="text-[10px] text-slate-500">Assigned to you — workers create tasks for themselves.</div>
                </div>
                <Check className="w-3.5 h-3.5 text-accent shrink-0" />
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="border-t border-slate-100 px-3 py-2.5 flex items-center justify-end gap-2">
          <button
            onClick={onClose}
            className="px-3 py-1.5 rounded-full text-[11px] font-medium text-slate-600 hover:text-ink hover:bg-slate-100 transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={submit}
            disabled={busy || !title.trim() || hasNoDepartment}
            className={
              "inline-flex items-center gap-1.5 px-4 py-1.5 rounded-full text-[11px] font-semibold text-white shadow-sm transition-all hover:-translate-y-0.5 active:scale-95 " +
              (busy || !title.trim() || hasNoDepartment ? "opacity-50 cursor-not-allowed hover:translate-y-0" : "")
            }
            style={{ background: "linear-gradient(135deg, #0a4099 0%, #063270 100%)" }}
          >
            <Sparkles className="w-3 h-3" />
            {busy ? "Creating…" : "Create task"}
          </button>
        </div>
      </div>
    </div>
  );
}

function AssigneeRow({
  userId, name, email, avatarUrl, selected, onPick
}: {
  userId: string;
  name: string;
  email: string;
  avatarUrl?: string | null;
  selected: boolean;
  onPick: () => void;
}) {
  const ini = name.split(" ").map((w) => w[0]).slice(0, 2).join("").toUpperCase();
  return (
    <button
      type="button"
      onClick={onPick}
      className={
        "w-full flex items-center gap-2 px-2 py-1.5 rounded-lg text-left transition-all active:scale-[0.98] " +
        (selected
          ? "bg-accent/10 border border-accent/40 text-ink"
          : "border border-transparent hover:bg-slate-50")
      }
    >
      {userId === "" ? (
        <div className="w-6 h-6 rounded-full bg-slate-100 border border-slate-200 grid place-items-center text-[10px] text-slate-500">
          ∅
        </div>
      ) : avatarUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={avatarUrl}
          alt={name}
          className="w-6 h-6 rounded-full object-cover ring-1 ring-white shadow-sm"
        />
      ) : (
        <div className="w-6 h-6 rounded-full bg-gradient-to-br from-blue-200 to-blue-100 text-blue-700 grid place-items-center text-[10px] font-semibold">
          {ini || "?"}
        </div>
      )}
      <div className="flex-1 min-w-0">
        <div className="text-[12px] font-medium truncate">{name}</div>
        {email && <div className="text-[10px] text-slate-500 truncate">{email}</div>}
      </div>
      {selected && <Check className="w-3.5 h-3.5 text-accent shrink-0" />}
    </button>
  );
}

/* ============================ SETTINGS VIEW ============================ */

// Fetches the current user once so we can render their current avatar
// + name. The widget has no shared user-context provider so we hit
// /api/users/me directly.
interface WidgetMe {
  id: string;
  name: string;
  email: string;
}

const DEFAULT_WIDGET_ICON = "/widget-icon.png";

function SettingsView({
  onClose, widgetIconUrl, onIconChanged
}: {
  onClose: () => void;
  widgetIconUrl: string | null;
  onIconChanged: () => void;
}) {
  const [me, setMe] = useState<WidgetMe | null>(null);
  const [stagedFile, setStagedFile] = useState<File | string | null>(null);
  const [localIconUrl, setLocalIconUrl] = useState<string | null>(widgetIconUrl);
  const [signingOut, setSigningOut] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/users/me", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (cancelled || !d) return;
        setMe({
          id: d.user?.id ?? d.id ?? "",
          name: d.user?.name ?? d.name ?? "You",
          email: d.user?.email ?? d.email ?? ""
        });
        if (d.user?.widgetIconUrl !== undefined) {
          setLocalIconUrl(d.user.widgetIconUrl);
        }
      })
      .catch(() => { /* leave me=null; UI shows fallback */ });
    return () => { cancelled = true; };
  }, []);

  async function saveCroppedBlob(blob: Blob) {
    if (!me) return;
    try {
      const form = new FormData();
      const f = new File([blob], `widget-${me.id}.png`, { type: "image/png" });
      form.append("file", f);
      // Store widget icons alongside avatars but in a distinct sub-key.
      form.append("taskId", `widget-icons/${me.id}`);
      const upRes = await fetch("/api/upload", { method: "POST", body: form });
      const upData = await upRes.json();
      if (!upRes.ok) throw new Error(upData?.error ?? `upload failed (${upRes.status})`);
      const url: string = upData.url;

      const saveRes = await fetch("/api/users/me/widget-icon", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url })
      });
      const saveData = await saveRes.json();
      if (!saveRes.ok) throw new Error(saveData?.error ?? `save failed (${saveRes.status})`);

      setLocalIconUrl(url);
      setStagedFile(null);
      toast.success("Widget picture updated ✨");
      onIconChanged();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "save failed");
    }
  }

  async function resetToDefault() {
    try {
      const res = await fetch("/api/users/me/widget-icon", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: null })
      });
      if (!res.ok) {
        const d = await res.json().catch(() => null);
        throw new Error(d?.error ?? "couldn't reset");
      }
      setLocalIconUrl(null);
      toast.success("Reverted to the default");
      onIconChanged();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "couldn't reset");
    }
  }

  async function signOut() {
    setSigningOut(true);
    try {
      // Hit our auth route — same one the web /logout button uses.
      const res = await fetch("/api/auth/logout", { method: "POST" });
      if (!res.ok && res.status !== 204) {
        const d = await res.json().catch(() => null);
        throw new Error(d?.error ?? `signout failed (${res.status})`);
      }
      toast.success("Signed out");
      // Reload the widget so it re-checks auth + flips to sign-in panel.
      window.location.reload();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "signout failed");
    } finally {
      setSigningOut(false);
    }
  }

  return (
    <div className="h-screen w-screen p-5 anim-fade-in">
      <div className="h-full w-full flex flex-col text-slate-900 rounded-[28px] overflow-hidden border border-slate-200/70 bg-white shadow-[0_20px_60px_-20px_rgba(15,23,42,0.25),0_8px_24px_-12px_rgba(15,23,42,0.15)]">
        <div
          className="h-12 flex items-center justify-between px-3 border-b border-slate-100"
          // @ts-ignore — Electron-only
          style={{ WebkitAppRegion: "drag" }}
        >
          <button
            onClick={onClose}
            className="inline-flex items-center gap-1 px-2 py-1 rounded-lg text-xs font-medium text-slate-600 hover:text-ink hover:bg-slate-100 transition-colors"
            style={{ WebkitAppRegion: "no-drag" } as any}
          >
            <ArrowLeft className="w-3.5 h-3.5" /> Back
          </button>
          <span className="text-[12px] font-semibold text-ink inline-flex items-center gap-1.5">
            <SettingsIcon className="w-3.5 h-3.5 text-accent" /> Settings
          </span>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-slate-500 hover:text-ink hover:bg-slate-100 transition-colors"
            style={{ WebkitAppRegion: "no-drag" } as any}
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          {/* Widget bubble picture editor */}
          <section>
            <div className="text-[10px] uppercase tracking-wide font-semibold text-slate-500 px-1 mb-2">
              Widget bubble
            </div>
            {stagedFile ? (
              <div className="rounded-2xl border border-slate-200/70 bg-slate-50/60 p-3">
                <AvatarCropper
                  source={stagedFile}
                  previewSize={260}
                  onCancel={() => setStagedFile(null)}
                  onSave={saveCroppedBlob}
                />
              </div>
            ) : (
              <div className="flex items-center gap-3">
                {/* Live bubble preview — same 64×64 styling as the
                    floating bubble so users see exactly what they'll get. */}
                <div className="w-16 h-16 rounded-full overflow-hidden border border-slate-200 ring-2 ring-white shadow-md shrink-0">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={localIconUrl || DEFAULT_WIDGET_ICON}
                    alt="Widget bubble preview"
                    className="w-full h-full object-cover"
                  />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium">
                    {localIconUrl ? "Custom picture" : "Default brand logo"}
                  </div>
                  <div className="text-[11px] text-slate-500">
                    {localIconUrl
                      ? "Shown on the floating bubble"
                      : "Pick an image to personalize"}
                  </div>
                  <div className="mt-2 flex items-center gap-1.5 flex-wrap">
                    <button
                      type="button"
                      onClick={() => fileRef.current?.click()}
                      className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-medium bg-white border border-slate-200 hover:border-accent/40 hover:text-accent text-ink/75 transition-colors active:scale-95"
                    >
                      <Camera className="w-3 h-3" /> Choose image
                    </button>
                    {localIconUrl && (
                      <>
                        <button
                          type="button"
                          onClick={() => setStagedFile(localIconUrl)}
                          className="text-[11px] text-slate-500 hover:text-accent transition-colors px-1"
                        >
                          Re-crop
                        </button>
                        <button
                          type="button"
                          onClick={resetToDefault}
                          className="text-[11px] text-slate-500 hover:text-rose-600 transition-colors px-1"
                        >
                          Reset to default
                        </button>
                      </>
                    )}
                  </div>
                  <input
                    ref={fileRef}
                    type="file"
                    accept="image/*"
                    className="hidden"
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      if (f) setStagedFile(f);
                      if (fileRef.current) fileRef.current.value = "";
                    }}
                  />
                </div>
              </div>
            )}
            <p className="text-[10px] text-slate-500 mt-2 px-1">
              Drag the image inside the circle, scroll or pinch to zoom, then
              save. The picture you crop becomes the floating widget bubble.
            </p>
          </section>

          {/* Account section */}
          <section className="rounded-2xl border border-slate-200/70 bg-slate-50/40 p-3">
            <div className="text-[10px] uppercase tracking-wide font-semibold text-slate-500 mb-2">
              Account
            </div>
            <button
              type="button"
              onClick={signOut}
              disabled={signingOut}
              className="w-full inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded-xl text-sm font-medium border border-rose-200 bg-white text-rose-700 hover:bg-rose-50 transition-colors disabled:opacity-60"
            >
              <LogOut className="w-4 h-4" />
              {signingOut ? "Signing out…" : "Sign out"}
            </button>
          </section>
        </div>
      </div>
    </div>
  );
}
