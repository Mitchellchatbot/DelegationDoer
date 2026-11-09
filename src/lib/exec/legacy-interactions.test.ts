import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// P8 contract §5.2 LG11-LG14 (M1, C37): DD's legacy Slack interactions route. A Send / Rewrite click on a legacy brief of
// a day the Executive AI brief owned and delivered answers "expired" (ephemeral, through response_url) before any DB,
// model or Slack call; a gate failure answers 200 {} and changes nothing; a valid verdict runs the old path unchanged; the
// EOD recap button never asks the gate. (Route files aren't collected by vitest.config.mts, hence this test lives here.)

const gateState = vi.hoisted(() => ({ imports: 0, verdict: vi.fn() }));
const db = vi.hoisted(() => ({ from: [] as string[], updates: [] as Record<string, unknown>[], getAdmin: 0 }));

vi.mock("@/lib/exec/brief-legacy-gate", () => {
  gateState.imports += 1;
  return { legacyCheckinVerdict: gateState.verdict };
});
vi.mock("@/lib/supabase-admin", () => ({
  getSupabaseAdmin: () => {
    db.getAdmin += 1;
    return {
      from(table: string) {
        db.from.push(table);
        const b: Record<string, unknown> = {};
        for (const m of ["select", "eq", "neq", "gte", "lte", "order", "limit", "in", "is"]) b[m] = () => b;
        b.maybeSingle = async () => {
          if (table === "daily_briefings") {
            return { data: { id: "brief_2026-11-06", brief_date: "2026-11-06", update_text: "u", needle_mover: null, messages: [{ id: "m1", userId: "u_9", name: "Sam", slackId: "U0SAM0001", text: "Hey Sam", status: "pending" }], meta: {} }, error: null };
          }
          if (table === "users") return { data: { slack_user_token: "user-token-under-test" }, error: null };
          return { data: null, error: null };
        };
        b.then = (ok: (v: unknown) => unknown, bad: (e: unknown) => unknown) => Promise.resolve({ data: [], error: null }).then(ok, bad);
        b.update = (patch: Record<string, unknown>) => {
          db.updates.push(patch);
          return { eq: async () => ({ error: null }) };
        };
        return b;
      }
    };
  }
}));
vi.mock("@/lib/slack", () => ({ openView: vi.fn(), openDmAsUser: vi.fn(), postMessageAsUser: vi.fn() }));
vi.mock("@/lib/slack-resolve", () => ({ resolveSlackId: vi.fn() }));
vi.mock("@/lib/daily-briefing-runner", () => ({
  buildBriefingBlocks: vi.fn(() => ({ blocks: [], text: "brief" })),
  rewriteEngagementText: vi.fn(async () => "A fresh check-in")
}));

import * as route from "@/app/api/slack/interactions/route";
import { BRIEF_COPY } from "@/lib/exec/brief-copy";
import { rewriteEngagementText } from "@/lib/daily-briefing-runner";
import { openDmAsUser, openView, postMessageAsUser } from "@/lib/slack";

const SECRET = "legacy-signing-secret-under-test";
const RESPONSE_URL = "https://hooks.slack.com/actions/T0DD/1/abcSECRETPATH";
const fetchSpy = vi.fn(async (..._args: unknown[]) => new Response("ok"));

function signed(payload: unknown): Request {
  const body = `payload=${encodeURIComponent(JSON.stringify(payload))}`;
  const ts = String(Math.floor(Date.now() / 1000));
  const sig = `v0=${createHmac("sha256", SECRET).update(`v0:${ts}:${body}`).digest("hex")}`;
  return new Request("https://operations.scaledai.org/api/slack/interactions", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", "x-slack-request-timestamp": ts, "x-slack-signature": sig },
    body
  });
}
const click = (actionId: string, value: unknown, extra: Record<string, unknown> = {}) =>
  signed({ type: "block_actions", response_url: RESPONSE_URL, trigger_id: "1.2.abc", actions: [{ action_id: actionId, value: JSON.stringify(value) }], ...extra });
const post = (req: Request) => route.POST(req as Parameters<typeof route.POST>[0]);

