import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

vi.mock("@/lib/supabase-admin", () => ({ getSupabaseAdmin: vi.fn() }));

import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { auditEvent, auditFinish, auditStart, sanitizeForAudit, withAudit } from "@/lib/exec/audit";
import { AuditUnavailableError, type ExecPrincipal } from "@/lib/exec/types";

const PRINCIPAL = Object.freeze({
  id: "ep_1",
  userId: "u_1",
  email: "mitchell@scaledai.org",
  name: "Mitchell",
  timezone: "America/New_York",
  mailAccountIds: Object.freeze([]),
  slackTeamId: null,
  slackUserId: null
}) as unknown as ExecPrincipal;

// --- fake exec_audit_log ----------------------------------------------------------

interface DbOpts {
  insertError?: { message: string };
  insertThrows?: Error;
  /** what .select("id").single() returns as data (default { id: 41 }) */
  insertData?: unknown;
  updateError?: { message: string };
  updateThrows?: Error;
}

function fakeDb(opts: DbOpts = {}) {
  const inserts: Record<string, unknown>[] = [];
  const updates: { row: Record<string, unknown>; column: string; value: unknown }[] = [];
  const client = {
    from(table: string) {
      if (table !== "exec_audit_log") throw new Error(`unexpected table ${table}`);
      return {
        insert(row: Record<string, unknown>) {
          if (opts.insertThrows) throw opts.insertThrows;
          inserts.push(row);
          const plain = { error: opts.insertError ?? null };
          return {
            select: () => ({
              single: async () =>
                opts.insertError
                  ? { data: null, error: opts.insertError }
                  : { data: "insertData" in opts ? opts.insertData : { id: 41 }, error: null }
            }),
            then<A, B>(onFulfilled?: (v: typeof plain) => A, onRejected?: (e: unknown) => B) {
              return Promise.resolve(plain).then(onFulfilled, onRejected);
            }
          };
        },
        update(row: Record<string, unknown>) {
          return {
            eq: async (column: string, value: unknown) => {
              if (opts.updateThrows) throw opts.updateThrows;
              updates.push({ row, column, value });
              return { error: opts.updateError ?? null };
            }
          };
        }
      };
    }
  };
  vi.mocked(getSupabaseAdmin).mockReturnValue(client as unknown as SupabaseClient);
  return { inserts, updates };
}

let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.mocked(getSupabaseAdmin).mockReset();
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

// --- sanitizeForAudit ---------------------------------------------------------------

