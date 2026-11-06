import { describe, expect, it } from "vitest";

import { isSameOriginRequest as p3SameOrigin } from "@/lib/exec/email-assess";
import { isSameOriginRequest, jsonAnswer, jsonError, readJsonBody } from "@/lib/exec/http";

// src/lib/exec/http.ts (P4 contract §3.12.1, C39, C56): the bounded body
// reader, the error answer, and the re-export of P3's same-origin check
// (bindings AM3).

const URL_ = "https://ops.example/api/exec/drafts";

function post(body: BodyInit | null, headers: Record<string, string> = {}): Request {
  return new Request(URL_, { method: "POST", body, headers: { "content-type": "application/json", ...headers } });
}

/** A body sent in chunks with no Content-Length (chunked transfer). */
function streamed(chunks: string[]): Request {
  const enc = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      for (const s of chunks) c.enqueue(enc.encode(s));
      c.close();
    }
  });
  return new Request(URL_, { method: "POST", body: stream, headers: { "content-type": "application/json" }, duplex: "half" } as RequestInit);
}

describe("readJsonBody (C56)", () => {
  it("parses a body within the cap, the cap itself included", async () => {
    expect(await readJsonBody(post(JSON.stringify({ version: 3 })), 64)).toEqual({ ok: true, value: { version: 3 } });
    const exact = JSON.stringify({ a: "x".repeat(10) });
    expect(await readJsonBody(post(exact), Buffer.byteLength(exact, "utf8"))).toEqual({ ok: true, value: { a: "x".repeat(10) } });
  });
  it("refuses a body over the cap, by its Content-Length or by what arrives", async () => {
    expect(await readJsonBody(post("{}", { "content-length": "100000" }), 8_192)).toEqual({ ok: false });
    expect(await readJsonBody(post(JSON.stringify({ a: "x".repeat(9_000) })), 8_192)).toEqual({ ok: false });
    expect(await readJsonBody(streamed(["{\"a\":\"", "x".repeat(5_000), "x".repeat(5_000), "\"}"]), 8_192)).toEqual({ ok: false });
  });
  it("counts bytes, not characters", async () => {
    const wide = JSON.stringify({ a: String.fromCharCode(0x20ac).repeat(10) }); // 3 bytes each
    expect(await readJsonBody(post(wide), wide.length + 5)).toEqual({ ok: false });
    expect((await readJsonBody(post(wide), Buffer.byteLength(wide, "utf8"))).ok).toBe(true);
  });
  it("reads a chunked body within the cap", async () => {
    expect(await readJsonBody(streamed(["{\"vers", "ion\":", "7}"]), 64)).toEqual({ ok: true, value: { version: 7 } });
  });
  it("refuses malformed JSON, an empty body and invalid UTF-8", async () => {
    expect(await readJsonBody(post("{\"version\":"), 64)).toEqual({ ok: false });
    expect(await readJsonBody(post(null), 64)).toEqual({ ok: false });
    expect(await readJsonBody(post(new Uint8Array([0x7b, 0x22, 0x61, 0x22, 0x3a, 0x22, 0xff, 0xfe, 0x22, 0x7d])), 64)).toEqual({ ok: false });
  });
  it("refuses a nonsensical cap", async () => {
    expect(await readJsonBody(post("{}"), -1)).toEqual({ ok: false });
    expect(await readJsonBody(post("{}"), Number.NaN)).toEqual({ ok: false });
  });
});

describe("jsonError / jsonAnswer", () => {
  it("answers { error: code, ...extra }, never cached", async () => {
    const r = jsonError(409, "state_conflict", { status: "saving" });
    expect(r.status).toBe(409);
    expect(r.headers.get("cache-control")).toBe("no-store");
    expect(r.headers.get("retry-after")).toBeNull();
    expect(await r.json()).toEqual({ error: "state_conflict", status: "saving" });
  });
  it("a 429 carries Retry-After: 60 by default, or the route's retryAfterSec rounded up", async () => {
    expect(jsonError(429, "rate_limited").headers.get("retry-after")).toBe("60");
    expect(jsonError(429, "rate_limited", { retryAfterSec: 2.2 }).headers.get("retry-after")).toBe("3");
    expect(jsonError(429, "rate_limited", { retryAfterSec: 0 }).headers.get("retry-after")).toBe("60");
  });
  it("jsonAnswer passes the body through, never cached", async () => {
    const r = jsonAnswer(202, { status: "sent_pending", code: "accepted" });
    expect(r.status).toBe(202);
    expect(r.headers.get("cache-control")).toBe("no-store");
    expect(await r.json()).toEqual({ status: "sent_pending", code: "accepted" });
  });
});

describe("isSameOriginRequest (C39, AM3)", () => {
  it("is P3's own check, re-exported", () => {
    expect(isSameOriginRequest).toBe(p3SameOrigin);
  });
  it("same-origin passes; same-site, cross-site and no header are refused; Origin = Host or X-Forwarded-Host passes", () => {
    const req = (h: Record<string, string>) => new Request(URL_, { method: "POST", headers: h });
    expect(isSameOriginRequest(req({ "sec-fetch-site": "same-origin" }))).toBe(true);
    expect(isSameOriginRequest(req({ "sec-fetch-site": "same-site", origin: "https://ops.example", host: "ops.example" }))).toBe(false);
    expect(isSameOriginRequest(req({ "sec-fetch-site": "cross-site" }))).toBe(false);
    expect(isSameOriginRequest(req({}))).toBe(false);
    expect(isSameOriginRequest(req({ origin: "https://ops.example", host: "ops.example" }))).toBe(true);
    expect(isSameOriginRequest(req({ origin: "https://ops.example", host: "internal:3000", "x-forwarded-host": "ops.example" }))).toBe(true);
    expect(isSameOriginRequest(req({ origin: "https://evil.example", host: "ops.example" }))).toBe(false);
  });
});
