import { describe, expect, it } from "vitest";

import { resolveClient, resolveDepartment, resolvePerson, resolveProject } from "@/lib/exec/agent/resolve";
import type { DdClient, DdDepartment, DdProject, DdUser } from "@/lib/exec/sources/dd-types";
import type { ExecPrincipal } from "@/lib/exec/types";

// P5b contract §3.8, C48 and test 117: name resolution reports how it matched.

const principal = { id: "ep_1", userId: "u_m" } as unknown as ExecPrincipal;
const u = (id: string, name: string) => ({ id, name }) as DdUser;
const USERS = [u("u_ann", "Ann Lee"), u("u_ana", "Ana Diaz"), u("u_bob", "Bob Stone"), u("u_bo", "Bo Chen"), u("u_sam", "Sam Lee"), u("u_sam2", "Sam Ito")];
const free = { allowAny: true, strict: false };
const strict = { allowAny: false, strict: true };

describe("resolvePerson", () => {
  it("reports by for every path", () => {
    expect(resolvePerson("", USERS, principal, { ...free, allowUnassigned: true })).toEqual({ status: "any" });
    expect(resolvePerson("", USERS, principal, { ...strict, allowUnassigned: true })).toEqual({ status: "none" });
    expect(resolvePerson(" Me ", USERS, principal, { ...free, allowUnassigned: true })).toEqual({ status: "me" });
    expect(resolvePerson("unassigned", USERS, principal, { ...free, allowUnassigned: true })).toEqual({ status: "unassigned" });
    expect(resolvePerson("unassigned", USERS, principal, { ...free, allowUnassigned: false })).toEqual({ status: "none" });
    expect(resolvePerson("u_bob", USERS, principal, { ...free, allowUnassigned: false })).toMatchObject({ status: "ok", by: "id", value: { id: "u_bob" } });
    expect(resolvePerson("  ann   LEE ", USERS, principal, { ...free, allowUnassigned: false })).toMatchObject({ status: "ok", by: "exact", value: { id: "u_ann" } });
    expect(resolvePerson("bob", USERS, principal, { ...strict, allowUnassigned: false })).toMatchObject({ status: "ok", by: "first_name", value: { id: "u_bob" } });
    expect(resolvePerson("Bob S", USERS, principal, { ...free, allowUnassigned: false })).toMatchObject({ status: "ok", by: "prefix", value: { id: "u_bob" } });
    expect(resolvePerson("Diaz", USERS, principal, { ...free, allowUnassigned: false })).toMatchObject({ status: "ok", by: "substring", value: { id: "u_ana" } });
    expect(resolvePerson("Nobody", USERS, principal, { ...free, allowUnassigned: false })).toEqual({ status: "none" });
  });

  it("ambiguity: shared first names, several prefixes and substrings; at most 5, best first; never fuzzy", () => {
    expect(resolvePerson("Sam", USERS, principal, { ...free, allowUnassigned: false })).toMatchObject({ status: "ambiguous", matches: [{ id: "u_sam2" }, { id: "u_sam" }] });
    expect(resolvePerson("An", USERS, principal, { ...free, allowUnassigned: false })).toMatchObject({ status: "ambiguous", matches: [{ id: "u_ana" }, { id: "u_ann" }] });
    expect(resolvePerson("Lee", USERS, principal, { ...free, allowUnassigned: false })).toMatchObject({ status: "ambiguous", matches: [{ id: "u_ann" }, { id: "u_sam" }] });
    expect(resolvePerson("ee", USERS, principal, { ...free, allowUnassigned: false })).toEqual({ status: "none" });
    expect(resolvePerson("Bobb", USERS, principal, { ...free, allowUnassigned: false })).toEqual({ status: "none" });
    const many = Array.from({ length: 9 }, (_, i) => u(`u_x${i}`, `Xavier ${i}`));
    const r = resolvePerson("Xav", many, principal, { ...free, allowUnassigned: false });
    expect(r.status === "ambiguous" && r.matches.length).toBe(5);
  });

  it("strict turns a prefix or substring match into ambiguous with that one candidate", () => {
    expect(resolvePerson("Bob S", USERS, principal, { ...strict, allowUnassigned: true })).toEqual({ status: "ambiguous", matches: [USERS[2]] });
    expect(resolvePerson("Diaz", USERS, principal, { ...strict, allowUnassigned: true })).toEqual({ status: "ambiguous", matches: [USERS[1]] });
  });
});

describe("clients, projects, departments", () => {
  const clients = [{ id: "c_1", name: "Acme Dental" }, { id: "c_2", name: "Acme Roofing" }, { id: "c_3", name: "Zenith Law" }] as DdClient[];
  const projects = [{ id: "p_1", name: "Zenith Site Rebuild" }] as DdProject[];
  const departments = [{ id: "d_1", name: "SEO" }, { id: "d_2", name: "Website" }] as DdDepartment[];
  it("id, exact, prefix, substring, ambiguous, none; no first-name rule", () => {
    expect(resolveClient("c_3", clients, strict)).toMatchObject({ status: "ok", by: "id" });
    expect(resolveClient("acme dental", clients, strict)).toMatchObject({ status: "ok", by: "exact", value: { id: "c_1" } });
    expect(resolveClient("Acme", clients, free)).toMatchObject({ status: "ambiguous" });
    expect(resolveClient("Zen", clients, strict)).toEqual({ status: "ambiguous", matches: [clients[2]] });
    expect(resolveClient("Zen", clients, free)).toMatchObject({ status: "ok", by: "prefix" });
    expect(resolveClient("Roof", clients, free)).toMatchObject({ status: "ok", by: "substring", value: { id: "c_2" } });
    expect(resolveClient("", clients, free)).toEqual({ status: "any" });
    expect(resolveProject("rebuild", projects, { allowAny: false, strict: false })).toMatchObject({ status: "ok", by: "substring" });
    expect(resolveDepartment("web", departments, free)).toMatchObject({ status: "ok", by: "prefix", value: { id: "d_2" } });
    expect(resolveDepartment("Finance", departments, free)).toEqual({ status: "none" });
  });
});
