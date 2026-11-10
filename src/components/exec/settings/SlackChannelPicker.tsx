"use client";

import { useEffect, useId, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Hash, Lock, Search } from "lucide-react";
import { SLACK_READ_COPY } from "@/lib/exec/slack-read-copy";
import type { DenyReason, WatchState } from "@/lib/exec/slack-read-types";
import type { SlackPickerTags } from "@/lib/exec/slack-page";
import type { PickerRow, SlackReadingView } from "@/lib/exec/slack-types";
import type { WatchMode } from "@/lib/exec/types";
import { setChannelWatch, setWatchMode, type ChannelWatchResult } from "@/lib/exec/ui/settings-api";
import { cn } from "@/lib/utils";
import { useIsTopWindow } from "../drafts/frame-guard";
import { SlackChannelTags } from "./SlackChannelTags";
import { refreshWithoutResult } from "./SlackConnectControls";

// The Settings channel picker (P7a contract §3.16, C29, N11, N12, C10; Area
// E). A client island the server SlackReadingSection renders while reading is
// set up (paused or on). Top-level only (P4's useIsTopWindow): framed, every
// row and the watch mode are plain text and nothing can be clicked.
//
//   * The watch mode: "Only conversations I'm in" / "Also active public
//     channels" (watchModeHelp), PUT /api/exec/slack/watch-mode with the
//     settings version the page read; success refreshes the page.
//   * Summary rows, not interactive: direct messages and group DMs as
//     "{watched} of {total} read", and the never-read conversations as a
//     count with a count per reason (neverReasons; never a name: N1).
//   * A filter box (client-side, by name).
//   * DD's own channels (hubs) with badgeHub and no control.
//   * Every other row: #name, its badges (Private, Slack Connect, Finance for
//     class finance or a finance-named Slack Connect channel, Not a member),
//     its activity, and Watch / Mute / Don't watch. A row that can't change
//     (unclassified, a private conversation he left) has no control. A finance
//     row's Watch opens the finance confirm (financeConfirmTitle,
//     financeConfirmBody, "Watch" / "Cancel") and sends confirm
//     "finance_channel". Changes are optimistic: the row moves at once and is
//     reverted on a failure (pickerFailed); a 409 conflict re-renders the row
//     from the answer and says so (pickerConflict).
// At 390 px wide the badges wrap under the name and the control stays one row.
//
// P7b (contract §3.17.6 P7a-6, §3.12.4, AM-P7b-6): with `tags` (a serializable
// data prop the server builds: slack-page.ts getSlackPickerTags), each row with
// an entry renders SlackChannelTags under it: his client and project tags and
// the name rule's verdict. A function slot can't cross from the server section
// into this client island, and PickerRow has no convType or leftAt, so C25's
// `taggable` comes computed from the P7a ChannelRow; a row he has just set to
// Don't watch here is greyed at once (RPC 1 refuses it anyway). Without `tags`
// (P7b's schema missing, or its reads failed) the picker is P7a's, unchanged.
//
// Imports only client-safe modules (B-P7a-8 / P5a rule 16): the copy, the
// pure settings-api, the frame guard, P7b's client SlackChannelTags; types
// only from slack-types, slack-read-types and (P7b) slack-page.

type Choice = { state: WatchState; label: string };
export const WATCH_CHOICES: readonly Choice[] = Object.freeze([
  { state: "watched", label: SLACK_READ_COPY.watchLabel },
  { state: "muted", label: SLACK_READ_COPY.muteLabel },
  { state: "unwatched", label: SLACK_READ_COPY.unwatchLabel }
]);

const fill = (template: string, values: Record<string, string | number>): string =>
  Object.entries(values).reduce((s, [k, v]) => s.split(`{${k}}`).join(String(v)), template);

/** "#name"; a row without a stored name (an id-only row) shows its id. */
export function channelLabel(row: Pick<PickerRow, "name" | "channelId">): string {
  return row.name.length > 0 ? `#${row.name}` : row.channelId;
}

/** C10/C45: the finance treatment for class finance OR a finance-named (Slack Connect) channel. */
export const isFinanceRow = (row: Pick<PickerRow, "class" | "financeName">): boolean => row.class === "finance" || row.financeName === true;

