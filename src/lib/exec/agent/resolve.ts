import type { DdClient, DdDepartment, DdProject, DdUser } from "@/lib/exec/sources/dd-types";
import type { ExecPrincipal } from "@/lib/exec/types";

// Name resolution for the chat tools (P5b contract §3.8, C48; Area B; pure).
// After trim and whitespace collapse, case-insensitive except ids:
//   '' → any (where allowed); "me" / "unassigned" (people only); exact id;
//   exact name; for people, a unique exact first name; a unique prefix of the
//   name; a unique substring of the name (3+ characters). Otherwise ambiguous
//   (2+ candidates, at most 5, best first) or none. Never fuzzier than that:
//   a wrong person is worse than asking. Under `strict` a prefix or substring
//   match comes back ambiguous with that one candidate, so a staged write (or
//   client_overview) asks instead of acting on a guess.

export type MatchedBy = "id" | "keyword" | "exact" | "first_name" | "prefix" | "substring";
export type Resolution<T> =
  | { status: "any" }                                    // the sentinel '' (and only where the param allows it)
  | { status: "ok"; value: T; by: MatchedBy }
  | { status: "none" }
  | { status: "ambiguous"; matches: T[] };               // at most 5, best first
/** strict (C48, b-agent-14): a prefix or substring match returns { status: "ambiguous", matches: [that one] }, so the
 *  tool answers needs_choice with the single candidate instead of acting on a guess. */
export interface ResolveOpts { allowAny: boolean; strict: boolean }

const MAX_MATCHES = 5;
const MIN_SUBSTRING = 3;

const collapse = (s: string) => (typeof s === "string" ? s.replace(/\s+/g, " ").trim() : "");
const fold = (s: string) => collapse(s).toLowerCase();

interface Named { id: string; name: string }

function byName<T extends Named>(a: T, b: T): number {
  return a.name.localeCompare(b.name) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

const best = <T extends Named>(list: readonly T[]) => [...list].sort(byName).slice(0, MAX_MATCHES);

function resolveNamed<T extends Named>(input: string, rows: readonly T[], opts: ResolveOpts, firstName: boolean): Resolution<T> {
  const raw = collapse(input);
  if (raw === "") return opts.allowAny ? { status: "any" } : { status: "none" };
  const byId = rows.find((r) => r.id === raw);
  if (byId) return { status: "ok", value: byId, by: "id" };
  const q = raw.toLowerCase();

  const exact = rows.filter((r) => fold(r.name) === q);
  if (exact.length === 1) return { status: "ok", value: exact[0], by: "exact" };
  if (exact.length > 1) return { status: "ambiguous", matches: best(exact) };

  if (firstName && !q.includes(" ")) {
    const first = rows.filter((r) => fold(r.name).split(" ")[0] === q);
    if (first.length === 1) return { status: "ok", value: first[0], by: "first_name" };
    if (first.length > 1) return { status: "ambiguous", matches: best(first) };
  }

  const partial = (by: "prefix" | "substring", hits: T[]): Resolution<T> | null => {
    if (hits.length === 0) return null;
    if (hits.length > 1) return { status: "ambiguous", matches: best(hits) };
    return opts.strict ? { status: "ambiguous", matches: [hits[0]] } : { status: "ok", value: hits[0], by };
  };
  const prefix = partial(
    "prefix",
    rows.filter((r) => fold(r.name).startsWith(q))
  );
  if (prefix) return prefix;
  if (q.length >= MIN_SUBSTRING) {
    const sub = partial(
      "substring",
      rows.filter((r) => fold(r.name).includes(q))
    );
    if (sub) return sub;
  }
  return { status: "none" };
}

export function resolvePerson(
  input: string,
  users: readonly DdUser[],
  principal: ExecPrincipal,
  opts: ResolveOpts & { allowUnassigned: boolean }
): Resolution<DdUser> | { status: "me" } | { status: "unassigned" } {
  const q = fold(input);
  if (q === "me") return { status: "me" };
  if (q === "unassigned") return opts.allowUnassigned ? { status: "unassigned" } : { status: "none" };
  void principal;
  return resolveNamed(input, users, opts, true);
}

export function resolveClient(input: string, clients: readonly DdClient[], opts: ResolveOpts): Resolution<DdClient> {
  return resolveNamed(input, clients, opts, false);
}

export function resolveProject(input: string, projects: readonly DdProject[], opts: ResolveOpts): Resolution<DdProject> {
  return resolveNamed(input, projects, opts, false);
}

export function resolveDepartment(input: string, departments: readonly DdDepartment[], opts: ResolveOpts): Resolution<DdDepartment> {
  return resolveNamed(input, departments, opts, false);
}
