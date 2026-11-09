// P7b DD-path parsing and the domain signal (P7b contract §3.3, N18; Area B; pure). DD paths are EXTRACTED by P7a
// (extractDdPaths / DD_PATH_RE in slack-ingest.ts, written into exec_slack_messages.dd_paths on anchors and
// candidates); P7b only parses the stored paths. Imports nothing from P7a at run time: the path patterns below are
// P7a's DD_PATH_RE, split into its two arms, and LK06 / LK07 feed P7a's own output and pattern through this parser so
// the two stay in step.
//
// Nothing here throws, whatever it is handed (LK05): a bad path, a non-string or a hostile text yields nothing.

export interface ParsedDdLinks { taskIds: string[]; clientIds: string[]; projectIds: string[]; emailThreadIds: string[] }

/** exec_slack_message_links' CHECKs: task_ids and project_ids ≤ 20, email_thread_ids ≤ 5 (§2.1.3). */
const IDS_PER_LIST = 20;
const THREADS_PER_LIST = 5;
/** A path longer than this is never one of P7a's (it stores ≤ 400); refused before any pattern runs. */
const PATH_MAX = 4_096;
/** P7a's DD_PATH_RE, first arm: /tasks/<id>, /clients/<id>, /projects/<id>. */
const ID_PATH = /^\/(tasks|clients|projects)\/([A-Za-z0-9_-]{1,100})$/;
/** P7a's DD_PATH_RE, second arm: /inboxes/<acct>?…thread=<id>… (the thread key anywhere in the query). */
const INBOX_PATH = /^\/inboxes\/[A-Za-z0-9_-]{1,100}\?(?:[^#\s]*&)?thread=[A-Za-z0-9_.:-]{1,200}(?:&[^#\s]*)?$/;
const THREAD_ID = /^[A-Za-z0-9_.:-]{1,200}$/;
const THREAD_KEY = "thread=";

function add(list: string[], value: string, max: number): void {
  if (list.length < max && !list.includes(value)) list.push(value);
}

/** The first well-formed thread= value of an inbox path's query (the pattern above guarantees one exists). */
function threadOf(path: string): string | null {
  const query = path.slice(path.indexOf("?") + 1);
  for (const part of query.split("&")) {
    if (!part.startsWith(THREAD_KEY)) continue;
    const value = part.slice(THREAD_KEY.length);
    if (THREAD_ID.test(value)) return value;
  }
  return null;
}

/** Paths in the format of P7a's DD_PATH_RE: /tasks/<id>, /clients/<id>, /projects/<id>, /inboxes/<acct>?…thread=<id>…;
 *  anything else is ignored (never throws). Deduped, ≤ 20 per list (≤ 5 thread ids). */
export function parseDdPaths(paths: readonly string[]): ParsedDdLinks {
  const out: ParsedDdLinks = { taskIds: [], clientIds: [], projectIds: [], emailThreadIds: [] };
  try {
    const list: readonly unknown[] = Array.isArray(paths) ? paths : [];
    for (const raw of list) {
      if (typeof raw !== "string" || raw.length === 0 || raw.length > PATH_MAX) continue;
      const id = ID_PATH.exec(raw);
      if (id !== null) {
        const target = id[1] === "tasks" ? out.taskIds : id[1] === "clients" ? out.clientIds : out.projectIds;
        add(target, id[2], IDS_PER_LIST);
        continue;
      }
      if (!INBOX_PATH.test(raw)) continue;
      const thread = threadOf(raw);
      if (thread !== null) add(out.emailThreadIds, thread, THREADS_PER_LIST);
    }
  } catch {
    // Never throws: whatever was parsed so far stands.
  }
  return out;
}

/** Text past this is not scanned (an item summary is ≤ 200 characters; a batch joins a few). */
const TEXT_MAX = 20_000;
const HOSTS_MAX = 50;
/** Where a token ends: whitespace, Slack's <url|label> markup, and the punctuation that brackets or lists words. */
const TOKEN_SPLIT = /[\s<>|,;()[\]{}"'`]+/;
/**
 * A domain-shaped run inside a token: dot-separated labels (letters, digits, inner hyphens, ≤ 63 each) ending in an
 * alphabetic TLD. Not when it is part of a longer run: a label of a longer host, or a run glued to letters, digits or
 * hyphens. Punctuation around it (a trailing full stop or colon, Slack's _italic_ / *bold*) is not part of it; a scheme,
 * a path, a query or a port ends it.
 */
const HOST = /(?<![A-Za-z0-9@.%+-])((?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63})(?![A-Za-z0-9-]|\.[A-Za-z0-9]|@)/g;

/** Website hosts named in text (domain-shaped tokens, lowercased, www. stripped), for the domain signal. A token holding an
 *  "@" (an email address, a mailto link) names no host; duplicates are kept once, in order of first appearance; ≤ 50.
 *  Never throws. */
export function hostsInText(text: string): string[] {
  const out: string[] = [];
  try {
    if (typeof text !== "string" || text.length === 0) return out;
    const scanned = text.length > TEXT_MAX ? text.slice(0, TEXT_MAX) : text;
    for (const token of scanned.split(TOKEN_SPLIT)) {
      if (token.length < 4 || token.includes("@")) continue;
      for (const m of token.matchAll(HOST)) {
        let host = m[1].toLowerCase();
        if (host.length > 253) continue;
        if (host.startsWith("www.") && host.slice(4).includes(".")) host = host.slice(4);
        if (!out.includes(host)) out.push(host);
        if (out.length >= HOSTS_MAX) return out;
      }
    }
  } catch {
    // Never throws: whatever was found so far stands.
  }
  return out;
}