describe("sanitizeForAudit", () => {
  const CONTRACT_KEYS = [
    "body",
    "bodyHtml",
    "body_html",
    "bodyText",
    "body_text",
    "html",
    "text",
    "content",
    "contents",
    "message",
    "messages",
    "snippet",
    "transcript",
    "excerpt",
    "summary",
    "prompt",
    "completion",
    "thinking"
  ];

  it.each(CONTRACT_KEYS)("omits a string under %s, keeping only its length", (key) => {
    expect(sanitizeForAudit({ [key]: "secret words", keep: "x" })).toEqual({ [key]: { omitted: true, chars: 12 }, keep: "x" });
  });

  it("matches body keys case-insensitively", () => {
    expect(sanitizeForAudit({ BODY: "abc", Body_HTML: "<p>hi</p>", TEXT: "t" })).toEqual({
      BODY: { omitted: true, chars: 3 },
      Body_HTML: { omitted: true, chars: 9 },
      TEXT: { omitted: true, chars: 1 }
    });
  });

  it("omits arrays and objects under body keys, sized as JSON", () => {
    const messages = [{ role: "user", text: "hello" }];
    const body = { contentType: "html", content: "<b>x</b>" };
    expect(sanitizeForAudit({ messages, body })).toEqual({
      messages: { omitted: true, chars: JSON.stringify(messages).length },
      body: { omitted: true, chars: JSON.stringify(body).length }
    });
  });

  it("keeps non-content values under body keys", () => {
    expect(sanitizeForAudit({ text: null, message: 5, content: true })).toEqual({ text: null, message: 5, content: true });
  });

  it("omits body keys at any depth", () => {
    expect(sanitizeForAudit({ thread: { messages_meta: [{ id: "m1", body_html: "<p>x</p>" }] } })).toEqual({
      thread: { messages_meta: [{ id: "m1", body_html: { omitted: true, chars: 8 } }] }
    });
  });

  it("also omits the content fields DD and its sources use under other names", () => {
    const out = sanitizeForAudit({
      last_snippet: "newest message text",
      bodyPreview: "graph preview",
      uniqueBody: { content: "x" },
      preview: "preview text",
      blocks: [{ type: "section", text: { type: "mrkdwn", text: "hi" } }]
    }) as Record<string, { omitted?: boolean }>;
    for (const key of ["last_snippet", "bodyPreview", "uniqueBody", "preview", "blocks"]) expect(out[key].omitted).toBe(true);
  });

  it("omits compound content names but keeps look-alike metadata keys", () => {
    const out = sanitizeForAudit({
      reply_text: "a",
      "draft-html": "b",
      noteBody: "c",
      draftHTML: "d",
      fullText: "e",
      context: "keep",
      contentType: "keep",
      subject: "keep",
      message_id: "keep",
      messageId: "keep",
      textLength: 12
    }) as Record<string, unknown>;
    for (const key of ["reply_text", "draft-html", "noteBody", "draftHTML", "fullText"]) {
      expect(out[key]).toEqual({ omitted: true, chars: 1 });
    }
    expect(out).toMatchObject({
      context: "keep",
      contentType: "keep",
      subject: "keep",
      message_id: "keep",
      messageId: "keep",
      textLength: 12
    });
  });

  it("redacts credential-named keys (agent-audit's redact)", () => {
    expect(sanitizeForAudit({ token: "abc", api_key: "k", Authorization: "Bearer x", password: "p", ok: 1 })).toEqual({
      token: "[redacted]",
      api_key: "[redacted]",
      Authorization: "[redacted]",
      password: "[redacted]",
      ok: 1
    });
  });

  it("masks credential-shaped values under innocent keys", () => {
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.c2lnbmF0dXJlX3NpZw";
    const out = sanitizeForAudit({
      note: "use xoxb-1234567890-abcdefghij please",
      header: "got Bearer abcdefghijklmnop back",
      key: "sk-ant-api03-abcdefghijklmnop",
      stripe: "sk_live_abcdefghijkl",
      supa: "sb_secret_abcdefghijkl",
      app: "xapp-1-A0123456789-abc",
      jwt: `token=${jwt}`,
      fine: "nothing secret here"
    });
    expect(out).toEqual({
      note: "use [redacted] please",
      header: "got [redacted] back",
      key: "[redacted]",
      stripe: "[redacted]",
      supa: "[redacted]",
      app: "[redacted]",
      jwt: "token=[redacted]",
      fine: "nothing secret here"
    });
  });

  it("masks a JWT however it is quoted or introduced", () => {
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.c2lnbmF0dXJlX3NpZw";
    expect(
      sanitizeForAudit({ bare: jwt, quoted: `{"t":"${jwt}"}`, header: `Authorization: Bearer ${jwt}`, query: `?token=${jwt}&x=1` })
    ).toEqual({ bare: "[redacted]", quoted: '{"t":"[redacted]"}', header: "Authorization: [redacted]", query: "?token=[redacted]&x=1" });
  });

  it("masks credentials used as keys", () => {
    expect(sanitizeForAudit({ "xoxb-1234567890-abcdefghij": 1, plain: 2 })).toEqual({ "[redacted]": 1, plain: 2 });
  });

  it("scans in linear time, so crafted text can't stall the event loop", () => {
    // With a \b-anchored JWT pattern, each of these took about 350 ms (quadratic).
    const list = Array.from({ length: 50 }, () => "eyJ-".repeat(5_000));
    const started = performance.now();
    sanitizeForAudit({ list });
    expect(performance.now() - started).toBeLessThan(1_000);
  });

  it("scans each string only up to a fixed window", () => {
    const started = performance.now();
    const out = sanitizeForAudit({ subject: "eyJ-".repeat(50_000) }) as { subject: string };
    expect(performance.now() - started).toBeLessThan(200);
    expect(out.subject).toBe(`${"eyJ-".repeat(1_000)}…[truncated]`);
    // Past the window the text is dropped unscanned, and the cut is marked even
    // when what's left is short.
    expect(sanitizeForAudit({ note: `Bearer ${"a".repeat(30_000)} tail` })).toEqual({ note: "[redacted]…[truncated]" });
  });

  it("masks a long JWT that starts inside the kept text but runs past it", () => {
    const jwt = `eyJ${"a".repeat(10)}.eyJ${"b".repeat(6_000)}.${"c".repeat(400)}`;
    const out = sanitizeForAudit({ note: `${"x".repeat(3_000)} ${jwt} tail` }) as { note: string };
    expect(out.note).toBe(`${"x".repeat(3_000)} [redacted] tail`);
  });

  it("caps long strings, long arrays and deep nesting", () => {
    const out = sanitizeForAudit({ q: "x".repeat(5_000), list: Array.from({ length: 300 }, (_, i) => i) }) as {
      q: string;
      list: number[];
    };
    expect(out.q.startsWith("x".repeat(4_000))).toBe(true);
    expect(out.q.endsWith("…[truncated]")).toBe(true);
    expect(out.list).toHaveLength(200);

    const deep = { a: { b: { c: { d: { e: { f: { g: { h: "deep" } } } } } } } };
    expect(JSON.stringify(sanitizeForAudit(deep))).toContain("[truncated]");
    expect(JSON.stringify(sanitizeForAudit(deep))).not.toContain("deep");
  });

  it("keeps the whole value under 20 KB", () => {
    const big = { rows: Array.from({ length: 150 }, (_, i) => ({ id: i, note: "n".repeat(300) })) };
    const out = sanitizeForAudit(big) as { truncated?: boolean; preview?: string };
    expect(out.truncated).toBe(true);
    expect(typeof out.preview).toBe("string");
    expect(JSON.stringify(out).length).toBeLessThan(21_000);
  });

  it("terminates on cyclic values and sizes an omitted cycle as unknown", () => {
    const loop: Record<string, unknown> = { id: "x" };
    loop.self = loop;
    expect(JSON.stringify(sanitizeForAudit(loop))).toContain("[truncated]");
    expect(sanitizeForAudit({ content: loop })).toEqual({ content: { omitted: true, chars: null } });
  });

  it("converts values JSON can't hold instead of throwing", () => {
    expect(
      sanitizeForAudit({
        big: BigInt(12),
        fn: () => 1,
        sym: Symbol("s"),
        undef: undefined,
        when: new Date("2026-11-04T12:00:00Z"),
        bad: new Date("nope"),
        buf: Buffer.from("hello"),
        bytes: new Uint8Array(3),
        ab: new ArrayBuffer(8)
      })
    ).toEqual({
      big: "12",
      fn: null,
      sym: null,
      undef: null,
      when: "2026-11-04T12:00:00.000Z",
      bad: null,
      buf: { omitted: true, bytes: 5 },
      bytes: { omitted: true, bytes: 3 },
      ab: { omitted: true, bytes: 8 }
    });
    expect(sanitizeForAudit(() => 1)).toBeNull();
    expect(sanitizeForAudit(BigInt(5))).toBe("5");
    // Sized as {"n":"1"}: the BigInt is counted as a string rather than making the size unknown.
    expect(sanitizeForAudit({ content: { n: BigInt(1) } })).toEqual({ content: { omitted: true, chars: 9 } });
    // A toJSON that serializes to nothing has size 0.
    expect(sanitizeForAudit({ content: { toJSON: () => undefined } })).toEqual({ content: { omitted: true, chars: 0 } });
  });

  it("drops NUL and replaces lone surrogates, in values and keys", () => {
    const out = sanitizeForAudit({ ["k\u0000ey\uD800"]: "a\u0000b\uDC00c" }) as Record<string, string>;
    const [[key, value]] = Object.entries(out);
    expect(key).toBe("key�");
    expect(value).toBe("ab�c");
    expect(LONE_SURROGATE.test(JSON.stringify(out))).toBe(false);
  });

  it("passes plain values through", () => {
    expect(sanitizeForAudit(undefined)).toBeNull();
    expect(sanitizeForAudit(null)).toBeNull();
    expect(sanitizeForAudit("plain")).toBe("plain");
    expect(sanitizeForAudit(3)).toBe(3);
    expect(sanitizeForAudit({ thread_id: "t1", to: ["a@b.c"], ok: true })).toEqual({ thread_id: "t1", to: ["a@b.c"], ok: true });
  });

  it("never throws: an exotic value becomes a marker and the failure is logged", () => {
    const hostile = Object.defineProperty({}, "x", {
      enumerable: true,
      get() {
        throw new Error("getter exploded");
      }
    });
    expect(sanitizeForAudit(hostile)).toEqual({ unserializable: true });
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("getter exploded"));
  });
});

