import type { ChatContextKind } from "@/lib/exec/agent/types";

// A chat context named in a URL (P5b contract §3.19.7, §3.19.11): the page's
// ?context=<kind>:<id>, as the feed rows, the project page and the thread
// page build it. Pure and client-safe (boundary B4). The id must have its
// kind's shape, exactly as POST /api/exec/chat checks it (§3.16.1); anything
// else is null and never reaches a read.

const ATTENTION_ID = /^ea_[0-9a-f]{32}$/;
const DD_ID = /^[A-Za-z0-9_.:-]{1,100}$/;
// A thread id has no whitespace or control character.
const THREAD_ID_BAD = /[\s\p{Cc}]/u;

export function isContextIdOfKind(kind: ChatContextKind, id: string): boolean {
  if (typeof id !== "string") return false;
  switch (kind) {
    case "attention":
      return ATTENTION_ID.test(id);
    case "project":
    case "client":
      return DD_ID.test(id);
    case "thread":
      return id.length >= 1 && id.length <= 200 && !THREAD_ID_BAD.test(id);
    default:
      return false;
  }
}

/** "<kind>:<id>" (the id may itself hold ":"), or null. */
export function parseContextParam(raw: string | null | undefined): { kind: ChatContextKind; id: string } | null {
  if (typeof raw !== "string") return null;
  const colon = raw.indexOf(":");
  if (colon <= 0) return null;
  const kind = raw.slice(0, colon);
  const id = raw.slice(colon + 1);
  if (kind !== "attention" && kind !== "project" && kind !== "client" && kind !== "thread") return null;
  return isContextIdOfKind(kind, id) ? { kind, id } : null;
}

/** The page link that opens a new question about this item: /executive/chat?context=<kind>:<id>. */
export function chatContextHref(kind: ChatContextKind, id: string): string {
  return `/executive/chat?context=${kind}:${encodeURIComponent(id)}`;
}