beforeEach(() => {
  db.from.length = 0;
  db.updates.length = 0;
  db.getAdmin = 0;
  gateState.verdict.mockReset();
  fetchSpy.mockClear();
  vi.stubGlobal("fetch", fetchSpy);
  vi.stubEnv("SLACK_SIGNING_SECRET", SECRET);
  vi.stubEnv("EXEC_ENABLED", "true");
  vi.stubEnv("NEXT_RUNTIME", "nodejs");
  vi.mocked(openDmAsUser).mockResolvedValue("D0SAM0001");
  vi.mocked(postMessageAsUser).mockResolvedValue(undefined as never);
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("the legacy brief buttons and the Executive AI brief (C37)", () => {
  it("LG14 eod_recap_show_more never asks the gate (first: the gate module is still unloaded)", async () => {
    const res = await post(signed({ type: "block_actions", trigger_id: "1.2.abc", actions: [{ action_id: "eod_recap_show_more", value: JSON.stringify({ client: "Acme", date: "2026-11-06" }) }] }));
    expect(res.status).toBe(200);
    expect(gateState.imports).toBe(0);
    expect(gateState.verdict).not.toHaveBeenCalled();
    expect(openView).toHaveBeenCalledTimes(1);
  });

  it.each(["daily_brief_send", "daily_brief_rewrite"])("LG11 %s on an expired legacy brief: one ephemeral reply, nothing else", async (actionId) => {
    gateState.verdict.mockResolvedValue("expired");
    const res = await post(click(actionId, { b: "brief_2026-11-06", m: "m1" }));
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({});
    expect(gateState.verdict).toHaveBeenCalledWith("mitchell@scaledai.org", "brief_2026-11-06", expect.any(Date));
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(RESPONSE_URL);
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({ response_type: "ephemeral", replace_original: false, text: BRIEF_COPY.legacyExpired });
    // No daily_briefings read or write, no model call, no Slack Web API call.
    expect(db.getAdmin).toBe(0);
    expect(db.from).toEqual([]);
    expect(rewriteEngagementText).not.toHaveBeenCalled();
    expect(openDmAsUser).not.toHaveBeenCalled();
    expect(postMessageAsUser).not.toHaveBeenCalled();
  });

  it("LG11 the route's copy of the expired text is BRIEF_COPY.legacyExpired exactly", async () => {
    gateState.verdict.mockResolvedValue("expired");
    await post(click("daily_brief_send", { b: "brief_2026-11-06", m: "m1" }));
    expect(JSON.parse(String((fetchSpy.mock.calls[0] as [string, RequestInit])[1].body)).text).toBe("Expired: check-ins now come from your Executive Assistant's brief.");
  });

  it.each(["daily_brief_send", "daily_brief_rewrite"])("LG12 %s when the gate throws: 200 {}, no send, no response_url call", async (actionId) => {
    gateState.verdict.mockRejectedValue(new Error("exec_principals read failed (57014)"));
    const res = await post(click(actionId, { b: "brief_2026-11-06", m: "m1" }));
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({});
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(db.from).toEqual([]);
    expect(rewriteEngagementText).not.toHaveBeenCalled();
    expect(postMessageAsUser).not.toHaveBeenCalled();
  });

  it("LG13 a valid verdict runs the existing send path unchanged (positive control)", async () => {
    gateState.verdict.mockResolvedValue("valid");
    const res = await post(click("daily_brief_send", { b: "brief_2026-11-06", m: "m1" }));
    expect(res.status).toBe(200);
    expect(db.from).toEqual(["daily_briefings", "users", "daily_briefings"]);
    expect(openDmAsUser).toHaveBeenCalledWith("user-token-under-test", "U0SAM0001");
    expect(postMessageAsUser).toHaveBeenCalledWith({ userToken: "user-token-under-test", channel: "D0SAM0001", text: "Hey Sam" });
    expect(db.updates).toHaveLength(1);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String((fetchSpy.mock.calls[0] as [string, RequestInit])[1].body))).toMatchObject({ replace_original: true });
  });

  it("LG13 a valid verdict runs the existing rewrite path unchanged", async () => {
    gateState.verdict.mockResolvedValue("valid");
    await post(click("daily_brief_rewrite", { b: "brief_2026-11-06", m: "m1" }));
    expect(rewriteEngagementText).toHaveBeenCalledWith("Sam", "Hey Sam");
    expect(db.updates).toEqual([{ messages: [expect.objectContaining({ id: "m1", text: "A fresh check-in" })] }]);
  });

  it("EXEC_ENABLED off: the gate is never asked and the legacy path runs", async () => {
    vi.stubEnv("EXEC_ENABLED", "false");
    await post(click("daily_brief_send", { b: "brief_2026-11-06", m: "m1" }));
    expect(gateState.verdict).not.toHaveBeenCalled();
    expect(postMessageAsUser).toHaveBeenCalledTimes(1);
  });

  it("an expired reply that fails to post is logged without the response_url, and still answers 200 {}", async () => {
    gateState.verdict.mockResolvedValue("expired");
    fetchSpy.mockRejectedValueOnce(new TypeError(`fetch failed ${RESPONSE_URL}`));
    const res = await post(click("daily_brief_send", { b: "brief_2026-11-06", m: "m1" }));
    await expect(res.json()).resolves.toEqual({});
    expect(postMessageAsUser).not.toHaveBeenCalled();
    for (const call of vi.mocked(console.error).mock.calls) expect(JSON.stringify(call)).not.toContain("SECRETPATH");
  });

  it("a click without b and m asks nothing (unchanged)", async () => {
    await post(click("daily_brief_send", { b: "brief_2026-11-06" }));
    expect(gateState.verdict).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