// --- auditStart -----------------------------------------------------------------------

describe("auditStart", () => {
  it("inserts a sanitized row and returns its id", async () => {
    const db = fakeDb();
    const id = await auditStart(PRINCIPAL, {
      actor: "owner",
      action: "draft.save",
      target: "exec_drafts:9",
      input: { thread_id: "t1", body_html: "<p>Dear client</p>", token: "abc" }
    });
    expect(id).toBe(41);
    expect(db.inserts).toEqual([
      {
        principal_id: "ep_1",
        actor: "owner",
        action: "draft.save",
        target: "exec_drafts:9",
        input: { thread_id: "t1", body_html: { omitted: true, chars: 18 }, token: "[redacted]" }
      }
    ]);
  });

  it("stores nulls for a system action without a principal, target or input", async () => {
    const db = fakeDb();
    await auditStart(null, { actor: "system", action: "purge.run" });
    expect(db.inserts[0]).toEqual({ principal_id: null, actor: "system", action: "purge.run", target: null, input: null });
  });

  it("caps action and target", async () => {
    const db = fakeDb();
    await auditStart(PRINCIPAL, { actor: "job", action: "a".repeat(300), target: "t".repeat(900) });
    expect((db.inserts[0].action as string).length).toBe(200);
    expect((db.inserts[0].target as string).length).toBe(500);
    expect((db.inserts[0].target as string).endsWith("…")).toBe(true);
  });

  it("accepts a numeric-string id", async () => {
    fakeDb({ insertData: { id: "77" } });
    expect(await auditStart(PRINCIPAL, { actor: "owner", action: "x" })).toBe(77);
  });

  it("fails closed with AuditUnavailableError when the insert errors", async () => {
    fakeDb({ insertError: { message: 'relation "exec_audit_log" does not exist' } });
    const err = await auditStart(PRINCIPAL, { actor: "owner", action: "draft.send" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AuditUnavailableError);
    expect((err as Error).message).toContain("exec_audit_log");
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("refusing draft.send"));
  });

  it("fails closed when the client throws or can't be built", async () => {
    fakeDb({ insertThrows: new Error("fetch failed") });
    await expect(auditStart(PRINCIPAL, { actor: "owner", action: "x" })).rejects.toBeInstanceOf(AuditUnavailableError);

    vi.mocked(getSupabaseAdmin).mockImplementation(() => {
      throw new Error("no service role key");
    });
    await expect(auditStart(PRINCIPAL, { actor: "owner", action: "x" })).rejects.toThrow(/audit log unavailable: no service role key/);
  });

  it.each([[null], [{}], [{ id: 0 }], [{ id: -3 }], [{ id: 1.5 }], [{ id: "abc" }], [{ id: Number.MAX_SAFE_INTEGER + 2 }]])(
    "fails closed when the insert returns no usable id (%j)",
    async (data) => {
      fakeDb({ insertData: data });
      await expect(auditStart(PRINCIPAL, { actor: "owner", action: "x" })).rejects.toThrow(/insert returned no row id/);
    }
  );
});

