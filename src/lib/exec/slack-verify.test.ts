import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// node:crypto's timingSafeEqual is wrapped in a spy (SV09); every other export is the real one.
vi.mock("node:crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:crypto")>();
  return { ...actual, timingSafeEqual: vi.fn(actual.timingSafeEqual) };
});

import { readRawBody, verifySlackSignature } from "@/lib/exec/slack-verify";
import { SLACK_LIMITS } from "@/lib/exec/slack-types";
import { findSentinel, SENTINELS } from "./__tests__/slack-assert";

// P6 §5.1 (Area B): the Slack v0 signature check and the capped body reader (K18).

const SECRET = SENTINELS.signingSecret;
const NOW_MS = 1_793_977_200_000;
const NOW_SEC = NOW_MS / 1000;
const BODY = '{"token":"x","team_id":"T0SCALED","api_app_id":"A0EXEC","type":"event_callback","event_id":"Ev0001"}';

function sign(body: Buffer | string, ts: number | string, secret: string = SECRET): string {
  const raw = typeof body === "string" ? Buffer.from(body, "utf8") : body;
  return `v0=${createHmac("sha256", secret).update(`v0:${ts}:`).update(raw).digest("hex")}`;
}

function verify(body: Buffer | string, ts: number | string, signature: string | null, opts: { secret?: string | null; now?: number } = {}) {
  return verifySlackSignature(
    {
      secret: opts.secret === undefined ? SECRET : opts.secret,
      timestampHeader: ts === "" ? null : String(ts),
      signatureHeader: signature,
      rawBody: typeof body === "string" ? Buffer.from(body, "utf8") : body
    },
    opts.now ?? NOW_MS
  );
}

const spy = vi.mocked(timingSafeEqual);
const consoleSpies: ReturnType<typeof vi.spyOn>[] = [];

beforeEach(() => {
  for (const m of ["log", "info", "warn", "error", "debug"] as const) consoleSpies.push(vi.spyOn(console, m).mockImplementation(() => undefined));
});
afterEach(() => {
  // Nothing in slack-verify ever logs (§0.3 rule 4).
  for (const s of consoleSpies) expect(s).not.toHaveBeenCalled();
  consoleSpies.length = 0;
});

