import { describe, expect, it, vi } from "vitest";

vi.mock("next/cache", () => ({ unstable_cache: <T>(fn: T) => fn }));
vi.mock("@/lib/supabase-admin", () => ({ getSupabaseAdmin: vi.fn() }));
vi.mock("@/lib/supabase-server", () => ({ getSupabaseServer: vi.fn() }));

import type { z } from "zod";
import * as listRoute from "@/app/api/exec/drafts/route";
import * as draftRoute from "@/app/api/exec/drafts/[id]/route";
import * as openedRoute from "@/app/api/exec/drafts/[id]/outlook-opened/route";
import * as regenerateRoute from "@/app/api/exec/drafts/[id]/regenerate/route";
import * as resolveRoute from "@/app/api/exec/drafts/[id]/resolve/route";
import * as reviewRoute from "@/app/api/exec/drafts/[id]/review/route";
import * as saveRoute from "@/app/api/exec/drafts/[id]/save/route";
import * as sendRoute from "@/app/api/exec/drafts/[id]/send/route";
import type { DraftUiAction } from "@/components/exec/drafts/actions";
import {
  EMPTY_BODY_DOC,
  createRequest,
  editRequest,
  outlookOpenedRequest,
  requestFor,
  sendRequest,
  type ActionContext,
  type PanelRequest
} from "@/components/exec/drafts/panel-logic";
import {
  CreateDraftBody,
  DRAFT_BODY_LIMITS,
  DiscardBody,
  EditDraftBody,
  OutlookOpenedBody,
  RegenerateBody,
  ResolveBody,
  ReviewBody,
  SaveBody,
  SendBody
} from "@/lib/exec/drafts";
import { validateBodyDoc } from "@/lib/exec/drafts-doc";
import { REVIEW_BLOCKERS } from "@/lib/exec/drafts-types";
import { DOC, HASH, draftView, readBack, reviewResult } from "./__tests__/drafts-ui-fixtures";

// Integrator seam test (P4 stage 3): every request the DraftPanel builds (Area E,
// components/exec/drafts/panel-logic.ts) parses under the strict zod body of the
// route it goes to (Area D, drafts.ts), that route exports the method, and the body
// fits the route's size cap. A key E adds that D doesn't accept would be a 400 in
// the browser that neither area's own tests could see.

type Mod = Record<string, unknown>;
interface Target { schema: z.ZodTypeAny; route: Mod; cap: number }

function targetFor(req: PanelRequest): Target {
  const m = /^\/api\/exec\/drafts(?:\/([^/]+)(\/[a-z-]+)?)?$/.exec(req.path);
  if (m === null) throw new Error(`unknown path ${req.path}`);
  const [, id, tail] = m;
  if (id === undefined) return { schema: CreateDraftBody, route: listRoute, cap: DRAFT_BODY_LIMITS.create };
  switch (tail ?? "") {
    case "":
      if (req.method === "PATCH") return { schema: EditDraftBody, route: draftRoute, cap: DRAFT_BODY_LIMITS.patch };
      if (req.method === "DELETE") return { schema: DiscardBody, route: draftRoute, cap: DRAFT_BODY_LIMITS.other };
      break;
    case "/regenerate": return { schema: RegenerateBody, route: regenerateRoute, cap: DRAFT_BODY_LIMITS.other };
    case "/save": return { schema: SaveBody, route: saveRoute, cap: DRAFT_BODY_LIMITS.other };
    case "/review": return { schema: ReviewBody, route: reviewRoute, cap: DRAFT_BODY_LIMITS.other };
    case "/send": return { schema: SendBody, route: sendRoute, cap: DRAFT_BODY_LIMITS.other };
    case "/outlook-opened": return { schema: OutlookOpenedBody, route: openedRoute, cap: DRAFT_BODY_LIMITS.other };
    case "/resolve": return { schema: ResolveBody, route: resolveRoute, cap: DRAFT_BODY_LIMITS.other };
  }
  throw new Error(`no route for ${req.method} ${req.path}`);
}

