"use client";

import type { RACIEntry, User, RaciRole } from "@/lib/types";
import { Avatar } from "./Avatar";
import { useMemo, useState } from "react";

const ROLES: (RaciRole | "")[] = ["", "responsible", "accountable", "consulted", "informed"];
const LETTER: Record<RaciRole, string> = {
  responsible: "R", accountable: "A", consulted: "C", informed: "I"
};
const TONE: Record<RaciRole, string> = {
  responsible: "text-accent border-accent/30 bg-accent/10",
  accountable: "text-warn border-warn/30 bg-warn/10",
  consulted: "text-ok border-ok/30 bg-ok/10",
  informed: "text-muted border-border bg-surface2"
};

export function RACITable({ raci, users }: { raci: RACIEntry[]; users: User[] }) {
  const areas = useMemo(() => Array.from(new Set(raci.map((r) => r.area))), [raci]);
  const [matrix, setMatrix] = useState(() => {
    const m: Record<string, Record<string, RaciRole | "">> = {};
    users.forEach((u) => {
      m[u.id] = {};
      areas.forEach((a) => {
        const hit = raci.find((r) => r.userId === u.id && r.area === a);
        m[u.id][a] = hit ? hit.role : "";
      });
    });
    return m;
  });

  function set(uid: string, area: string, role: RaciRole | "") {
    setMatrix((cur) => ({ ...cur, [uid]: { ...cur[uid], [area]: role } }));
  }

  const involved = users.filter((u) => Object.values(matrix[u.id] || {}).some((v) => v));

  return (
    <div className="overflow-x-auto">
      <table className="text-sm w-full border-collapse">
        <thead>
          <tr>
            <th className="text-left text-xs text-muted font-normal py-2 pr-3 border-b border-border">Person</th>
            {areas.map((a) => (
              <th key={a} className="text-left text-xs text-muted font-normal py-2 px-3 border-b border-border">{a}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {involved.map((u) => (
            <tr key={u.id} className="border-b border-border/60">
              <td className="py-2 pr-3">
                <div className="flex items-center gap-2">
                  <Avatar name={u.name} size={22} />
                  <span>{u.name}</span>
                </div>
              </td>
              {areas.map((a) => {
                const v = matrix[u.id][a];
                return (
                  <td key={a} className="py-2 px-3">
                    <select
                      value={v}
                      onChange={(e) => set(u.id, a, e.target.value as RaciRole | "")}
                      className={"badge cursor-pointer min-w-[44px] " + (v ? TONE[v] : "badge-tag")}
                    >
                      {ROLES.map((r) => <option key={r || "_"} value={r}>{r ? LETTER[r] : "—"}</option>)}
                    </select>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
