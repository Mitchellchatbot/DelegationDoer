import { departments, users } from "@/lib/mock-data";
import { ROLE_LABELS } from "@/lib/auth";

export default function SettingsPage() {
  return (
    <div className="space-y-5 max-w-4xl">
      <h1 className="text-lg font-medium">Settings</h1>

      <section className="card p-4">
        <div className="text-sm font-medium mb-3">Department task-type ownership</div>
        <div className="space-y-3">
          {departments.map((d) => (
            <div key={d.id} className="border border-border rounded-xl p-3 bg-surface2">
              <div className="flex items-center justify-between">
                <div className="text-sm font-medium">{d.name}</div>
                <button className="btn text-xs">Edit</button>
              </div>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {d.taskTypes.map((t) => <span key={t} className="badge badge-tag">{t}</span>)}
              </div>
            </div>
          ))}
        </div>
      </section>

      <section className="card p-4">
        <div className="text-sm font-medium mb-3">Incident routing</div>
        <table className="text-sm w-full">
          <thead><tr className="text-xs text-muted"><th className="text-left py-1">Issue type</th><th className="text-left py-1">Routes to</th></tr></thead>
          <tbody>
            <tr><td className="py-1.5">site down</td><td>Diego Martín</td></tr>
            <tr><td className="py-1.5">malware</td><td>Diego Martín</td></tr>
            <tr><td className="py-1.5">form broken</td><td>Diego Martín</td></tr>
            <tr><td className="py-1.5">other</td><td>Henry Chen</td></tr>
          </tbody>
        </table>
      </section>

      <section className="card p-4">
        <div className="text-sm font-medium mb-3">Users <span className="text-muted text-xs">({users.length})</span></div>
        <table className="text-sm w-full">
          <thead><tr className="text-xs text-muted"><th className="text-left py-1">Name</th><th className="text-left py-1">Role</th><th className="text-left py-1">Capacity</th></tr></thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id} className="border-t border-border/60"><td className="py-1.5">{u.name}</td><td>{ROLE_LABELS[u.role]}</td><td>{u.dailyCapacity}h/day</td></tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}
