import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Contract §3.4: InboxEvent gains optional, validated `direction` and
// `folder`, copied by both producers (the socket bridge and the webhook
// route), and every existing subscriber is unaffected.

// The socket bridge's io(): a fake socket that records the handlers.
const socketHandlers = new Map<string, (payload: unknown) => void>();
vi.mock("socket.io-client", () => ({
  io: vi.fn(() => ({
    connected: true,
    id: "sock-1",
    on: (event: string, fn: (payload: unknown) => void) => {
      socketHandlers.set(event, fn);
    }
  }))
}));

// The webhook route's side effects, stubbed.
vi.mock("@/lib/email-notifications", () => ({ fanOutInboxEvent: vi.fn(async () => 0) }));
vi.mock("@/lib/auto-label-by-client", () => ({ autoLabelByClients: vi.fn(async () => ({ applied: 0, matched: 0 })) }));
vi.mock("@/lib/client-thread-match", () => ({ loadClientMatcher: vi.fn() }));
vi.mock("@/lib/eod-digest", () => ({ markClientWeeklyUpdateReported: vi.fn(async () => 0) }));
vi.mock("@/lib/dazos-reports", () => ({ handleDazosMessage: vi.fn(async () => ({})), DAZOS_SENDER: "dazos-sender@example.invalid" }));

import { inboxEventExtras, type InboxEvent } from "@/lib/inbox-event-bus";

const SECRET = "webhook-test-secret";

beforeEach(() => {
  socketHandlers.clear();
  delete (globalThis as Record<string, unknown>).__ddMissiveSocket;
  process.env.MISSIVE_API_URL = "https://clone.test";
  process.env.MISSIVE_API_TOKEN = "tok";
  process.env.MISSIVE_WEBHOOK_SECRET = SECRET;
  vi.resetModules();
});

afterEach(() => {
  delete (globalThis as Record<string, unknown>).__ddMissiveSocket;
});

describe("inboxEventExtras", () => {
  it("keeps a valid direction and folder", () => {
    expect(inboxEventExtras({ direction: "inbound", folder: "Inbox" })).toEqual({ direction: "inbound", folder: "Inbox" });
    expect(inboxEventExtras({ direction: "outbound", folder: "  Sent Items " })).toEqual({ direction: "outbound", folder: "Sent Items" });
  });

  it.each([
    [{ direction: "Inbound", folder: "" }],
    [{ direction: "sideways", folder: "   " }],
    [{ direction: 1, folder: 7 }],
    [{ direction: null, folder: null }],
    [{ folder: "Junk\nEmail" }],
    [{ folder: "x".repeat(201) }],
    [{}],
    [null],
    [undefined]
  ])("drops anything else: %j", (payload) => {
    expect(inboxEventExtras(payload as Parameters<typeof inboxEventExtras>[0])).toEqual({});
  });
});

async function loadBridge() {
  const bus = await import("@/lib/inbox-event-bus");
  const seen: InboxEvent[] = [];
  bus.subscribe((e) => seen.push(e));
  const socket = await import("@/lib/missive-socket");
  socket.startMissiveSocketBridge();
  return { seen };
}

describe("socket bridge passthrough", () => {
  it("copies direction and folder from a CL1 message:new", async () => {
    const { seen } = await loadBridge();
    socketHandlers.get("message:new")?.({ thread_id: "t1", message_id: "m1", account_id: "acc", direction: "outbound", folder: "Sent Items" });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ event: "message:new", account_id: "acc", thread_id: "t1", message_id: "m1", direction: "outbound", folder: "Sent Items" });
  });

  it("a pre-CL1 payload publishes exactly the old event shape", async () => {
    const { seen } = await loadBridge();
    socketHandlers.get("message:new")?.({ thread_id: "t1", message_id: "m2", account_id: "acc" });
    expect(Object.keys(seen[0]).sort()).toEqual(["account_id", "event", "message_id", "thread_id", "ts"]);
  });

  it("drops a malformed direction or folder but still publishes the event", async () => {
    const { seen } = await loadBridge();
    socketHandlers.get("message:new")?.({ thread_id: "t1", message_id: "m3", account_id: "acc", direction: "INBOUND", folder: { x: 1 } });
    expect(seen).toHaveLength(1);
    expect("direction" in seen[0]).toBe(false);
    expect("folder" in seen[0]).toBe(false);
  });

  it("thread:updated is unchanged", async () => {
    const { seen } = await loadBridge();
    socketHandlers.get("thread:updated")?.({ thread_id: "t1", account_id: "acc", direction: "inbound" });
    expect(Object.keys(seen[0]).sort()).toEqual(["account_id", "event", "thread_id", "ts"]);
  });
});

describe("webhook route passthrough", () => {
  async function post(body: Record<string, unknown>) {
    const bus = await import("@/lib/inbox-event-bus");
    const seen: InboxEvent[] = [];
    bus.subscribe((e) => seen.push(e));
    const { POST } = await import("@/app/api/missive-webhook/route");
    const raw = JSON.stringify(body);
    const sig = createHmac("sha256", SECRET).update(raw).digest("hex");
    const req = new Request("https://dd.test/api/missive-webhook", { method: "POST", body: raw, headers: { "x-missive-signature": sig } });
    const res = await POST(req as unknown as Parameters<typeof POST>[0]);
    return { status: res.status, seen };
  }

  it("copies direction and folder into the published event", async () => {
    const { status, seen } = await post({
      event: "message:new",
      workspace_id: "w1",
      account_id: "acc",
      thread_id: "t9",
      message_id: "m9",
      ts: 1_762_259_200_000,
      direction: "inbound",
      folder: "Inbox"
    });
    expect(status).toBe(200);
    expect(seen).toEqual([
      { event: "message:new", workspace_id: "w1", account_id: "acc", thread_id: "t9", message_id: "m9", ts: 1_762_259_200_000, direction: "inbound", folder: "Inbox" }
    ]);
  });

  it("drops invalid values and keeps the old shape otherwise", async () => {
    const { seen } = await post({ event: "message:new", account_id: "acc", thread_id: "t9", message_id: "m10", ts: 5, direction: "both", folder: "" });
    expect(seen).toEqual([{ event: "message:new", workspace_id: undefined, account_id: "acc", thread_id: "t9", message_id: "m10", ts: 5 }]);
    expect("direction" in seen[0]).toBe(false);
  });
});
