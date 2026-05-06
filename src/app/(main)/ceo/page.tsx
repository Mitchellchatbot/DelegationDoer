"use client";

import { useMemo, useState } from "react";
import {
  users as initialUsers, departments as initialDepartments,
  tickets, currentUser, headsOf, workersOf
} from "@/lib/mock-data";
import { Avatar } from "@/components/Avatar";
import { CapacityBar } from "@/components/CapacityBar";
import { AssignTaskDialog } from "@/components/AssignTaskDialog";
import { userCapacity } from "@/lib/capacity";
import { ROLE_LABELS } from "@/lib/auth";
import type { Role, User, Department } from "@/lib/types";
import {
  Crown, Users as UsersIcon, Building2, ListChecks, Plus, X, ShieldAlert, Send
} from "lucide-react";

const TABS = ["People", "Departments", "Org chart", "All tasks"] as const;
type Tab = typeof TABS[number];

export default function CEOConsolePage() {
  const [tab, setTab] = useState<Tab>("People");
  const [people, setPeople] = useState<User[]>(initialUsers);
  const [depts, setDepts] = useState<Department[]>(initialDepartments);
  const [assignOpen, setAssignOpen] = useState(false);

  // Gate the page itself.
  if (currentUser.role !== "ceo") {
    return (
      <div className="card p-6 max-w-lg mx-auto mt-12 text-center">
        <ShieldAlert className="w-8 h-8 text-warn mx-auto mb-2" />
        <div className="text-base font-medium">CEO only</div>
        <div className="text-sm text-muted mt-1">This page is restricted to the CEO role.</div>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <header className="flex items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2 text-xs text-muted uppercase tracking-wide">
            <Crown className="w-3 h-3" /> CEO Console
          </div>
          <h1 className="text-xl font-medium mt-1">Company-wide control</h1>
          <p className="text-sm text-muted mt-1">Manage people, departments, and see the whole org's progress at a glance.</p>
        </div>
        <button onClick={() => setAssignOpen(true)} className="btn-primary shrink-0 px-4 py-2.5">
          <Send className="w-4 h-4" /> Assign new task
        </button>
      </header>

      <AssignTaskDialog open={assignOpen} onOpenChange={setAssignOpen} />

      <div className="flex items-center gap-1 border-b border-border">
        {TABS.map((t) => {
          const active = tab === t;
          return (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={
                "relative px-3.5 py-2 text-sm transition-colors " +
                (active ? "text-ink" : "text-muted hover:text-ink")
              }
            >
              {t}
              {active && <span className="absolute left-0 right-0 -bottom-px h-px bg-accent" />}
            </button>
          );
        })}
      </div>

      {tab === "People" && <PeopleTab people={people} setPeople={setPeople} departments={depts} />}
      {tab === "Departments" && <DepartmentsTab departments={depts} setDepartments={setDepts} people={people} />}
      {tab === "Org chart" && <OrgChartTab people={people} departments={depts} />}
      {tab === "All tasks" && <AllTasksTab people={people} departments={depts} />}
    </div>
  );
}

/* ---------------- People ---------------- */

function PeopleTab({
  people, setPeople, departments
}: { people: User[]; setPeople: (u: User[]) => void; departments: Department[] }) {

  function setRole(id: string, role: Role) {
    setPeople(people.map((u) => u.id === id ? { ...u, role } : u));
  }
  function toggleDept(id: string, deptId: string) {
    setPeople(people.map((u) => {
      if (u.id !== id) return u;
      const has = u.departmentIds.includes(deptId);
      return { ...u, departmentIds: has ? u.departmentIds.filter((d) => d !== deptId) : [...u.departmentIds, deptId] };
    }));
  }

  return (
    <div className="space-y-3">
      <div className="text-sm text-muted">
        Click any role pill to change it. Toggle department chips to set membership / leadership.
      </div>
      <div className="card overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-surface2/60">
            <tr className="text-left text-xs text-muted">
              <th className="px-4 py-2.5 font-normal">Person</th>
              <th className="px-4 py-2.5 font-normal">Role</th>
              <th className="px-4 py-2.5 font-normal">Departments</th>
              <th className="px-4 py-2.5 font-normal">Reports to</th>
            </tr>
          </thead>
          <tbody>
            {people.map((u) => {
              const reportsTo = u.role === "ceo"
                ? "—"
                : u.role === "department_head"
                  ? "CEO"
                  : (() => {
                      const dep = u.departmentIds[0];
                      const head = dep ? people.find((x) => x.role === "department_head" && x.departmentIds.includes(dep)) : null;
                      return head?.name ?? "—";
                    })();
              return (
                <tr key={u.id} className="border-t border-border/60">
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2.5">
                      <Avatar name={u.name} size={26} />
                      <div>
                        <div>{u.name}</div>
                        <div className="text-xs text-muted">{u.email}</div>
                      </div>
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <RolePicker role={u.role} onChange={(r) => setRole(u.id, r)} />
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex flex-wrap gap-1.5">
                      {departments.map((d) => {
                        const on = u.departmentIds.includes(d.id);
                        return (
                          <button
                            key={d.id}
                            onClick={() => toggleDept(u.id, d.id)}
                            className={"badge cursor-pointer " + (on ? "badge-medium" : "badge-tag")}
                          >
                            {d.name}
                          </button>
                        );
                      })}
                    </div>
                  </td>
                  <td className="px-4 py-3 text-muted">{reportsTo}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function RolePicker({ role, onChange }: { role: Role; onChange: (r: Role) => void }) {
  const tone = {
    ceo: "text-warn border-warn/40 bg-warn/10",
    department_head: "text-accent border-accent/30 bg-accent/10",
    worker: "text-muted border-border bg-surface2"
  }[role];
  return (
    <select
      value={role}
      onChange={(e) => onChange(e.target.value as Role)}
      className={"badge cursor-pointer " + tone}
    >
      <option value="ceo">CEO</option>
      <option value="department_head">Department Head</option>
      <option value="worker">Worker</option>
    </select>
  );
}

/* ---------------- Departments ---------------- */

function DepartmentsTab({
  departments, setDepartments, people
}: { departments: Department[]; setDepartments: (d: Department[]) => void; people: User[] }) {
  const [draftName, setDraftName] = useState("");
  const [draftDesc, setDraftDesc] = useState("");

  function addDept() {
    const name = draftName.trim();
    if (!name) return;
    const id = "dep_" + name.toLowerCase().replace(/[^a-z0-9]+/g, "_").slice(0, 24);
    if (departments.some((d) => d.id === id)) return;
    setDepartments([...departments, { id, name, description: draftDesc.trim() || "—", taskTypes: [] }]);
    setDraftName(""); setDraftDesc("");
  }

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3">
        {departments.map((d) => {
          const heads = people.filter((u) => u.role === "department_head" && u.departmentIds.includes(d.id));
          const workers = people.filter((u) => u.role === "worker" && u.departmentIds.includes(d.id));
          return (
            <div key={d.id} className="card p-4">
              <div className="flex items-start justify-between">
                <div>
                  <div className="flex items-center gap-2">
                    <Building2 className="w-4 h-4 text-muted" />
                    <div className="text-sm font-medium">{d.name}</div>
                  </div>
                  <div className="text-xs text-muted mt-0.5 max-w-md">{d.description}</div>
                </div>
                <span className="text-[11px] text-muted">{workers.length + heads.length} member{workers.length + heads.length === 1 ? "" : "s"}</span>
              </div>

              <div className="mt-3">
                <div className="text-[11px] uppercase tracking-wide text-muted mb-1.5">Heads</div>
                <div className="flex flex-wrap gap-2">
                  {heads.length === 0 && <span className="text-xs text-muted">— no head assigned —</span>}
                  {heads.map((h) => (
                    <span key={h.id} className="inline-flex items-center gap-1.5 px-2 py-1 rounded-full bg-accent/10 border border-accent/30 text-accent text-xs">
                      <Avatar name={h.name} size={16} /> {h.name}
                    </span>
                  ))}
                </div>
              </div>

              <div className="mt-3">
                <div className="text-[11px] uppercase tracking-wide text-muted mb-1.5">Workers</div>
                <div className="flex flex-wrap gap-2">
                  {workers.map((w) => (
                    <span key={w.id} className="inline-flex items-center gap-1.5 px-2 py-1 rounded-full bg-surface2 border border-border text-xs">
                      <Avatar name={w.name} size={16} /> {w.name}
                    </span>
                  ))}
                </div>
              </div>

              <div className="mt-3 flex flex-wrap gap-1.5">
                {d.taskTypes.map((t) => <span key={t} className="badge badge-tag">{t}</span>)}
              </div>
            </div>
          );
        })}
      </div>

      <div className="card p-4">
        <div className="text-sm font-medium mb-3 inline-flex items-center gap-1.5">
          <Plus className="w-4 h-4" /> Add a department
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="label">Name</label>
            <input className="input" placeholder="e.g. Design" value={draftName} onChange={(e) => setDraftName(e.target.value)} />
          </div>
          <div>
            <label className="label">Description</label>
            <input className="input" placeholder="What does this department own?" value={draftDesc} onChange={(e) => setDraftDesc(e.target.value)} />
          </div>
        </div>
        <div className="mt-3 flex justify-end">
          <button onClick={addDept} className="btn-primary">
            <Plus className="w-4 h-4" /> Create
          </button>
        </div>
      </div>
    </div>
  );
}

/* ---------------- Org chart ---------------- */

function OrgChartTab({ people, departments }: { people: User[]; departments: Department[] }) {
  const ceo = people.find((u) => u.role === "ceo");

  return (
    <div className="card p-6">
      {ceo && (
        <div className="flex flex-col items-center">
          <Node user={ceo} subtitle="CEO" tone="warn" />
          <Connector />
          <div className="grid gap-6" style={{ gridTemplateColumns: `repeat(${departments.length}, minmax(0, 1fr))` }}>
            {departments.map((d) => {
              const heads = people.filter((u) => u.role === "department_head" && u.departmentIds.includes(d.id));
              const workers = people.filter((u) => u.role === "worker" && u.departmentIds.includes(d.id));
              return (
                <div key={d.id} className="flex flex-col items-center">
                  <div className="text-xs uppercase tracking-wide text-muted mb-2">{d.name}</div>
                  <div className="flex flex-col items-center gap-2">
                    {heads.length === 0
                      ? <div className="badge badge-tag">No head</div>
                      : heads.map((h) => <Node key={h.id} user={h} subtitle="Head" tone="accent" />)
                    }
                  </div>
                  {workers.length > 0 && <Connector />}
                  <div className="space-y-1.5">
                    {workers.map((w) => <Node key={w.id} user={w} subtitle="Worker" tone="muted" />)}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

function Node({ user, subtitle, tone }: { user: User; subtitle: string; tone: "warn" | "accent" | "muted" }) {
  const t = {
    warn: "border-warn/40 bg-warn/10",
    accent: "border-accent/30 bg-accent/10",
    muted: "border-border bg-surface2"
  }[tone];
  return (
    <div className={"flex items-center gap-2 px-3 py-1.5 rounded-2xl border " + t}>
      <Avatar name={user.name} size={22} />
      <div className="leading-tight">
        <div className="text-xs">{user.name}</div>
        <div className="text-[10px] text-muted">{subtitle}</div>
      </div>
    </div>
  );
}

function Connector() {
  return <div className="w-px h-6 bg-border my-2" />;
}

/* ---------------- All tasks ---------------- */

function AllTasksTab({ people, departments }: { people: User[]; departments: Department[] }) {
  const grouped = useMemo(() => {
    return departments.map((d) => {
      const members = people.filter((u) => u.departmentIds.includes(d.id));
      const rows = members.map((u) => {
        const my = tickets.filter((t) => t.assigneeId === u.id);
        const open = my.filter((t) => t.status !== "done");
        return {
          user: u,
          open: open.length,
          inProgress: my.filter((t) => t.status === "in_progress").length,
          urgent: my.filter((t) => t.status === "urgent" || t.priority === "critical").length,
          stalled: my.filter((t) => t.inactiveFlag).length,
          done: my.filter((t) => t.status === "done").length,
          cap: userCapacity(u, tickets)
        };
      });
      return { dept: d, rows };
    });
  }, [people, departments]);

  return (
    <div className="space-y-5">
      {grouped.map(({ dept, rows }) => (
        <section key={dept.id} className="card overflow-hidden">
          <div className="px-4 py-3 border-b border-border bg-surface2/60 flex items-center gap-2">
            <Building2 className="w-4 h-4 text-muted" />
            <div className="text-sm font-medium">{dept.name}</div>
            <div className="text-xs text-muted ml-auto">{rows.length} member{rows.length === 1 ? "" : "s"}</div>
          </div>
          <table className="w-full text-sm">
            <thead className="bg-surface/40">
              <tr className="text-left text-xs text-muted">
                <th className="px-4 py-2 font-normal">Person</th>
                <th className="px-4 py-2 font-normal">Open</th>
                <th className="px-4 py-2 font-normal">In progress</th>
                <th className="px-4 py-2 font-normal">Urgent</th>
                <th className="px-4 py-2 font-normal">Stalled</th>
                <th className="px-4 py-2 font-normal">Done</th>
                <th className="px-4 py-2 font-normal w-40">Capacity</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(({ user, open, inProgress, urgent, stalled, done, cap }) => (
                <tr key={user.id} className="border-t border-border/60">
                  <td className="px-4 py-2.5">
                    <div className="flex items-center gap-2">
                      <Avatar name={user.name} size={22} />
                      <span>{user.name}</span>
                      <span className="text-[10px] text-muted">{ROLE_LABELS[user.role]}</span>
                    </div>
                  </td>
                  <td className="px-4 py-2.5">{open}</td>
                  <td className="px-4 py-2.5">{inProgress}</td>
                  <td className={"px-4 py-2.5 " + (urgent > 0 ? "text-urgent" : "")}>{urgent}</td>
                  <td className={"px-4 py-2.5 " + (stalled > 0 ? "text-stalled" : "")}>{stalled}</td>
                  <td className="px-4 py-2.5 text-muted">{done}</td>
                  <td className="px-4 py-2.5"><CapacityBar pct={cap.pct} overSoft={cap.overSoft} overBuffer={cap.overBuffer} /></td>
                </tr>
              ))}
              {rows.length === 0 && (
                <tr><td colSpan={7} className="px-4 py-3 text-sm text-muted">No members in this department.</td></tr>
              )}
            </tbody>
          </table>
        </section>
      ))}
    </div>
  );
}