// --- auditFinish -------------------------------------------------------------------------

describe("auditFinish", () => {
  it("updates the row by id with outcome, sanitized result and a timestamp", async () => {
    const db = fakeDb();
    await auditFinish(41, { ok: true, result: { outlook_message_id: "AAMk", body_text: "Hi" } });
    expect(db.updates).toHaveLength(1);
    const [{ row, column, value }] = db.updates;
    expect(column).toBe("id");
    expect(value).toBe(41);
    expect(row).toMatchObject({ ok: true, result: { outlook_message_id: "AAMk", body_text: { omitted: true, chars: 2 } }, error: null });
    expect(new Date(row.finished_at as string).toISOString()).toBe(row.finished_at);
  });

  it("never leaves half a surrogate pair at the cut", async () => {
    const db = fakeDb();
    await auditFinish(5, { ok: false, error: `${"e".repeat(1_998)}😀😀😀` });
    const error = db.updates[0].row.error as string;
    expect(error.length).toBeLessThanOrEqual(2_000);
    expect(error).toBe(`${"e".repeat(1_998)}…`);
    expect(LONE_SURROGATE.test(error)).toBe(false);
  });

  it("stores null for a missing result or empty error", async () => {
    const db = fakeDb();
    await auditFinish(5, { ok: false, error: "" });
    expect(db.updates[0].row).toMatchObject({ ok: false, result: null, error: null });
  });

  it("caps the error at 2000 characters and scrubs credentials from it", async () => {
    const db = fakeDb();
    await auditFinish(5, { ok: false, error: `401 Bearer abcdefghijklmnopqrstuvwxyz ${"e".repeat(3_000)}` });
    const error = db.updates[0].row.error as string;
    expect(error.length).toBe(2_000);
    expect(error.endsWith("…")).toBe(true);
    expect(error.startsWith("401 [redacted] ")).toBe(true);
  });

  it("scrubs a huge error in bounded time and still masks a long token at the cut", async () => {
    const db = fakeDb();
    const started = performance.now();
    await auditFinish(5, { ok: false, error: "eyJ-".repeat(50_000) });
    expect(performance.now() - started).toBeLessThan(200);
    expect((db.updates[0].row.error as string).length).toBe(2_000);

    // Longer than twice MAX_ERROR: clipping that short before the scan would
    // leave the token's head unmatched in the stored text.
    const jwt = `eyJ${"a".repeat(10)}.eyJ${"b".repeat(5_000)}.${"c".repeat(400)}`;
    await auditFinish(6, { ok: false, error: `upstream said ${jwt} then hung up` });
    expect(db.updates[1].row.error).toBe("upstream said [redacted] then hung up");
  });

  it("never throws, and logs why", async () => {
    fakeDb({ updateError: { message: "timeout" } });
    await expect(auditFinish(5, { ok: true })).resolves.toBeUndefined();
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("could not finish audit row 5: timeout"));

    fakeDb({ updateThrows: new Error("socket closed") });
    await expect(auditFinish(5, { ok: true })).resolves.toBeUndefined();

    vi.mocked(getSupabaseAdmin).mockImplementation(() => {
      throw new Error("no key");
    });
    await expect(auditFinish(5, { ok: true })).resolves.toBeUndefined();
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("no key"));
  });
});

