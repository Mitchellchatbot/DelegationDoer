import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase-admin", () => ({ getSupabaseAdmin: vi.fn() }));
vi.mock("@/lib/supabase-server", () => ({ getSupabaseServer: vi.fn() }));
vi.mock("@/lib/exec/ops", () => ({ notifyOps: vi.fn() }));
vi.mock("@/lib/exec/attention-read", () => ({ listScreenedAttention: vi.fn(), getScreenedAttentionItem: vi.fn() }));
vi.mock("@/lib/exec/email-view", () => ({ getEmailTab: vi.fn() }));
// Area E's App Home line at its module boundary (brief-view.test.ts covers it per state).
vi.mock("@/lib/exec/brief-view", () => ({ getBriefHomeLine: vi.fn() }));

import { getBriefHomeLine } from "@/lib/exec/brief-view";
import { BRIEF_COPY, fillBrief } from "@/lib/exec/brief-copy";
import { listScreenedAttention } from "@/lib/exec/attention-read";
import type { ScreenedAttentionPage } from "@/lib/exec/attention-types";
import { getEmailTab } from "@/lib/exec/email-view";
import { slackHomeJobHandler } from "@/lib/exec/handlers/slack-home";
import { SLACK_COPY } from "@/lib/exec/slack-copy";
import type { SlackHomeView } from "@/lib/exec/slack-types";
import type { OwnerHomeBrief } from "@/lib/exec/slack-ui";
import { assertSlackParts, ROUTING_INSTALLATION as RI } from "../__tests__/slack-assert";
import { INST, KEY, callsOf, jobCtx, useSlack, useSlackDb } from "../__tests__/slack-jobs-harness";

// P8 contract §5.16 UI21 (Area E; the Home job is Area D's): App Home shows the brief's line from getBriefHomeLine, read
// inside the Home's 8 s section budget, with the schedule as context; a failure (or a read past the budget) falls back to
// P6's static line (SLACK_COPY.homeBrief).

const run = () => slackHomeJobHandler.run(jobCtx("exec.slack-home", { installation_id: INST, slack_user_id: RI.userId }));
const page = (): ScreenedAttentionPage => ({ items: [], nextCursor: null, hiddenEmail: 0, emailScreen: "ok" }) as unknown as ScreenedAttentionPage;
const homeText = (body: Record<string, unknown>) => JSON.stringify((JSON.parse(String(body.view)) as SlackHomeView).blocks);

beforeEach(() => {
  vi.stubEnv("EXEC_TOKEN_KEY", KEY);
  vi.stubEnv("EXEC_TOKEN_KEY_PREVIOUS", undefined);
  vi.stubEnv("EXEC_ENABLED", undefined);
  vi.stubEnv("NEXT_PUBLIC_APP_URL", undefined);
  vi.mocked(listScreenedAttention).mockResolvedValue(page());
  vi.mocked(getEmailTab).mockResolvedValue({ state: "off", generatedAt: "x", timezone: "UTC" } as never);
  useSlackDb();
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("UI21: the App Home's brief line", () => {
  const lines: [OwnerHomeBrief, string][] = [
    [{ state: "delivered", time: "8:00 AM", tz: "EST", sentAt: "8:02 AM EST" }, fillBrief(BRIEF_COPY.home.delivered, { time: "8:02 AM EST" })],
    [{ state: "none", time: "8:00 AM", tz: "EST", sentAt: null }, BRIEF_COPY.home.none],
    [{ state: "page_only", time: "8:00 AM", tz: "EST", sentAt: null }, BRIEF_COPY.home.page_only],
    // P8 fixer ui-9: getBriefHomeLine gives off / not_installed no schedule (brief-view.test.ts), so App Home shows none.
    [{ state: "off", time: "", tz: "", sentAt: null }, BRIEF_COPY.home.off],
    [{ state: "not_installed", time: "", tz: "", sentAt: null }, BRIEF_COPY.home.not_installed]
  ];
  for (const [brief, words] of lines) {
    it(`${brief.state}: its line${brief.time === "" ? ", no schedule" : " and the schedule"}, in place of P6's static line`, async () => {
      vi.mocked(getBriefHomeLine).mockResolvedValue(brief);
      const slack = useSlack();
      await run();
      const publish = callsOf(slack.calls, "views.publish");
      const text = homeText(publish[0].body);
      expect(text).toContain(words);
      if (brief.time === "") expect(text).not.toContain(fillBrief(BRIEF_COPY.homeSchedule, { time: "8:00 AM", tz: "EST" }).slice(0, 8));
      else expect(text).toContain(fillBrief(BRIEF_COPY.homeSchedule, { time: "8:00 AM", tz: "EST" }));
      expect(text).not.toContain(SLACK_COPY.homeBrief);
      assertSlackParts(JSON.parse(String(publish[0].body.view)) as SlackHomeView);
      slack.restore();
    });
  }

  it("the line is read with the principal and settings (loadSettings) at the job's clock", async () => {
    vi.mocked(getBriefHomeLine).mockResolvedValue(lines[0][0]);
    const slack = useSlack();
    await run();
    const [p, settings, now] = vi.mocked(getBriefHomeLine).mock.calls[0];
    expect(p.id).toBeTruthy();
    expect(settings).toHaveProperty("briefEnabled");
    expect(now).toBeInstanceOf(Date);
    slack.restore();
  });

  it("a failure → P6's static line, and the Home still publishes", async () => {
    vi.mocked(getBriefHomeLine).mockRejectedValue(new Error("exec_briefs read failed"));
    const slack = useSlack();
    expect(await run()).toEqual({ view: "owner", items: 0 });
    expect(homeText(callsOf(slack.calls, "views.publish")[0].body)).toContain(SLACK_COPY.homeBrief);
    slack.restore();
  });

  it("a read past the 8 s budget → P6's static line (the Home doesn't wait for it)", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    vi.mocked(getBriefHomeLine).mockReturnValue(new Promise<OwnerHomeBrief>(() => {}));
    const slack = useSlack();
    const done = run();
    await vi.advanceTimersByTimeAsync(8_500);
    expect(await done).toEqual({ view: "owner", items: 0 });
    expect(homeText(callsOf(slack.calls, "views.publish")[0].body)).toContain(SLACK_COPY.homeBrief);
    slack.restore();
  });
});
