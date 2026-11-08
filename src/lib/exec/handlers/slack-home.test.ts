import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase-admin", () => ({ getSupabaseAdmin: vi.fn() }));
vi.mock("@/lib/supabase-server", () => ({ getSupabaseServer: vi.fn() }));
vi.mock("@/lib/exec/ops", () => ({ notifyOps: vi.fn() }));
// P5a's screened accessor and P3's email tab at their module boundary; P2b's unscreened listAttention spied (HM01).
vi.mock("@/lib/exec/attention-read", () => ({ listScreenedAttention: vi.fn(), getScreenedAttentionItem: vi.fn() }));
vi.mock("@/lib/exec/attention", async (orig) => ({ ...(await orig<typeof import("@/lib/exec/attention")>()), listAttention: vi.fn() }));
vi.mock("@/lib/exec/email-view", () => ({ getEmailTab: vi.fn() }));
vi.mock("@/lib/exec/slack-ui", async (orig) => {
  const actual = await orig<typeof import("@/lib/exec/slack-ui")>();
  return { ...actual, renderOwnerHome: vi.fn(actual.renderOwnerHome) };
});

import { listAttention } from "@/lib/exec/attention";
import { listScreenedAttention } from "@/lib/exec/attention-read";
import type { AttentionFeedItem, ScreenedAttentionPage } from "@/lib/exec/attention-types";
import { getEmailTab, type EmailTabView } from "@/lib/exec/email-view";
import { homeItemHref, slackHomeJobHandler } from "@/lib/exec/handlers/slack-home";
import { SLACK_COPY } from "@/lib/exec/slack-copy";
import type { SlackHomeView } from "@/lib/exec/slack-types";
import { renderNeutralHome, renderOwnerHome } from "@/lib/exec/slack-ui";

import { assertSlackParts, findSentinel, ROUTING_INSTALLATION as RI, SENTINELS } from "../__tests__/slack-assert";
import { INST, KEY, PRINCIPAL, callsOf, jobCtx, useSlack, useSlackDb, type Harness } from "../__tests__/slack-jobs-harness";

// P6 contract §5.8 (K13, C28-C30, C40): HM01-HM07, App Home.

const ORIGIN = "https://operations.scaledai.org";
const run = (user: string = RI.userId) => slackHomeJobHandler.run(jobCtx("exec.slack-home", { installation_id: INST, slack_user_id: user }));
let h: Harness;
let spies: ReturnType<typeof vi.spyOn>[];

const item = (over: Partial<AttentionFeedItem> & { band?: "critical" | "high" | "normal" } = {}): AttentionFeedItem => {
  const { band = "high", ...rest } = over;
  return { id: "ea_1", title: "Acme renewal is overdue", priority: { band, score: 80 }, refs: [], ...rest } as unknown as AttentionFeedItem;
};
const page = (items: AttentionFeedItem[], over: Partial<ScreenedAttentionPage> = {}): ScreenedAttentionPage => ({ items, nextCursor: null, hiddenEmail: 0, emailScreen: "ok", ...over });
const emailOn = (over: Record<string, unknown> = {}): EmailTabView =>
  ({
    state: "on", generatedAt: "x", timezone: "America/New_York",
    buckets: { ok: true, data: { counts: { reply: 4, urgent: 1, important: 3, waiting: 2, filtered: 9 }, lists: {}, limit: 100 } },
    restricted: { ok: true, data: 2 },
    ...over
  }) as unknown as EmailTabView;
const viewOf = (body: Record<string, unknown>): SlackHomeView => JSON.parse(String(body.view)) as SlackHomeView;
const homeText = (v: SlackHomeView) => JSON.stringify(v.blocks);

