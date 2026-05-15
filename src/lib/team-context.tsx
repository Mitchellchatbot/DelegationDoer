"use client";

import { createContext, useCallback, useContext, useEffect, useState } from "react";
import type { User, Department, Task } from "@/lib/types";

// One-stop in-memory cache for users + departments + tasks. Backs
// every "look up a name from an id" call across the app so nothing
// has to reach into mock-data.ts to get a teammate's display name.
//
// Fetches once on first mount; exposes a manual `refresh()` for
// surfaces that mutate the underlying data (Leader Console People
// edits etc.). A 60-second background re-fetch keeps the cache
// reasonably fresh without hammering the API.

interface TeamState {
  users: User[];
  departments: Department[];
  tasks: Task[];
  loaded: boolean;
}

interface TeamCtx extends TeamState {
  userById: (id: string | null | undefined) => User | null;
  deptById: (id: string | null | undefined) => Department | null;
  refresh: () => Promise<void>;
}

const Ctx = createContext<TeamCtx | null>(null);

export function TeamProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<TeamState>({
    users: [],
    departments: [],
    tasks: [],
    loaded: false
  });

  const refresh = useCallback(async () => {
    try {
      const [uRes, dRes, tRes] = await Promise.all([
        fetch("/api/users", { cache: "no-store" }).then((r) => (r.ok ? r.json() : null)),
        fetch("/api/departments", { cache: "no-store" }).then((r) => (r.ok ? r.json() : null)),
        fetch("/api/tasks", { cache: "no-store" }).then((r) => (r.ok ? r.json() : null))
      ]);
      setState({
        users: Array.isArray(uRes?.users)
          ? uRes.users.map((u: Record<string, unknown>) => ({
              id: u.id as string,
              name: u.name as string,
              email: u.email as string,
              role: (u.role ?? "worker") as User["role"],
              departmentIds: (u.departmentIds as string[]) ?? [],
              skills: (u.skills as string[]) ?? [],
              dailyCapacity: (u.dailyCapacity as number) ?? 8,
              throughput: (u.throughput as Record<string, number>) ?? {},
              avatarUrl: (u.avatarUrl as string | null) ?? undefined,
              isAdmin: u.isAdmin === true
            }))
          : [],
        departments: Array.isArray(dRes?.departments)
          ? dRes.departments.map((d: Record<string, unknown>) => ({
              id: d.id as string,
              name: d.name as string,
              description: (d.description as string) ?? "",
              taskTypes: (d.taskTypes as string[]) ?? []
            }))
          : [],
        tasks: Array.isArray(tRes?.tasks) ? (tRes.tasks as Task[]) : [],
        loaded: true
      });
    } catch {
      setState((s) => ({ ...s, loaded: true }));
    }
  }, []);

  useEffect(() => {
    void refresh();
    // Background refetch so newly-invited users / freshly-created
    // tasks surface without a manual reload.
    const t = setInterval(() => {
      if (typeof document !== "undefined" && document.visibilityState !== "visible") return;
      void refresh();
    }, 60_000);
    return () => clearInterval(t);
  }, [refresh]);

  const value: TeamCtx = {
    ...state,
    userById: (id) => state.users.find((u) => u.id === id) ?? null,
    deptById: (id) => state.departments.find((d) => d.id === id) ?? null,
    refresh
  };

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useTeam(): TeamCtx {
  const v = useContext(Ctx);
  if (!v) throw new Error("useTeam must be inside <TeamProvider>");
  return v;
}
