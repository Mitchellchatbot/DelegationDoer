"use client";

import { useCallback, useEffect, useState } from "react";
import { MessageSquare, Search, Check, X, Loader2, AlertTriangle } from "lucide-react";
import { toast } from "sonner";
import { PageHero } from "@/components/PageHero";
import { PersonAvatar } from "@/components/PersonAvatar";
import { cn } from "@/lib/utils";

// Admin tool for linking DD users → Slack accounts. Useful when the
// DD email (e.g. mike@scaledai.org) doesn't match the Slack login
// email (e.g. mujtabatahir6111@gmail.com), which makes DM fan-out
// fail with users.lookupByEmail → users_not_found.
//
// Workflow per user:
//   1) Type a name fragment into the row's search box
//   2) Pick the right Slack member from the dropdown of matches
//   3) That writes both slack_email and slack_user_id to the DD row
//      so subsequent DMs skip the lookup entirely

interface DdUser {
  id: string;
  name: string;
  email: string;
  role: string;
  slack_email: string | null;
  slack_user_id: string | null;
  avatarUrl: string | null;
}

interface SlackMember {
  slackUserId: string;
  slackUsername: string;
  realName: string | null;
  displayName: string | null;
  email: string | null;
  avatarUrl: string | null;
}

export default function SlackLinksPage() {
  const [users, setUsers] = useState<DdUser[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/users?includeSlack=1", { cache: "no-store" });
      if (!res.ok) throw new Error(`status ${res.status}`);
      const data = await res.json();
      // /api/users returns { users: [...] } in the standard shape.
      // We only need a few fields; fall back gracefully if shape varies.
      const rows = (data.users ?? []) as Array<Record<string, unknown>>;
      setUsers(rows.map((u) => ({
        id: u.id as string,
        name: (u.name as string) ?? "—",
        email: (u.email as string) ?? "",
        role: (u.role as string) ?? "worker",
        slack_email: (u.slack_email as string | null) ?? null,
        slack_user_id: (u.slack_user_id as string | null) ?? null,
        avatarUrl: (u.avatarUrl as string | null) ?? null
      })).sort((a, b) => a.name.localeCompare(b.name)));
    } catch (err) {
      toast.error(`Couldn't load users: ${err instanceof Error ? err.message : "unknown"}`);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  return (
    <div className="space-y-5 max-w-5xl">
      <PageHero
        eyebrow="Admin · Slack links"
        headline={["Match teammates to ", { accent: "their Slack account" }]}
        subtitle="When the DD email doesn't match the Slack login email, DMs silently fail with users_not_found. Search Slack here and link the right account per teammate."
        icon={<MessageSquare />}
        iconTone="indigo"
      />

      {loading ? (
        <div className="card p-8 text-center text-sm text-muted">
          <Loader2 className="w-5 h-5 animate-spin mx-auto mb-2" /> Loading…
        </div>
      ) : (
        <div className="space-y-2">
          {users.map((u) => (
            <UserRow key={u.id} user={u} onLinked={load} />
          ))}
        </div>
      )}
    </div>
  );
}

function UserRow({ user, onLinked }: { user: DdUser; onLinked: () => void }) {
  const [query, setQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const [matches, setMatches] = useState<SlackMember[] | null>(null);
  const [saving, setSaving] = useState(false);

  const isLinked = !!user.slack_user_id || !!user.slack_email;

  async function search() {
    if (!query.trim()) return;
    setSearching(true);
    setMatches(null);
    try {
      const res = await fetch(`/api/admin/slack/users?q=${encodeURIComponent(query.trim())}`, {
        cache: "no-store"
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? `status ${res.status}`);
      setMatches((data.members ?? []) as SlackMember[]);
    } catch (err) {
      toast.error(`Slack search failed: ${err instanceof Error ? err.message : "unknown"}`);
    } finally {
      setSearching(false);
    }
  }

  async function link(slack: SlackMember) {
    setSaving(true);
    try {
      const res = await fetch(`/api/admin/users/${encodeURIComponent(user.id)}/slack`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          slackEmail: slack.email,
          slackUserId: slack.slackUserId
        })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? `status ${res.status}`);
      toast.success(`Linked ${user.name} → ${slack.realName ?? slack.slackUsername}`);
      setMatches(null);
      setQuery("");
      onLinked();
    } catch (err) {
      toast.error(`Couldn't link: ${err instanceof Error ? err.message : "unknown"}`);
    } finally {
      setSaving(false);
    }
  }

  async function unlink() {
    if (!window.confirm(`Unlink ${user.name}'s Slack account?`)) return;
    setSaving(true);
    try {
      const res = await fetch(`/api/admin/users/${encodeURIComponent(user.id)}/slack`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slackEmail: null, slackUserId: null })
      });
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        throw new Error(data?.error ?? `status ${res.status}`);
      }
      toast.success(`Unlinked ${user.name}`);
      onLinked();
    } catch (err) {
      toast.error(`Couldn't unlink: ${err instanceof Error ? err.message : "unknown"}`);
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="card p-4 space-y-2">
      <header className="flex items-center gap-3 flex-wrap">
        <PersonAvatar userId={user.id} name={user.name} imageUrl={user.avatarUrl ?? undefined} size={36} />
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold">{user.name}</div>
          <div className="text-[11px] text-ink/55 truncate">
            DD email: <code className="text-ink/70">{user.email}</code> · role: {user.role}
          </div>
        </div>
        {isLinked ? (
          <span className="inline-flex items-center gap-1.5 text-[11px] font-medium text-emerald-700 bg-emerald-50 border border-emerald-200/60 px-2 py-1 rounded-full">
            <Check className="w-3 h-3" />
            Linked: {user.slack_email ?? user.slack_user_id}
          </span>
        ) : (
          <span className="inline-flex items-center gap-1.5 text-[11px] font-medium text-amber-700 bg-amber-50 border border-amber-200/60 px-2 py-1 rounded-full">
            <AlertTriangle className="w-3 h-3" />
            Not linked — DMs may fail
          </span>
        )}
      </header>

      <div className="flex items-center gap-2">
        <div className="flex-1 flex items-center gap-2 px-3 py-1.5 rounded-lg border border-slate-200/70 bg-white">
          <Search className="w-3.5 h-3.5 text-ink/45" />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") void search(); }}
            placeholder="Search Slack by name or email…"
            className="flex-1 text-[13px] bg-transparent border-none outline-none focus:ring-0 placeholder:text-ink/35"
          />
        </div>
        <button
          type="button"
          onClick={() => void search()}
          disabled={searching || !query.trim()}
          className={cn(
            "inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-semibold text-white shadow-sm transition-all hover:-translate-y-0.5 active:scale-95",
            (searching || !query.trim()) && "opacity-50 cursor-not-allowed hover:translate-y-0"
          )}
          style={{ background: "linear-gradient(135deg, #2563EB 0%, #1e63ff 100%)" }}
        >
          {searching ? <Loader2 className="w-3 h-3 animate-spin" /> : <Search className="w-3 h-3" />}
          Search
        </button>
        {isLinked && (
          <button
            type="button"
            onClick={unlink}
            disabled={saving}
            className="inline-flex items-center gap-1 text-[11px] text-ink/55 hover:text-rose-600 px-2 py-1 rounded-md hover:bg-rose-50 disabled:opacity-40"
          >
            <X className="w-3 h-3" /> Unlink
          </button>
        )}
      </div>

      {matches !== null && (
        <div className="rounded-xl border border-slate-200/70 bg-white max-h-72 overflow-y-auto">
          {matches.length === 0 ? (
            <div className="text-xs text-muted italic text-center py-6">
              No Slack members matched &ldquo;{query}&rdquo;.
            </div>
          ) : (
            <ul className="divide-y divide-slate-100">
              {matches.map((m) => (
                <li key={m.slackUserId}>
                  <button
                    type="button"
                    onClick={() => void link(m)}
                    disabled={saving}
                    className="w-full flex items-center gap-3 px-3 py-2 text-left hover:bg-slate-50 disabled:opacity-40 transition-colors"
                  >
                    {m.avatarUrl && (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={m.avatarUrl} alt="" className="w-7 h-7 rounded-full shrink-0" />
                    )}
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-medium truncate">
                        {m.realName ?? m.slackUsername}
                        <span className="text-[11px] text-ink/45 font-normal ml-1.5">@{m.slackUsername}</span>
                      </div>
                      {m.email && <div className="text-[11px] text-ink/55 truncate">{m.email}</div>}
                    </div>
                    <span className="text-[10px] text-accent/85 font-semibold shrink-0">Link →</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}