beforeEach(() => {
  vi.stubEnv("EXEC_TOKEN_KEY", KEY);
  vi.stubEnv("EXEC_TOKEN_KEY_PREVIOUS", undefined);
  vi.stubEnv("EXEC_ENABLED", undefined);
  vi.stubEnv("NEXT_PUBLIC_APP_URL", undefined);
  vi.mocked(listScreenedAttention).mockReset();
  vi.mocked(listAttention).mockReset();
  vi.mocked(getEmailTab).mockReset();
  vi.mocked(renderOwnerHome).mockClear();
  h = useSlackDb();
  spies = [vi.spyOn(console, "error").mockImplementation(() => {}), vi.spyOn(console, "warn").mockImplementation(() => {})];
});
afterEach(() => {
  expect(findSentinel(spies.map((s) => s.mock.calls))).toBeNull();
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("exec.slack-home (HM01-HM07)", () => {
  it("HM01: the owner's Home reads the screened accessor (status default, 5 items) and never P2b's listAttention", async () => {
    vi.mocked(listScreenedAttention).mockResolvedValue(page([item()]));
    vi.mocked(getEmailTab).mockResolvedValue(emailOn());
    const slack = useSlack();
    expect(await run()).toEqual({ view: "owner", items: 1 });
    expect(vi.mocked(listScreenedAttention)).toHaveBeenCalledTimes(1);
    const [principal, filters, opts] = vi.mocked(listScreenedAttention).mock.calls[0];
    expect(principal).toBe(PRINCIPAL);
    expect(filters).toEqual({ status: "default", limit: 5 });
    expect(opts?.signal).toBeInstanceOf(AbortSignal);
    expect(vi.mocked(listAttention)).not.toHaveBeenCalled();
    const publish = callsOf(slack.calls, "views.publish");
    expect(publish.map((c) => c.body.user_id)).toEqual([RI.userId]);
    const home = viewOf(publish[0].body);
    assertSlackParts(home);
    expect(homeText(home)).toContain("Acme renewal is overdue");
  });

  it("HM08 (fixer ui-2): DD text a model read (blocker, waiting, decision) is labelled AI-assessed on the Home; record items aren't", async () => {
    vi.mocked(listScreenedAttention).mockResolvedValue(page([
      item({ id: "ea_1", kind: "ddtext_waiting", title: "Priya is waiting on a decision about the Q4 retainer" } as never),
      item({ id: "ea_2", kind: "ddtext_blocker", title: "The site launch is blocked on hosting" } as never),
      item({ id: "ea_3", kind: "ddtext_decision", title: "Choose the Q1 ad budget" } as never),
      item({ id: "ea_4", kind: "overdue_tasks", title: "Acme renewal is overdue" } as never)
    ]));
    vi.mocked(getEmailTab).mockResolvedValue(emailOn());
    const slack = useSlack();
    await run();
    expect(vi.mocked(renderOwnerHome).mock.calls[0][0].attention).toMatchObject({
      ok: true, items: [{ aiAssessed: true }, { aiAssessed: true }, { aiAssessed: true }, { aiAssessed: false }]
    });
    const home = viewOf(callsOf(slack.calls, "views.publish")[0].body);
    const lines = home.blocks.flatMap((b) => (b.type === "section" ? [b.text.text] : [])).filter((t) => t.startsWith("*High*"));
    expect(lines.map((l) => l.includes("_AI-assessed_"))).toEqual([true, true, true, false]);
    assertSlackParts(home);
  });

  it("HM02 (C28): an item with an allow-listed DD ref links it; otherwise (no ref, an Outlook ref, another host) the attention page", () => {
    const dd = `${ORIGIN}/tasks/t_42`;
    expect(homeItemHref(item({ refs: [{ system: "dd", id: "t_42", url: dd, label: "x", class: "internal" }] }))).toBe(dd);
    expect(homeItemHref(item({ refs: [] }))).toBe(`${ORIGIN}/executive/attention`);
    expect(homeItemHref(item({ refs: [{ system: "outlook", id: "m", url: "https://outlook.office.com/mail/inbox/id/AAMk1", label: "x", class: "private" }] }))).toBe(`${ORIGIN}/executive/attention`);
    expect(homeItemHref(item({ refs: [{ system: "dd", id: "t", url: "https://evil.example/tasks/t", label: "x", class: "internal" }] }))).toBe(`${ORIGIN}/executive/attention`);
    expect(homeItemHref(item({ refs: [{ system: "dd", id: "t", url: null, label: "x", class: "internal" }, { system: "dd", id: "t2", url: `${ORIGIN}/projects/p_1`, label: "y", class: "internal" }] }))).toBe(`${ORIGIN}/projects/p_1`);
  });

  it("HM03: email on → counts and the restricted count; off → homeEmailOff; a failed section → its failed line while the rest renders", async () => {
    vi.mocked(listScreenedAttention).mockResolvedValue(page([item()]));
    vi.mocked(getEmailTab).mockResolvedValue(emailOn());
    let slack = useSlack();
    await run();
    let home = homeText(viewOf(callsOf(slack.calls, "views.publish")[0].body));
    expect(home).toContain("Reply 4 · Urgent 1 · Important 3 · Waiting 2");
    expect(home).toContain("2 restricted-sender emails need you.");
    expect(vi.mocked(renderOwnerHome).mock.calls[0][0].email).toEqual({ state: "on", counts: { reply: 4, urgent: 1, important: 3, waiting: 2 }, restricted: 2 });
    slack.restore();

    vi.mocked(getEmailTab).mockResolvedValue({ state: "off", generatedAt: "x", timezone: "UTC" });
    slack = useSlack();
    await run();
    home = homeText(viewOf(callsOf(slack.calls, "views.publish")[0].body));
    expect(home).toContain(SLACK_COPY.homeEmailOff);
    slack.restore();

    vi.mocked(listScreenedAttention).mockRejectedValue(new Error("attention read failed"));
    vi.mocked(getEmailTab).mockResolvedValue(emailOn({ buckets: { ok: false, error: "unavailable" } }));
    slack = useSlack();
    expect(await run()).toEqual({ view: "owner", items: 0 });
    home = homeText(viewOf(callsOf(slack.calls, "views.publish")[0].body));
    expect(home).toContain(SLACK_COPY.homeAttentionFailed);
    expect(home).toContain(SLACK_COPY.homeEmailCountsFailed);
    expect(home).toContain("2 restricted-sender emails need you.");
    slack.restore();

    vi.mocked(listScreenedAttention).mockResolvedValue(page([]));
    vi.mocked(getEmailTab).mockRejectedValue(new Error("settings read failed"));
    slack = useSlack();
    await run();
    home = homeText(viewOf(callsOf(slack.calls, "views.publish")[0].body));
    expect(home).toContain(SLACK_COPY.homeNothing);
    expect(home).toContain(SLACK_COPY.homeEmailCountsFailed);
  });

  it("HM04 / C30: anyone else → the neutral view published for that user, and nothing read", async () => {
    const slack = useSlack();
    expect(await run("U0COLLEAGUE")).toEqual({ view: "neutral" });
    const publish = callsOf(slack.calls, "views.publish");
    expect(publish.map((c) => c.body.user_id)).toEqual(["U0COLLEAGUE"]);
    expect(viewOf(publish[0].body).blocks).toEqual(renderNeutralHome().blocks);
    expect(vi.mocked(listScreenedAttention)).not.toHaveBeenCalled();
    expect(vi.mocked(getEmailTab)).not.toHaveBeenCalled();
    expect(slack.calls.map((c) => c.method)).toEqual(["views.publish"]);
  });

  it("HM05: ownership is recomputed from the installation's user id, not the RPC's choice", async () => {
    vi.mocked(listScreenedAttention).mockResolvedValue(page([]));
    vi.mocked(getEmailTab).mockResolvedValue(emailOn());
    h.db.tables.exec_slack_installations[0].user_id = "U0NEWOWNER";
    let slack = useSlack();
    expect(await run(RI.userId)).toEqual({ view: "neutral" });
    slack.restore();
    slack = useSlack();
    expect(await run("U0NEWOWNER")).toMatchObject({ view: "owner" });
    expect(callsOf(slack.calls, "views.publish")[0].body.user_id).toBe("U0NEWOWNER");
  });

  it("HM06 (C40): an owner render writes one access-log row; a neutral render none", async () => {
    vi.mocked(listScreenedAttention).mockResolvedValue(page([]));
    vi.mocked(getEmailTab).mockResolvedValue(emailOn());
    useSlack();
    await run("U0COLLEAGUE");
    expect(h.db.tables.exec_access_log).toHaveLength(0);
    await run();
    expect(h.db.tables.exec_access_log).toEqual([
      expect.objectContaining({ principal_id: "ep_1", route: "slack:app_home_opened", surface: "slack", slack_user_id: RI.userId, slack_event_id: null, auth_user_id: null, session_id: null })
    ]);
  });

  it("HM07 (reuse-8, build-13): a getEmailTab that never settles → the Home is published after ~8 s with the counts-failed line; getEmailTab got no signal; every href is absolute on the DD origin", async () => {
    vi.useFakeTimers();
    vi.mocked(listScreenedAttention).mockResolvedValue(
      page([item({ refs: [{ system: "dd", id: "t_42", url: `${ORIGIN}/tasks/t_42`, label: "x", class: "internal" }] }), item({ id: "ea_2", title: SENTINELS.displayName.replace("Sentinel", "Plain") })])
    );
    vi.mocked(getEmailTab).mockImplementation(() => new Promise(() => undefined));
    const slack = useSlack();
    const pending = run();
    await vi.advanceTimersByTimeAsync(7_900);
    expect(callsOf(slack.calls, "views.publish")).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(200);
    expect(await pending).toEqual({ view: "owner", items: 2 });
    const home = homeText(viewOf(callsOf(slack.calls, "views.publish")[0].body));
    expect(home).toContain(SLACK_COPY.homeEmailCountsFailed);
    expect(vi.mocked(getEmailTab).mock.calls[0]).toHaveLength(2);
    const input = vi.mocked(renderOwnerHome).mock.calls[0][0];
    expect(input.attention.ok && input.attention.items.map((i) => i.href)).toEqual([`${ORIGIN}/tasks/t_42`, `${ORIGIN}/executive/attention`]);
    for (const href of input.attention.ok ? input.attention.items.map((i) => i.href) : []) expect(href.startsWith(`${ORIGIN}/`)).toBe(true);
    for (const m of home.matchAll(/<(https:[^|>]+)\|/g)) expect(m[1].startsWith(`${ORIGIN}/`)).toBe(true);
  });

  it("an installation that isn't active → skipped; no principal or a bad payload → skipped; auth failures recorded and rethrown", async () => {
    h.db.tables.exec_slack_installations[0].revoked_at = "2026-11-06T00:00:00.000Z";
    h.db.tables.exec_slack_installations[0].revoke_reason = "disconnected";
    let slack = useSlack();
    expect(await run()).toEqual({ skipped: "installation" });
    expect(await slackHomeJobHandler.run(jobCtx("exec.slack-home", { installation_id: INST, slack_user_id: RI.userId }, { principal: null }))).toEqual({ skipped: "no_principal" });
    expect(await slackHomeJobHandler.run(jobCtx("exec.slack-home", { installation_id: INST, slack_user_id: "nope" }))).toEqual({ skipped: "bad_payload" });
    expect(slack.calls).toHaveLength(0);
    slack.restore();

    h = useSlackDb();
    slack = useSlack({ "views.publish": () => ({ ok: false, error: "invalid_auth" }) });
    await expect(run("U0COLLEAGUE")).rejects.toMatchObject({ name: "SlackApiError", errorClass: "auth" });
    expect(h.db.tables.exec_slack_installations[0].last_error_code).toBe("invalid_auth");
    expect(h.db.tables.exec_jobs.filter((j) => j.kind === "exec.slack-uninstall")).toHaveLength(1);
  });

  it("the handler: interactive lane, 30 s", () => {
    expect(slackHomeJobHandler).toMatchObject({ kind: "exec.slack-home", lane: "interactive", timeoutMs: 30_000 });
  });
});