// --- auditEvent ----------------------------------------------------------------------------

describe("auditEvent", () => {
  it("writes one finished row, ok by default", async () => {
    const db = fakeDb();
    await auditEvent(PRINCIPAL, { actor: "owner", action: "tool.call", target: "get_thread", input: { thread_id: "t1" } });
    expect(db.inserts).toHaveLength(1);
    expect(db.inserts[0]).toMatchObject({
      principal_id: "ep_1",
      actor: "owner",
      action: "tool.call",
      target: "get_thread",
      input: { thread_id: "t1" },
      ok: true,
      result: null,
      error: null
    });
    expect(typeof db.inserts[0].finished_at).toBe("string");
  });

  it("is not ok when an error is given, unless ok says otherwise", async () => {
    const db = fakeDb();
    await auditEvent(PRINCIPAL, { actor: "job", action: "a", error: "boom" });
    await auditEvent(PRINCIPAL, { actor: "job", action: "b", ok: true, error: "partial" });
    await auditEvent(PRINCIPAL, { actor: "job", action: "c", ok: false });
    expect(db.inserts.map((r) => r.ok)).toEqual([false, true, false]);
    expect(db.inserts[0].error).toBe("boom");
  });

  it("sanitizes input and result", async () => {
    const db = fakeDb();
    await auditEvent(PRINCIPAL, { actor: "owner", action: "thread.read", input: { snippet: "hello" }, result: { messages: [1, 2] } });
    expect(db.inserts[0]).toMatchObject({ input: { snippet: { omitted: true, chars: 5 } }, result: { messages: { omitted: true, chars: 5 } } });
  });

  it("never throws, and logs why", async () => {
    fakeDb({ insertError: { message: "check constraint" } });
    await expect(auditEvent(PRINCIPAL, { actor: "owner", action: "x" })).resolves.toBeUndefined();
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("could not record x: check constraint"));

    fakeDb({ insertThrows: new Error("down") });
    await expect(auditEvent(null, { actor: "system", action: "y" })).resolves.toBeUndefined();
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("could not record y: down"));
  });
});