describe("verifySlackSignature (§3.4)", () => {
  it("SV01 a correctly signed body verifies", () => {
    expect(verify(BODY, NOW_SEC, sign(BODY, NOW_SEC))).toEqual({ ok: true });
  });

  it("SV02 a timestamp 301 s old is stale; 300 and 299 s pass", () => {
    expect(verify(BODY, NOW_SEC - 301, sign(BODY, NOW_SEC - 301))).toEqual({ ok: false, reason: "stale" });
    expect(verify(BODY, NOW_SEC - 300, sign(BODY, NOW_SEC - 300))).toEqual({ ok: true });
    expect(verify(BODY, NOW_SEC - 299, sign(BODY, NOW_SEC - 299))).toEqual({ ok: true });
    // The window is measured on our clock in seconds with its fraction (Slack's reference: abs(time.time() - ts) > 300).
    expect(verify(BODY, NOW_SEC - 300, sign(BODY, NOW_SEC - 300), { now: NOW_MS + 500 })).toEqual({ ok: false, reason: "stale" });
    expect(SLACK_LIMITS.signatureWindowSec).toBe(300);
  });

  it("SV03 a timestamp 301 s in the future is stale", () => {
    expect(verify(BODY, NOW_SEC + 301, sign(BODY, NOW_SEC + 301))).toEqual({ ok: false, reason: "stale" });
    expect(verify(BODY, NOW_SEC + 299, sign(BODY, NOW_SEC + 299))).toEqual({ ok: true });
  });

  it("SV04 a body signed with another secret is bad_signature", () => {
    expect(verify(BODY, NOW_SEC, sign(BODY, NOW_SEC, "another-signing-secret"))).toEqual({ ok: false, reason: "bad_signature" });
    // The signature binds the timestamp too.
    expect(verify(BODY, NOW_SEC, sign(BODY, NOW_SEC - 1))).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("SV05 one byte of the body changed after signing is bad_signature", () => {
    const raw = Buffer.from(BODY, "utf8");
    const signature = sign(raw, NOW_SEC);
    const tampered = Buffer.from(raw);
    tampered[10] = tampered[10] ^ 0x01;
    expect(verify(tampered, NOW_SEC, signature)).toEqual({ ok: false, reason: "bad_signature" });
    expect(verify(Buffer.concat([raw, Buffer.from(" ")]), NOW_SEC, signature)).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("SV06 the raw bytes are hashed: a re-serialized body fails, a multi-byte UTF-8 body verifies on its own bytes", () => {
    const spaced = '{ "type": "event_callback",  "event": { "text": "café — ok" } }';
    const signature = sign(spaced, NOW_SEC);
    expect(verify(spaced, NOW_SEC, signature)).toEqual({ ok: true });
    const reserialized = JSON.stringify(JSON.parse(spaced));
    expect(reserialized).not.toBe(spaced);
    expect(verify(reserialized, NOW_SEC, signature)).toEqual({ ok: false, reason: "bad_signature" });
    // Bytes, not a string decoding of them: a body that isn't valid UTF-8 still verifies byte for byte.
    const binary = Buffer.from([0x7b, 0xff, 0xfe, 0xc3, 0x28, 0x7d]);
    expect(verify(binary, NOW_SEC, sign(binary, NOW_SEC))).toEqual({ ok: true });
    expect(verify(Buffer.from(binary.toString("utf8"), "utf8"), NOW_SEC, sign(binary, NOW_SEC))).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("SV07 either header missing is missing_headers; header names are case-insensitive through Request.headers", () => {
    const signature = sign(BODY, NOW_SEC);
    expect(verify(BODY, "", signature)).toEqual({ ok: false, reason: "missing_headers" });
    expect(verify(BODY, NOW_SEC, null)).toEqual({ ok: false, reason: "missing_headers" });
    expect(verify(BODY, NOW_SEC, "")).toEqual({ ok: false, reason: "missing_headers" });
    const req = new Request("https://operations.scaledai.org/api/integrations/exec-slack/events", {
      method: "POST",
      headers: { "X-SLACK-Request-Timestamp": String(NOW_SEC), "x-Slack-SIGNATURE": signature },
      body: BODY
    });
    expect(
      verifySlackSignature(
        { secret: SECRET, timestampHeader: req.headers.get("x-slack-request-timestamp"), signatureHeader: req.headers.get("x-slack-signature"), rawBody: Buffer.from(BODY) },
        NOW_MS
      )
    ).toEqual({ ok: true });
  });

  it("SV07 a timestamp that isn't 1-12 digits is bad_timestamp", () => {
    for (const ts of ["12a", "-1", "1793977200.5", " 1793977200", "1".repeat(13), "0x6ae5d1f0"]) {
      expect(verify(BODY, ts, sign(BODY, ts)), ts).toEqual({ ok: false, reason: "bad_timestamp" });
    }
  });

  it("SV08 a v1= prefix, upper-case hex or 63 hex characters is bad_signature, without throwing", () => {
    const hex = sign(BODY, NOW_SEC).slice(3);
    for (const bad of [`v1=${hex}`, `v0=${hex.toUpperCase()}`, `v0=${hex.slice(0, 63)}`, `v0=${hex}0`, `v0=${"z".repeat(64)}`, hex, `V0=${hex}`, `v0= ${hex}`]) {
      expect(() => verify(BODY, NOW_SEC, bad)).not.toThrow();
      expect(verify(BODY, NOW_SEC, bad), bad).toEqual({ ok: false, reason: "bad_signature" });
    }
  });

  it("SV09 the digests are compared with timingSafeEqual, never with unequal lengths, and not at all for a malformed signature", () => {
    spy.mockClear();
    expect(verify(BODY, NOW_SEC, sign(BODY, NOW_SEC))).toEqual({ ok: true });
    expect(verify(BODY, NOW_SEC, sign(BODY, NOW_SEC, "wrong"))).toEqual({ ok: false, reason: "bad_signature" });
    expect(spy).toHaveBeenCalledTimes(2);
    for (const [a, b] of spy.mock.calls) {
      expect(a.byteLength).toBe(32);
      expect(b.byteLength).toBe(32);
    }
    spy.mockClear();
    verify(BODY, NOW_SEC, `v0=${"a".repeat(63)}`);
    verify(BODY, NOW_SEC - 999, sign(BODY, NOW_SEC - 999));
    verify(BODY, NOW_SEC, null);
    expect(spy).not.toHaveBeenCalled();
  });

  it("SV10 the same signed request verifies twice inside the window (dedupe is the RPC's job)", () => {
    const signature = sign(BODY, NOW_SEC);
    expect(verify(BODY, NOW_SEC, signature)).toEqual({ ok: true });
    expect(verify(BODY, NOW_SEC, signature, { now: NOW_MS + 120_000 })).toEqual({ ok: true });
  });

  it("SV11 a null or empty secret is no_secret, before any header is looked at", () => {
    expect(verify(BODY, NOW_SEC, sign(BODY, NOW_SEC), { secret: null })).toEqual({ ok: false, reason: "no_secret" });
    expect(verify(BODY, NOW_SEC, sign(BODY, NOW_SEC, ""), { secret: "" })).toEqual({ ok: false, reason: "no_secret" });
    expect(verify(BODY, "", null, { secret: null })).toEqual({ ok: false, reason: "no_secret" });
  });

  it("the result never carries a header value, the secret or the body", () => {
    const results = [
      verify(SENTINELS.text, NOW_SEC, sign(SENTINELS.text, NOW_SEC)),
      verify(SENTINELS.text, NOW_SEC, SENTINELS.signature),
      verify(SENTINELS.text, NOW_SEC - 999, SENTINELS.signature)
    ];
    expect(findSentinel(results)).toBeNull();
  });
});

/** A body whose reader counts what it hands out (SV12): `pulled` stops where the reader stopped asking. */
function countingBody(totalBytes: number, chunkBytes: number) {
  const state = { pulled: 0, reads: 0, cancelled: false, arrayBufferCalled: false };
  const body = {
    getReader() {
      return {
        async read(): Promise<{ done: boolean; value?: Uint8Array }> {
          state.reads += 1;
          if (state.pulled >= totalBytes) return { done: true, value: undefined };
          const n = Math.min(chunkBytes, totalBytes - state.pulled);
          state.pulled += n;
          return { done: false, value: new Uint8Array(n).fill(0x61) };
        },
        async cancel() {
          state.cancelled = true;
        },
        releaseLock() {
          // nothing held
        }
      };
    }
  };
  const req = {
    headers: new Headers(),
    body,
    // A buffer-everything reader would call one of these: they count as a failure.
    arrayBuffer: async () => {
      state.arrayBufferCalled = true;
      throw new Error("readRawBody must not buffer the whole body");
    },
    text: async () => {
      state.arrayBufferCalled = true;
      throw new Error("readRawBody must not buffer the whole body");
    }
  };
  return { req: req as unknown as Request, state, headers: req.headers };
}

describe("readRawBody (§3.4, security-10)", () => {
  const MAX = SLACK_LIMITS.bodyMaxBytes;

  it("SV12 a Content-Length over the cap is too_large without reading a byte", async () => {
    const { req, state, headers } = countingBody(2 * MAX, 64 * 1024);
    headers.set("content-length", String(2 * MAX));
    expect(await readRawBody(req, MAX)).toEqual({ ok: false, reason: "too_large" });
    expect(state.reads).toBe(0);
    expect(state.pulled).toBe(0);
  });

  it("SV12 a chunked body over 1 MiB with no Content-Length stops within one chunk past the cap and cancels", async () => {
    const chunk = 64 * 1024;
    const { req, state } = countingBody(4 * MAX, chunk);
    expect(await readRawBody(req, MAX)).toEqual({ ok: false, reason: "too_large" });
    expect(state.pulled).toBeGreaterThan(MAX);
    expect(state.pulled).toBeLessThanOrEqual(MAX + chunk);
    expect(state.cancelled).toBe(true);
    expect(state.arrayBufferCalled).toBe(false);
  });

  it("SV12 a lying Content-Length (under the cap) doesn't let a bigger stream through", async () => {
    const chunk = 100_000;
    const { req, state, headers } = countingBody(3 * MAX, chunk);
    headers.set("content-length", "10");
    expect(await readRawBody(req, MAX)).toEqual({ ok: false, reason: "too_large" });
    expect(state.pulled).toBeLessThanOrEqual(MAX + chunk);
    expect(state.cancelled).toBe(true);
  });

  it("SV12 a body of 1 MiB − 1 bytes is read whole and byte-identical; exactly 1 MiB passes too", async () => {
    const bytes = randomBytes(MAX - 1);
    const res = await readRawBody(new Request("https://x.example/", { method: "POST", body: bytes }), MAX);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.body.equals(bytes)).toBe(true);
    const exact = randomBytes(MAX);
    const res2 = await readRawBody(new Request("https://x.example/", { method: "POST", body: exact }), MAX);
    expect(res2.ok && res2.body.equals(exact)).toBe(true);
    const over = await readRawBody(new Request("https://x.example/", { method: "POST", body: randomBytes(MAX + 1) }), MAX);
    expect(over).toEqual({ ok: false, reason: "too_large" });
  });

  it("SV12 no body is an empty buffer; a small chunked body is concatenated in order", async () => {
    const empty = await readRawBody(new Request("https://x.example/", { method: "POST" }), MAX);
    expect(empty.ok && empty.body.length === 0).toBe(true);
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(Buffer.from("v0:", "utf8"));
        c.enqueue(Buffer.from("café", "utf8"));
        c.enqueue(new Uint8Array(0));
        c.close();
      }
    });
    const res = await readRawBody({ headers: new Headers(), body: stream } as unknown as Request, MAX);
    expect(res.ok && res.body.toString("utf8")).toBe("v0:café");
  });
});