/** The badges a row carries, in display order. */
export function pickerBadges(row: PickerRow): string[] {
  const out: string[] = [];
  if (row.class === "hub") out.push(SLACK_READ_COPY.badgeHub);
  if (row.kind === "private") out.push(SLACK_READ_COPY.badgePrivate);
  if (row.class === "external") out.push(SLACK_READ_COPY.badgeExternal);
  if (isFinanceRow(row)) out.push(SLACK_READ_COPY.badgeFinance);
  if (!row.isMember) out.push(SLACK_READ_COPY.badgeNotMember);
  return out;
}

/** The client-side filter: a case-insensitive match on the name (or the id); blank keeps every row. */
export function filterPickerRows(rows: readonly PickerRow[], query: string): PickerRow[] {
  const q = typeof query === "string" ? query.trim().toLowerCase().replace(/^#/, "") : "";
  if (q.length === 0) return [...rows];
  return rows.filter((r) => r.name.toLowerCase().includes(q) || r.channelId.toLowerCase().includes(q));
}

/** The never-read counts by reason, merged by label (fb_list and lead_name are both "lead channels"), in the copy's order. */
export function neverReasonLines(byReason: Partial<Record<DenyReason, number>>): { label: string; n: number }[] {
  const out: { label: string; n: number }[] = [];
  for (const reason of Object.keys(SLACK_READ_COPY.neverReasons) as DenyReason[]) {
    const n = byReason?.[reason];
    if (typeof n !== "number" || !Number.isFinite(n) || n <= 0) continue;
    const label = SLACK_READ_COPY.neverReasons[reason];
    const prior = out.find((l) => l.label === label);
    if (prior) prior.n += n;
    else out.push({ label, n });
  }
  return out;
}

/** Whether choosing `next` for this row needs the finance confirmation first (C10). */
export function needsFinanceConfirm(row: PickerRow, next: WatchState): boolean {
  return next === "watched" && row.watchState !== "watched" && isFinanceRow(row);
}

/** The muted row's source, as exec_slack_set_watch stores it: a finance row's mute is the closed finance mute (C10, N1;
 *  P7a fixer security-1: never an owner mute a DM or a mention could bypass), anything else is his. */
export const muteSourceFor = (row: Pick<PickerRow, "class" | "financeName">): "owner" | "default_finance" => (isFinanceRow(row) ? "default_finance" : "owner");

/** The optimistic move: the row in its new state, everything else as it was. */
export function withWatch(rows: readonly PickerRow[], channelId: string, next: WatchState): PickerRow[] {
  return rows.map((r) => (r.channelId === channelId ? { ...r, watchState: next, muteSource: next === "muted" ? muteSourceFor(r) : null } : r));
}

/** ui-8: the "Showing {shown} of {total}" line when the 1,000-row cap cut the list (hubs and other rows alike), else null. */
export function pickerShowingText(view: Pick<SlackReadingView, "channels" | "counts">): string | null {
  const c = view.counts;
  const total = c.watched + c.muted + c.unwatched + c.hubs;
  return view.channels.length < total ? fill(SLACK_READ_COPY.pickerShowing, { shown: view.channels.length, total }) : null;
}

/** ui-9 (the ARIA radio pattern): the option a key moves to from the checked one; null for any other key. */
export function watchChoiceKey(key: string, current: WatchState): WatchState | null {
  const i = WATCH_CHOICES.findIndex((c) => c.state === current);
  if (i < 0) return null;
  const n = WATCH_CHOICES.length;
  if (key === "ArrowRight" || key === "ArrowDown") return WATCH_CHOICES[(i + 1) % n].state;
  if (key === "ArrowLeft" || key === "ArrowUp") return WATCH_CHOICES[(i + n - 1) % n].state;
  if (key === "Home") return WATCH_CHOICES[0].state;
  if (key === "End") return WATCH_CHOICES[n - 1].state;
  return null;
}

/** P9 F35: the option a key event came from (its data-picker-choice), or null when the target isn't one of them. */
export function focusedWatchChoice(target: unknown): WatchState | null {
  const attr = typeof target === "object" && target !== null && typeof (target as { getAttribute?: unknown }).getAttribute === "function"
    ? (target as { getAttribute: (name: string) => string | null }).getAttribute("data-picker-choice")
    : null;
  return WATCH_CHOICES.some((c) => c.state === attr) ? (attr as WatchState) : null;
}

/**
 * The rows after the channels route answered: updated → the answer's row; conflict → the answer's row (or the row as
 * it was) and pickerConflict; confirmation_required → the row as it was, and open the finance confirm; failed → the row
 * as it was and the failure's words.
 */
export function rowsAfterAnswer(
  rows: readonly PickerRow[],
  prior: PickerRow,
  result: ChannelWatchResult
): { rows: PickerRow[]; message: string | null; finance: boolean } {
  const put = (row: PickerRow) => rows.map((r) => (r.channelId === prior.channelId ? row : r));
  switch (result.kind) {
    case "updated":
      return { rows: put(result.channel), message: null, finance: false };
    case "conflict":
      return { rows: put(result.channel ?? prior), message: result.message, finance: false };
    case "confirmation_required":
      return { rows: put(prior), message: null, finance: true };
    default:
      return { rows: put(prior), message: result.message, finance: false };
  }
}

function Badge({ children, tone = "slate" }: { children: string; tone?: "slate" | "amber" | "indigo" | "emerald" }) {
  const cls = {
    slate: "border-slate-200 bg-slate-50 text-slate-700",
    amber: "border-amber-200 bg-amber-50 text-amber-800",
    indigo: "border-indigo-200 bg-indigo-50 text-indigo-700",
    emerald: "border-emerald-200 bg-emerald-50 text-emerald-700"
  }[tone];
  return <span className={cn("inline-flex items-center rounded-md border px-1.5 py-0.5 text-[10.5px] font-semibold leading-none", cls)}>{children}</span>;
}

const badgeTone = (label: string): "slate" | "amber" | "indigo" | "emerald" =>
  label === SLACK_READ_COPY.badgeFinance ? "amber" : label === SLACK_READ_COPY.badgeExternal ? "indigo" : label === SLACK_READ_COPY.badgeHub ? "emerald" : "slate";

const stateWords = (s: WatchState): string => (s === "watched" ? SLACK_READ_COPY.watchLabel : s === "muted" ? SLACK_READ_COPY.muteLabel : SLACK_READ_COPY.unwatchLabel);

function RowName({ row }: { row: PickerRow }) {
  const Icon = row.kind === "private" ? Lock : Hash;
  const badges = pickerBadges(row);
  return (
    <div className="min-w-0 flex-1 basis-56">
      <p className="flex min-w-0 items-center gap-1 text-[13px] font-semibold text-ink">
        <Icon className="h-3.5 w-3.5 shrink-0 text-slate-400" aria-hidden />
        <span className="min-w-0 break-all">{row.name.length > 0 ? row.name : row.channelId}</span>
      </p>
      {(badges.length > 0 || row.activity30d !== null) && (
        <div className="mt-1 flex flex-wrap items-center gap-1.5">
          {badges.map((b) => (
            <Badge key={b} tone={badgeTone(b)}>
              {b}
            </Badge>
          ))}
          {row.activity30d !== null && <span className="text-[11.5px] text-muted">{fill(SLACK_READ_COPY.activity, { n: row.activity30d })}</span>}
        </div>
      )}
    </div>
  );
}

function WatchControl({ row, disabled, onChoose, watchRef }: { row: PickerRow; disabled: boolean; onChoose: (next: WatchState) => void;
  watchRef?: (el: HTMLButtonElement | null) => void }) {
  // ui-9: one tab stop per row (the checked option); the arrow keys move between the three (the ARIA radio pattern).
  // P9 F35: the arrows (and Home/End) move focus ONLY: every choice is a server write, and ArrowLeft from Mute on a private
  // or Slack Connect channel would have turned model triage on. Space or Enter on the focused option (its click) commits it.
  const buttons = useRef<Partial<Record<WatchState, HTMLButtonElement | null>>>({});
  return (
    <div
      role="radiogroup"
      aria-label={channelLabel(row)}
      data-picker-control
      onKeyDown={(e) => {
        const next = watchChoiceKey(e.key, focusedWatchChoice(e.target) ?? row.watchState);
        if (next === null || disabled) return;
        e.preventDefault();
        buttons.current[next]?.focus();
      }}
      className="inline-flex shrink-0 overflow-hidden rounded-lg border border-slate-200 bg-white"
    >
      {WATCH_CHOICES.map((c, i) => {
        const on = row.watchState === c.state;
        return (
          <button
            key={c.state}
            ref={(el) => {
              buttons.current[c.state] = el;
              if (c.state === "watched") watchRef?.(el);
            }}
            type="button"
            role="radio"
            aria-checked={on}
            tabIndex={on ? 0 : -1}
            data-picker-choice={c.state}
            disabled={disabled}
            onClick={() => {
              if (!on) onChoose(c.state);
            }}
            className={cn(
              "inline-flex min-h-10 items-center whitespace-nowrap px-2.5 py-1 text-[12px] font-semibold disabled:cursor-not-allowed disabled:opacity-60 sm:min-h-0",
              i > 0 && "border-l border-slate-200",
              on ? "bg-indigo-600 text-white" : "text-slate-700 hover:bg-slate-50"
            )}
          >
            {c.label}
          </button>
        );
      })}
    </div>
  );
}

/** The finance confirm (C10): watching a finance channel shows its items only in DD, never on a Slack surface or in drafts. */
export function FinanceConfirm({ row, pending, onConfirm, onCancel, autoFocus = true }: { row: PickerRow; pending: boolean; onConfirm: () => void; onCancel: () => void; autoFocus?: boolean }) {
  const id = useId();
  const titleRef = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    if (autoFocus) titleRef.current?.focus();
  }, [autoFocus]);
  return (
    <div
      role="group"
      aria-labelledby={`${id}-t`}
      aria-describedby={`${id}-b`}
      data-finance-confirm={row.channelId}
      onKeyDown={(e) => {
        if (e.key !== "Escape" || pending) return;
        e.preventDefault();
        e.stopPropagation();
        onCancel();
      }}
      className="mt-2 w-full space-y-2 rounded-xl border border-amber-200 bg-amber-50 px-3.5 py-3"
    >
      <p ref={titleRef} id={`${id}-t`} tabIndex={-1} className="text-[13px] font-semibold text-amber-950 outline-none">
        {SLACK_READ_COPY.financeConfirmTitle}
      </p>
      <p id={`${id}-b`} className="text-[12.5px] leading-relaxed text-amber-950">
        {SLACK_READ_COPY.financeConfirmBody}
      </p>
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          data-finance-confirm-watch
          onClick={onConfirm}
          disabled={pending}
          className="rounded-lg bg-indigo-600 px-3 py-1.5 text-[12.5px] font-semibold text-white hover:bg-indigo-700 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {pending ? "Saving…" : SLACK_READ_COPY.watchLabel}
        </button>
        <button
          type="button"
          data-finance-confirm-cancel
          onClick={onCancel}
          disabled={pending}
          className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-[12.5px] font-semibold text-slate-700 hover:border-slate-300 disabled:opacity-50"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

export function SlackChannelPicker({
  view,
  initialFinanceConfirm = null,
  initialFilter = "",
  tags = null,
  initialTagsOpen = null
}: {
  view: Pick<SlackReadingView, "channels" | "counts" | "watchMode" | "settingsVersion">;
  /** P7b (P7a-6, AM-P7b-6): the per-row tags data; null or absent renders no tags (P7a's picker as it was). */
  tags?: SlackPickerTags | null;
  /** Static renders only (tests, screenshots): this channel's tags editor open on first render. The page never passes it. */
  initialTagsOpen?: string | null;
  /** Static renders only (tests, screenshots): the finance confirm open for this channel id. The page never passes it. */
  initialFinanceConfirm?: string | null;
  /** Static renders only: the filter box's text. */
  initialFilter?: string;
}) {
  const isTop = useIsTopWindow();
  const router = useRouter();
  const [rows, setRows] = useState<PickerRow[]>(view.channels);
  const [filter, setFilter] = useState(initialFilter);
  const [pending, setPending] = useState<string | null>(null);
  const [messages, setMessages] = useState<Partial<Record<string, string>>>({});
  const [finance, setFinance] = useState<string | null>(initialFinanceConfirm);
  const [mode, setMode] = useState<WatchMode>(view.watchMode);
  const [modePending, setModePending] = useState(false);
  const [modeMessage, setModeMessage] = useState<string | null>(null);
  const filterId = useId();
  const modeName = useId();
  const modeHelpId = useId();
  // ui-9: each row's Watch button, so a closing finance confirm hands focus back to the row it came from (never <body>).
  const watchButtons = useRef(new Map<string, HTMLButtonElement>());
  const financeWas = useRef<string | null>(finance);
  useEffect(() => {
    const was = financeWas.current;
    financeWas.current = finance;
    if (finance === null && was !== null) watchButtons.current.get(was)?.focus();
  }, [finance]);

  // A refresh re-reads the rows and the mode: the island follows them.
  useEffect(() => setRows(view.channels), [view.channels]);
  useEffect(() => setMode(view.watchMode), [view.watchMode]);

  const hubs = rows.filter((r) => r.class === "hub");
  const others = filterPickerRows(
    rows.filter((r) => r.class !== "hub"),
    isTop ? filter : ""
  );
  const never = neverReasonLines(view.counts.neverByReason);
  const showing = pickerShowingText(view);

  async function choose(row: PickerRow, next: WatchState, confirmed: boolean) {
    if (pending !== null || !row.canChange) return;
    if (!confirmed && needsFinanceConfirm(row, next)) {
      setFinance(row.channelId);
      return;
    }
    setPending(row.channelId);
    setMessages((m) => ({ ...m, [row.channelId]: undefined }));
    setRows((rs) => withWatch(rs, row.channelId, next));
    const result = await setChannelWatch(row.channelId, { watchState: next, expectedVersion: row.version, confirm: confirmed ? "finance_channel" : undefined });
    setPending(null);
    setRows((rs) => rowsAfterAnswer(rs, row, result).rows);
    const outcome = rowsAfterAnswer([row], row, result);
    setFinance(outcome.finance ? row.channelId : null);
    setMessages((m) => ({ ...m, [row.channelId]: outcome.message ?? undefined }));
  }

  async function changeMode(next: WatchMode) {
    if (modePending || next === mode) return;
    const before = mode;
    setMode(next);
    setModePending(true);
    setModeMessage(null);
    const r = await setWatchMode(next, view.settingsVersion);
    setModePending(false);
    // ui-4: the refresh drops ?slack= / ?who= (a banner about an earlier step).
    if (r.kind === "saved") {
      refreshWithoutResult(() => router.refresh());
      return;
    }
    setMode(before);
    setModeMessage(r.message);
    if (r.kind === "conflict") refreshWithoutResult(() => router.refresh());
  }

  return (
    <div data-picker className="space-y-3">
      <div data-picker-watch-mode={mode} className="space-y-1.5">
        {isTop ? (
          <div role="radiogroup" aria-label={SLACK_READ_COPY.watchModeLabel} aria-describedby={modeHelpId} className="flex flex-col gap-1.5">
            {(["member_only", "active_public"] as const).map((m) => (
              <label key={m} className="flex items-start gap-2 text-[12.5px] text-ink">
                <input
                  type="radio"
                  name={modeName}
                  value={m}
                  data-picker-mode={m}
                  checked={mode === m}
                  disabled={modePending}
                  onChange={() => void changeMode(m)}
                  className="mt-0.5 h-4 w-4 shrink-0 border-slate-300"
                />
                <span className="min-w-0">{m === "member_only" ? SLACK_READ_COPY.watchModeMember : SLACK_READ_COPY.watchModeActive}</span>
              </label>
            ))}
          </div>
        ) : (
          <p className="text-[12.5px] font-medium text-ink">{mode === "member_only" ? SLACK_READ_COPY.watchModeMember : SLACK_READ_COPY.watchModeActive}</p>
        )}
        <p id={modeHelpId} className="text-[12px] text-muted">
          {SLACK_READ_COPY.watchModeHelp}
        </p>
        <p aria-live="polite" role="status" data-picker-mode-message className="text-[12px] text-rose-700">
          {modeMessage ?? ""}
        </p>
      </div>

      <ul data-picker-summary className="divide-y divide-slate-100 rounded-xl border border-slate-100 bg-slate-50/60 text-[12.5px]">
        <li data-picker-dms className="px-3 py-2 text-slate-700">
          {fill(SLACK_READ_COPY.pickerDms, { watched: view.counts.dms.watched, total: view.counts.dms.total })}
        </li>
        <li data-picker-group-dms className="px-3 py-2 text-slate-700">
          {fill(SLACK_READ_COPY.pickerGroupDms, { watched: view.counts.groupDms.watched, total: view.counts.groupDms.total })}
        </li>
        <li data-picker-never={view.counts.never} className="px-3 py-2">
          <p className="font-medium text-ink">{fill(SLACK_READ_COPY.pickerNever, { n: view.counts.never })}</p>
          {never.length > 0 && (
            <ul className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-[12px] text-muted">
              {never.map((l) => (
                <li key={l.label} data-picker-never-reason>{`${l.label}: ${l.n}`}</li>
              ))}
            </ul>
          )}
        </li>
      </ul>

      {hubs.length > 0 && (
        <ul data-picker-hubs className="divide-y divide-slate-100">
          {hubs.map((row) => (
            <li key={row.channelId} data-picker-hub={row.channelId} className="flex flex-wrap items-start justify-between gap-x-3 gap-y-2 py-2.5">
              <RowName row={row} />
            </li>
          ))}
        </ul>
      )}

      {showing !== null && (
        <p data-picker-showing className="text-[12px] text-muted">
          {showing}
        </p>
      )}

      {isTop && (
        <div className="relative">
          <label htmlFor={filterId} className="sr-only">
            {SLACK_READ_COPY.pickerFilter}
          </label>
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" aria-hidden />
          <input
            id={filterId}
            type="search"
            data-picker-filter
            placeholder={SLACK_READ_COPY.pickerFilter}
            value={filter}
            onChange={(e) => setFilter(e.currentTarget.value)}
            className="w-full rounded-lg border border-slate-200 bg-white py-1.5 pl-8 pr-2.5 text-[13px] text-ink placeholder:text-slate-400 focus:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-100"
          />
        </div>
      )}

      <ul data-picker-rows className="divide-y divide-slate-100">
        {others.map((row) => (
          <li key={row.channelId} data-picker-row={row.channelId} data-picker-state={row.watchState} className="py-2.5">
            <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
              <RowName row={row} />
              {row.canChange && isTop ? (
                <WatchControl
                  row={row}
                  disabled={pending !== null || finance !== null}
                  onChoose={(next) => void choose(row, next, false)}
                  watchRef={(el) => {
                    if (el) watchButtons.current.set(row.channelId, el);
                    else watchButtons.current.delete(row.channelId);
                  }}
                />
              ) : (
                <span data-picker-readonly className="shrink-0 text-[12px] font-medium text-slate-600">
                  {stateWords(row.watchState)}
                </span>
              )}
            </div>
            {isTop && finance === row.channelId && row.canChange && (
              <FinanceConfirm
                row={row}
                pending={pending === row.channelId}
                onConfirm={() => void choose(row, "watched", true)}
                onCancel={() => setFinance(null)}
                autoFocus={initialFinanceConfirm === null}
              />
            )}
            {tags !== null && tags.byChannel[row.channelId] !== undefined && (
              <SlackChannelTags
                channelId={row.channelId}
                taggable={tags.byChannel[row.channelId].taggable && row.watchState !== "unwatched"}
                links={tags.byChannel[row.channelId].links}
                clients={tags.clients}
                projects={tags.projects}
                initialOpen={initialTagsOpen === row.channelId}
              />
            )}
            <p aria-live="polite" role="status" data-picker-message={row.channelId} className="text-[12px] text-rose-700">
              {messages[row.channelId] ?? ""}
            </p>
          </li>
        ))}
      </ul>
    </div>
  );
}