// --- withAudit --------------------------------------------------------------------------------

describe("withAudit", () => {
  it("writes the row before running fn, then finishes it ok with a null result", async () => {
    const db = fakeDb();
    const fn = vi.fn(async () => {
      expect(db.inserts).toHaveLength(1);
      expect(db.updates).toHaveLength(0);
      return { sent: true, body_text: "the email" };
    });
    const value = await withAudit(PRINCIPAL, { actor: "owner", action: "draft.send", target: "exec_drafts:1" }, fn);
    expect(value).toEqual({ sent: true, body_text: "the email" });
    expect(fn).toHaveBeenCalledTimes(1);
    expect(db.updates).toHaveLength(1);
    expect(db.updates[0]).toMatchObject({ column: "id", value: 41, row: { ok: true, result: null, error: null } });
  });

  it("never runs fn when the audit row can't be written", async () => {
    fakeDb({ insertError: { message: "down" } });
    const fn = vi.fn(async () => "sent");
    await expect(withAudit(PRINCIPAL, { actor: "owner", action: "draft.send" }, fn)).rejects.toBeInstanceOf(AuditUnavailableError);
    expect(fn).not.toHaveBeenCalled();
  });

  it("records fn's error and rethrows the same error", async () => {
    const db = fakeDb();
    class SendError extends Error {
      constructor(m: string) {
        super(m);
        this.name = "SendError";
      }
    }
    const boom = new SendError("clone 502");
    const err = await withAudit(PRINCIPAL, { actor: "owner", action: "draft.send" }, async () => {
      throw boom;
    }).catch((e: unknown) => e);
    expect(err).toBe(boom);
    expect(db.updates[0].row).toMatchObject({ ok: false, error: "SendError: clone 502" });
  });

  it("records a non-Error throw and rethrows it", async () => {
    const db = fakeDb();
    const err = await withAudit(PRINCIPAL, { actor: "owner", action: "x" }, async () => {
      throw "plain string";
    }).catch((e: unknown) => e);
    expect(err).toBe("plain string");
    expect(db.updates[0].row.error).toBe("plain string");
  });

  it("records a plain Error by its message alone", async () => {
    const db = fakeDb();
    await withAudit(PRINCIPAL, { actor: "owner", action: "x" }, async () => {
      throw new Error("bare");
    }).catch(() => undefined);
    expect(db.updates[0].row.error).toBe("bare");
  });

  it("survives a thrown value whose toString throws", async () => {
    const db = fakeDb();
    const weird = {
      toString() {
        throw new Error("no");
      }
    };
    const err = await withAudit(PRINCIPAL, { actor: "owner", action: "x" }, async () => {
      throw weird;
    }).catch((e: unknown) => e);
    expect(err).toBe(weird);
    expect(db.updates[0].row.error).toBe("non-Error value thrown");
  });

  it("a failed finish never masks fn's result or fn's error", async () => {
    fakeDb({ updateThrows: new Error("finish failed") });
    await expect(withAudit(PRINCIPAL, { actor: "owner", action: "x" }, async () => 7)).resolves.toBe(7);

    fakeDb({ updateError: { message: "finish failed" } });
    const boom = new Error("real failure");
    await expect(
      withAudit(PRINCIPAL, { actor: "owner", action: "x" }, async () => {
        throw boom;
      })
    ).rejects.toBe(boom);
  });
});