function expectAccepted(req: PanelRequest | null, label: string): void {
  expect(req, label).not.toBeNull();
  const r = req as PanelRequest;
  const t = targetFor(r);
  expect(typeof t.route[r.method], `${label}: the route exports ${r.method}`).toBe("function");
  const parsed = t.schema.safeParse(r.body);
  expect(parsed.success, `${label}: ${JSON.stringify(r.body)} -> ${parsed.success ? "ok" : JSON.stringify(parsed.error.issues)}`).toBe(true);
  expect(Buffer.byteLength(JSON.stringify(r.body ?? {}), "utf8"), `${label}: within the route's body cap`).toBeLessThanOrEqual(t.cap);
}

const ACTIONS: readonly DraftUiAction[] = [
  "generate", "write_myself", "regenerate", "save", "review", "discard", "delete_restricted", "check_again", "stop",
  "show_outlook_version", "replace_with_dd", "delete_anyway",
  "resolve:mark_sent", "resolve:not_sent_new_draft", "resolve:copy_to_new_draft", "resolve:keep_outlook_version", "resolve:check", "resolve:stop_generation"
];

describe("integrator seams: the DraftPanel's requests against the routes' strict bodies", () => {
  const view = draftView({ id: `ed_${"0".repeat(31)}1`, version: 7 });
  const ctx = (over: Partial<ActionContext> = {}): ActionContext => ({ view, version: 7, instruction: "Say Thursday works", shownReadBack: readBack({ contentHash: HASH }), ...over });

  it.each(ACTIONS.map((a) => [a] as const))("%s parses under its route's body", (action) => {
    expectAccepted(requestFor(action, ctx()), action);
  });

  it("the instruction-less and read-back-less variants parse too (or send nothing)", () => {
    for (const action of ACTIONS) {
      const req = requestFor(action, ctx({ instruction: null, shownReadBack: null }));
      if (req !== null) expectAccepted(req, `${action} (no instruction, no read-back)`);
    }
    // The three actions that need the shown read-back's hash send nothing without it (C66).
    for (const action of ["replace_with_dd", "delete_anyway", "resolve:keep_outlook_version"] as const) {
      expect(requestFor(action, ctx({ shownReadBack: null })), action).toBeNull();
    }
    expect(requestFor("open_in_outlook", ctx())).toBeNull();
  });

  it("write_myself's empty body passes the server's doc validator (T15)", () => {
    expect(validateBodyDoc(EMPTY_BODY_DOC).ok).toBe(true);
  });

  it("autosave PATCHes for a reply and for a new draft", () => {
    const to = [{ address: "a@client.com", name: "A" }];
    const cc = [{ address: "b@client.com", name: null }];
    expectAccepted(editRequest({ id: view.id, kind: "reply" }, 7, { bodyDoc: DOC, replyAll: true }), "reply edit");
    expectAccepted(editRequest({ id: view.id, kind: "new" }, 7, { bodyDoc: DOC, subject: "Hello", to, cc, bcc: [] }), "new edit");
    expectAccepted(editRequest({ id: view.id, kind: "new" }, 7, { subject: null }), "new edit, subject cleared");
  });

  it("create requests (R2) for a reply and for a new email", () => {
    expectAccepted(createRequest({ kind: "reply", threadId: "t1", replyAll: false, checkedOutlook: false }, true, "Thanks"), "create reply");
    expectAccepted(createRequest({ kind: "reply", threadId: "t1", replyAll: true, checkedOutlook: true }, false, ""), "create reply, checked");
    expectAccepted(createRequest({ kind: "new", accountId: "acc_1", to: [{ address: "a@client.com", name: "A" }], cc: [], bcc: [{ address: "c@x.com", name: null }], subject: "Hi" }, true, "Intro"), "create new");
    expectAccepted(createRequest({ kind: "new", accountId: null, to: [], cc: [], bcc: [], subject: "" }, false, ""), "create new, empty");
  });

  it("the send (R10) with every blocker acknowledged, and the outlook-opened stamp (R11)", () => {
    expectAccepted(sendRequest(view.id, reviewResult({ reviewHash: HASH }), [...REVIEW_BLOCKERS]), "send");
    expect(sendRequest(view.id, reviewResult({ reviewHash: null }), [])).toBeNull();
    expectAccepted(outlookOpenedRequest(view.id), "outlook-opened");
  });
});
