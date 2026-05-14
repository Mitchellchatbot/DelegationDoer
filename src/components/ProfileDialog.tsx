"use client";

import * as Dialog from "@radix-ui/react-dialog";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { AnimatePresence, motion } from "framer-motion";
import { Crown, X, Pencil, Sparkles, Plus, Trash2, TrendingUp, Mail, Phone, Briefcase, MapPin, Clock } from "lucide-react";
import { formatHHMMInViewerTz, viewerTzAbbrev, tzShortLabel } from "@/lib/work-hours";
import { toast } from "sonner";
import { PersonAvatar } from "./PersonAvatar";
import { CapacityBar } from "./CapacityBar";
import { SendKudosDialog } from "./SendKudosDialog";
import { managerOf } from "@/lib/mock-data";
import { useTeam } from "@/lib/team-context";
import { userCapacity } from "@/lib/capacity";
import { ROLE_LABELS } from "@/lib/auth";
import { useCurrentUser } from "@/lib/user-context";
import { usePresence, useRefreshPresence } from "@/lib/presence-context";
import { cn } from "@/lib/utils";

interface LiveSkill {
  id: string;
  userId: string;
  tag: string;
  manualLevel: number;
  autoScore: number;
  taskCount: number;
  combinedScore: number;
}

// Profile popup. Same content as /team/[id], but rendered as a Radix
// dialog so the user stays on whatever page they were on. Shares the
// dashboard's centered-over-main-panel layout we use for New task.

export function ProfileDialog({
  userId, trigger, open, onOpenChange
}: {
  userId: string;
  trigger?: React.ReactNode;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      {trigger && <Dialog.Trigger asChild>{trigger}</Dialog.Trigger>}
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/40 backdrop-blur-sm z-40 anim-fade-in" />
        <Dialog.Content
          aria-describedby={undefined}
          className="fixed inset-0 z-50 outline-none pointer-events-none flex items-start justify-center pt-12 pb-8 px-4 lg:pl-[264px] overflow-y-auto"
        >
          {/* Spring-scale-in from 0.94 to 1 with a slight rise — feels
              like the card you clicked is expanding into the dialog.
              Wrapped in motion.div outside the rounded panel so we don't
              fight Dialog.Content's pointer-events-none. */}
          <motion.div
            initial={{ scale: 0.94, opacity: 0, y: 14 }}
            animate={{ scale: 1, opacity: 1, y: 0 }}
            exit={{ scale: 0.96, opacity: 0, y: 8 }}
            transition={{ type: "spring", stiffness: 360, damping: 30 }}
            className="pointer-events-auto w-full max-w-[920px]"
          >
            <ProfileBody userId={userId} />
          </motion.div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

interface LiveProfile {
  id: string;
  name: string;
  email: string;
  avatarUrl: string | null;
  role: string;
  jobTitle: string | null;
  location: string | null;
  bio: string | null;
  pronouns: string | null;
  birthday: string | null;
  personalEmail: string | null;
  phone: string | null;
  workHoursStart: string | null;
  workHoursEnd: string | null;
  workTimezone: string | null;
}

function ProfileBody({ userId }: { userId: string }) {
  const me = useCurrentUser();
  const isMe = me.id === userId;
  const [editing, setEditing] = useState(false);
  // Pull live data so the cover image reflects the latest avatar even
  // before mock-data updates.
  const live = usePresence(userId);

  // Contact + bio fields live on the live `users` row (work email,
  // personal email, phone, job title, location, bio, pronouns).
  // Mock-data doesn't carry them, so we fetch separately. The
  // endpoint sanitizes private fields based on viewer role, so
  // workers won't get personal email + phone for other people.
  const [profile, setProfile] = useState<LiveProfile | null>(null);
  const [profileBump, setProfileBump] = useState(0);
  useEffect(() => {
    let cancelled = false;
    fetch(`/api/users/${encodeURIComponent(userId)}/profile`, { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (!cancelled && d?.profile) setProfile(d.profile); })
      .catch(() => { /* mock fallback below covers display */ });
    return () => { cancelled = true; };
  }, [userId, profileBump]);

  // Pull the live team — no more mock-data import. user is found in
  // the live users list; if it's still loading we show a skeleton
  // rather than the misleading "User not found" we used to throw.
  const team = useTeam();
  const user = useMemo(
    () => team.users.find((u) => u.id === userId) ?? null,
    [userId, team.users]
  );

  if (!user) {
    if (!team.loaded) {
      return (
        <div className="rounded-3xl border border-slate-200/70 bg-white p-8 text-center text-sm text-ink/55">
          Loading profile…
        </div>
      );
    }
    return (
      <div className="rounded-3xl border border-slate-200/70 bg-white p-8 text-center">
        <div className="text-base font-medium">User not found</div>
        <div className="text-sm text-muted mt-1">{userId}</div>
        <Dialog.Close asChild>
          <button className="btn mt-4">Close</button>
        </Dialog.Close>
      </div>
    );
  }

  const avatarUrl = live?.avatarUrl ?? user.avatarUrl ?? null;
  const userDepts = user.departmentIds
    .map((id) => team.deptById(id))
    .filter(Boolean) as { id: string; name: string }[];
  const cap = userCapacity(user, team.tasks);
  const myTasks = team.tasks.filter((t) => t.assigneeId === user.id);

  // Live skills from /api/skills, polled when this dialog mounts and
  // re-fetched after every edit so the read-only tiles + edit form
  // share state. `skillsBump` flips on save to trigger a refetch.
  const [skills, setSkills] = useState<LiveSkill[] | null>(null);
  const [skillsBump, setSkillsBump] = useState(0);
  useEffect(() => {
    let cancelled = false;
    fetch(`/api/skills?userId=${encodeURIComponent(userId)}`, { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : { skills: [] }))
      .then((d) => { if (!cancelled) setSkills(d.skills ?? []); })
      .catch(() => { if (!cancelled) setSkills([]); });
    return () => { cancelled = true; };
  }, [userId, skillsBump]);

  // "Task types handled" derives from skills with task_count > 0 — i.e.
  // tags they've actually completed work in. Falls through to all tags
  // when there's no completion history yet.
  const taskTypeHistory = useMemo(() => {
    const list = skills ?? [];
    const earned = list.filter((s) => s.taskCount > 0).map((s) => s.tag);
    if (earned.length > 0) return earned;
    return list.map((s) => s.tag);
  }, [skills]);
  // managerOf is a pure function over the org structure — feed it
  // the live users list so the answer reflects current org state.
  const manager = managerOf(user, team.users);
  const directReports = user.role === "leader"
    ? team.users.filter((u) => u.role === "department_head")
    : user.role === "department_head"
      ? team.users.filter((u) =>
          u.role === "worker" &&
          u.departmentIds.some((d) => user.departmentIds.includes(d))
        )
      : [];

  return (
    <div className="relative rounded-3xl overflow-hidden border border-slate-200/70 shadow-[0_24px_72px_-24px_rgba(60,60,120,0.45)] bg-slate-50">
      {/* Cover background — the user's avatar (or a gradient fallback)
          blurred + dimmed so the glass cards above it stay readable. */}
      <div
        aria-hidden
        className="absolute inset-0 z-0"
        style={{
          backgroundImage: avatarUrl
            ? `url(${avatarUrl})`
            : "linear-gradient(120deg, #DBEAFE 0%, #C7D2FE 50%, #DBEAFE 100%)",
          backgroundSize: "cover",
          backgroundPosition: "center",
          filter: avatarUrl ? "blur(28px) brightness(0.85) saturate(1.15)" : "none",
          transform: "scale(1.15)" // overshoot so blur edges don't show
        }}
      />
      {/* Gradient scrim for legibility */}
      <div
        aria-hidden
        className="absolute inset-0 z-0 pointer-events-none"
        style={{
          background:
            "linear-gradient(180deg, rgba(15,23,42,0.18) 0%, rgba(255,255,255,0.55) 38%, rgba(255,255,255,0.92) 100%)"
        }}
      />

      {/* Sticky header — glass over the cover */}
      <div className="relative z-10 flex items-center justify-between px-6 py-3 border-b border-white/40 bg-white/30 backdrop-blur-md">
        <Dialog.Title className="text-[12px] uppercase tracking-[0.18em] font-semibold text-accent">
          Profile
        </Dialog.Title>
        <Dialog.Close asChild>
          <button
            type="button"
            className="w-9 h-9 rounded-full grid place-items-center text-ink/70 hover:text-ink bg-white/70 hover:bg-white border border-white/70 shadow-sm transition-colors"
            aria-label="Close"
          >
            <X className="w-4 h-4" />
          </button>
        </Dialog.Close>
      </div>

      <div className="relative z-10 p-6 space-y-5">
        {/* Hero — glass card */}
        <div className="rounded-2xl border border-white/60 bg-white/70 backdrop-blur-md shadow-soft p-5 flex items-start gap-4">
          <PersonAvatar
            userId={user.id}
            name={user.name}
            imageUrl={user.avatarUrl}
            size={72}
            className="ring-4 ring-white shadow-lift"
          />
          <div className="flex-1 min-w-0">
            <div className="text-2xl font-bold text-ink leading-tight tracking-tight flex items-center gap-2 flex-wrap">
              {user.name}
              {profile?.pronouns && (
                <span className="text-[11px] font-medium text-ink/55 normal-case">
                  ({profile.pronouns})
                </span>
              )}
              {user.role === "leader" && <Crown className="w-5 h-5 text-amber-500" />}
              {user.role === "department_head" && <Crown className="w-4 h-4 text-accent" />}
            </div>
            {/* Job title (real-world role) takes the prominent line —
                "Lead designer" beats "worker" for human context. The
                system role still shows below it as a small chip. */}
            {profile?.jobTitle && (
              <div className="text-sm font-medium text-ink/80 mt-0.5">
                {profile.jobTitle}
              </div>
            )}
            <div className="text-sm text-ink/70 mt-1 inline-flex items-center gap-1.5 flex-wrap">
              <span>{ROLE_LABELS[user.role]}</span>
              {userDepts.length > 0 && (
                <span className="text-ink/45">· {userDepts.map((d) => d.name).join(" · ")}</span>
              )}
              {profile?.location && (
                <span className="inline-flex items-center gap-1 text-ink/55">
                  · <MapPin className="w-3 h-3" /> {profile.location}
                </span>
              )}
            </div>
            <div className="mt-1.5 text-[12px] text-ink/55">
              {manager ? <>Reports to <span className="text-ink/85">{manager.name}</span></> : "Top of the org"}
              {directReports.length > 0 && <> · {directReports.length} direct report{directReports.length === 1 ? "" : "s"}</>}
            </div>
            {profile?.bio && (
              <p className="mt-2 text-[13px] text-ink/75 leading-snug max-w-prose whitespace-pre-wrap">
                {profile.bio}
              </p>
            )}
            <div className="mt-3 max-w-sm">
              <CapacityBar pct={cap.pct} overSoft={cap.overSoft} overBuffer={cap.overBuffer} />
            </div>
          </div>
          <div className="flex flex-col gap-2 shrink-0">
            {isMe ? (
              <button
                onClick={() => setEditing(true)}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[13px] font-medium border border-white/70 bg-white/85 hover:bg-white hover:border-accent/40 transition-colors shadow-sm"
              >
                <Pencil className="w-3.5 h-3.5" />
                Edit profile
              </button>
            ) : (
              <SendKudosDialog
                recipientId={user.id}
                recipientName={user.name}
                recipientAvatarUrl={user.avatarUrl}
                trigger={
                  <button className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[13px] font-medium bg-gradient-to-r from-amber-400 to-orange-500 text-white shadow-sm hover:shadow-lift transition-all">
                    <Sparkles className="w-3.5 h-3.5" />
                    Send kudos
                  </button>
                }
              />
            )}
          </div>
        </div>

        <AnimatePresence>
          {editing && isMe && (
            <motion.div
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: "auto", opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={{ duration: 0.22 }}
              className="overflow-hidden"
            >
              <EditForm
                userId={user.id}
                initialName={user.name}
                initialProfile={profile}
                initialSkills={skills ?? []}
                onCancel={() => setEditing(false)}
                onSaved={() => {
                  setEditing(false);
                  setSkillsBump((n) => n + 1);
                  setProfileBump((n) => n + 1);
                }}
              />
            </motion.div>
          )}
        </AnimatePresence>

        {profile && (
          (profile.email || profile.personalEmail || profile.phone) && (
            <section className="rounded-2xl border border-white/60 bg-white/65 backdrop-blur-md p-4 shadow-soft">
              <div className="text-[12px] uppercase tracking-[0.18em] font-semibold text-muted mb-2.5">
                Contact
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                <ContactRow
                  icon={<Mail className="w-3.5 h-3.5 text-blue-600" />}
                  label="Work email"
                  value={profile.email}
                  href={profile.email ? `mailto:${profile.email}` : undefined}
                />
                {profile.personalEmail && (
                  <ContactRow
                    icon={<Mail className="w-3.5 h-3.5 text-fuchsia-600" />}
                    label="Personal email"
                    value={profile.personalEmail}
                    href={`mailto:${profile.personalEmail}`}
                  />
                )}
                {profile.phone && (
                  <ContactRow
                    icon={<Phone className="w-3.5 h-3.5 text-emerald-600" />}
                    label="Phone"
                    value={profile.phone}
                    href={`tel:${profile.phone.replace(/[^+\d]/g, "")}`}
                  />
                )}
                {profile.jobTitle && (
                  <ContactRow
                    icon={<Briefcase className="w-3.5 h-3.5 text-indigo-600" />}
                    label="Title"
                    value={profile.jobTitle}
                  />
                )}
                {profile.location && (
                  <ContactRow
                    icon={<MapPin className="w-3.5 h-3.5 text-amber-600" />}
                    label="Location"
                    value={profile.location}
                  />
                )}
                {profile.workHoursStart && profile.workHoursEnd && profile.workTimezone && (
                  <WorkHoursRow
                    start={profile.workHoursStart}
                    end={profile.workHoursEnd}
                    tz={profile.workTimezone}
                    isSelf={isMe}
                  />
                )}
              </div>
              {/* Privacy footer — surfaces when the viewer COULD have
                  seen private fields but the owner hasn't filled them
                  in yet. Helps the user know what to add. */}
              {isMe && (!profile.personalEmail || !profile.phone) && (
                <div className="text-[10px] text-ink/45 mt-2.5 italic">
                  Personal email + phone are private — only you and leaders ever see them.
                </div>
              )}
            </section>
          )
        )}

        {directReports.length > 0 && (
          <section className="rounded-2xl border border-white/60 bg-white/65 backdrop-blur-md p-4 shadow-soft">
            <div className="text-[12px] uppercase tracking-[0.18em] font-semibold text-muted mb-2.5">
              Direct reports
            </div>
            <div className="flex flex-wrap gap-2">
              {directReports.map((r) => (
                <Link
                  key={r.id}
                  href={`/team/${r.id}`}
                  className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-full bg-white/80 border border-white/70 hover:border-accent/40 text-xs"
                >
                  <PersonAvatar userId={r.id} name={r.name} imageUrl={r.avatarUrl} size={18} />
                  {r.name}
                  <span className="text-muted">· {ROLE_LABELS[r.role]}</span>
                </Link>
              ))}
            </div>
          </section>
        )}

        <div className="grid grid-cols-3 gap-3">
          <section className="rounded-2xl border border-white/60 bg-white/75 backdrop-blur-md p-4 shadow-soft">
            <div className="text-[12px] uppercase tracking-[0.18em] font-semibold text-accent mb-2.5">Skills</div>
            <ul className="space-y-1.5">
              {skills === null && (
                <li className="text-[11px] text-muted italic">Loading…</li>
              )}
              {skills && skills.length === 0 && (
                <li className="text-[11px] text-muted italic">No skills entered yet.</li>
              )}
              {[...(skills ?? [])]
                .sort((a, b) => b.combinedScore - a.combinedScore)
                .slice(0, 8)
                .map((s) => (
                  <li key={s.id} className="flex items-center justify-between text-sm">
                    <span className="truncate">#{s.tag}</span>
                    <span className="text-muted text-xs tabular-nums shrink-0 ml-2">
                      {s.manualLevel > 0 ? `L${s.manualLevel}` : "—"}
                      {s.taskCount > 0 && (
                        <span className="text-accent ml-1">· {s.taskCount}✓</span>
                      )}
                    </span>
                  </li>
                ))}
            </ul>
          </section>
          <section className="rounded-2xl border border-white/60 bg-white/75 backdrop-blur-md p-4 shadow-soft">
            <div className="text-[12px] uppercase tracking-[0.18em] font-semibold text-accent mb-2.5">Throughput</div>
            <ul className="space-y-1 text-sm">
              {Object.entries(user.throughput || {}).length === 0 && (
                <li className="text-[11px] text-muted italic">—</li>
              )}
              {Object.entries(user.throughput || {}).map(([k, v]) => (
                <li key={k} className="flex items-center justify-between">
                  <span className="text-muted">{k.replace(/_/g, " ")}</span>
                  <span className="tabular-nums">{v as number}</span>
                </li>
              ))}
            </ul>
          </section>
          <section className="rounded-2xl border border-white/60 bg-white/75 backdrop-blur-md p-4 shadow-soft">
            <div className="text-[12px] uppercase tracking-[0.18em] font-semibold text-accent mb-2.5">Task types</div>
            <div className="flex flex-wrap gap-1.5">
              {taskTypeHistory.length === 0 && (
                <span className="text-[11px] text-muted italic">—</span>
              )}
              {taskTypeHistory.map((t) => (
                <span key={t} className="text-[11px] px-2 py-0.5 rounded-full bg-slate-100 text-ink/70 border border-slate-200">
                  #{t}
                </span>
              ))}
            </div>
          </section>
        </div>

        {myTasks.length > 0 && (
          <section className="rounded-2xl border border-white/60 bg-white/65 backdrop-blur-md p-4 shadow-soft">
            <div className="text-[12px] uppercase tracking-[0.18em] font-semibold text-accent mb-2.5">
              Assigned tasks · {myTasks.length}
            </div>
            <ul className="space-y-1.5 max-h-[260px] overflow-y-auto pr-1">
              {myTasks.slice(0, 12).map((t) => (
                <li key={t.id}>
                  <Link
                    href={`/tasks/${t.id}`}
                    className={cn(
                      "block rounded-xl border border-white/70 bg-white/85 px-3 py-2 hover:border-accent/40 hover:bg-white transition-colors",
                      t.inactiveFlag && "border-amber-300/60"
                    )}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <div className="text-sm font-medium truncate">{t.title}</div>
                      <span className="text-[10px] text-muted shrink-0">{t.status.replace("_", " ")}</span>
                    </div>
                  </Link>
                </li>
              ))}
            </ul>
            {myTasks.length > 12 && (
              <Link
                href={`/team/${user.id}`}
                className="text-[12px] text-accent hover:underline mt-2 inline-block"
              >
                See all {myTasks.length} on the full profile →
              </Link>
            )}
          </section>
        )}
      </div>
    </div>
  );
}

/* ============================ EDIT FORM ============================ */

function EditForm({
  userId, initialName, initialProfile, initialSkills, onCancel, onSaved
}: {
  userId: string;
  initialName: string;
  initialProfile: LiveProfile | null;
  initialSkills: LiveSkill[];
  onCancel: () => void;
  onSaved: () => void;
}) {
  const router = useRouter();
  const refreshPresence = useRefreshPresence();
  const [name, setName] = useState(initialName);
  const [jobTitle, setJobTitle] = useState(initialProfile?.jobTitle ?? "");
  const [pronouns, setPronouns] = useState(initialProfile?.pronouns ?? "");
  const [location, setLocation] = useState(initialProfile?.location ?? "");
  const [bio, setBio] = useState(initialProfile?.bio ?? "");
  const [personalEmail, setPersonalEmail] = useState(initialProfile?.personalEmail ?? "");
  const [phone, setPhone] = useState(initialProfile?.phone ?? "");
  const [workHoursStart, setWorkHoursStart] = useState(initialProfile?.workHoursStart ?? "");
  const [workHoursEnd, setWorkHoursEnd] = useState(initialProfile?.workHoursEnd ?? "");
  const [workTimezone, setWorkTimezone] = useState(
    initialProfile?.workTimezone ??
      (typeof window !== "undefined" ? Intl.DateTimeFormat().resolvedOptions().timeZone : "")
  );
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);

  // Skills working copy — diffed against `initialSkills` on save so we
  // only emit POST/DELETEs for actual changes. Add/remove/level tracked
  // here without round-tripping until the user clicks Save.
  type Draft = {
    id: string;          // existing row id, or `new_<tag>` for additions
    tag: string;
    manualLevel: number;
    autoScore: number;
    taskCount: number;
    isNew: boolean;
    deleted: boolean;
  };
  const [skills, setSkills] = useState<Draft[]>(() =>
    initialSkills.map((s) => ({
      id: s.id,
      tag: s.tag,
      manualLevel: s.manualLevel,
      autoScore: s.autoScore,
      taskCount: s.taskCount,
      isNew: false,
      deleted: false
    }))
  );
  const [draftTag, setDraftTag] = useState("");

  function addTag() {
    const tag = draftTag.trim().toLowerCase();
    if (!tag) return;
    if (skills.some((s) => s.tag === tag && !s.deleted)) {
      toast.error(`You already have "#${tag}"`);
      return;
    }
    setSkills((cur) => {
      // If a deleted row matches, undelete it instead of adding a new one.
      const idx = cur.findIndex((s) => s.tag === tag && s.deleted);
      if (idx >= 0) {
        const next = cur.slice();
        next[idx] = { ...next[idx], deleted: false, manualLevel: Math.max(1, next[idx].manualLevel) };
        return next;
      }
      return [...cur, {
        id: `new_${tag}_${Date.now().toString(36)}`,
        tag,
        manualLevel: 1,
        autoScore: 0,
        taskCount: 0,
        isNew: true,
        deleted: false
      }];
    });
    setDraftTag("");
  }

  function setLevel(id: string, manualLevel: number) {
    setSkills((cur) => cur.map((s) => s.id === id ? { ...s, manualLevel } : s));
  }

  function removeSkill(id: string) {
    setSkills((cur) => {
      const row = cur.find((s) => s.id === id);
      if (!row) return cur;
      // For unsaved additions, drop entirely. For existing rows, mark
      // deleted so save() emits a DELETE.
      if (row.isNew) return cur.filter((s) => s.id !== id);
      return cur.map((s) => s.id === id ? { ...s, deleted: true } : s);
    });
  }

  async function save() {
    if (saving) return;
    if (!name.trim()) {
      toast.error("Name can't be empty");
      return;
    }
    setSaving(true);
    try {
      // 1) Name + contact + bio. Single PATCH so changes commit
      // atomically. Empty strings get sent through and the API
      // turns them into NULL — that's how the user "clears" a field.
      const patch: Record<string, string | null> = {};
      if (name.trim() !== initialName) patch.name = name.trim();
      const trimOrNull = (v: string) => v.trim() ? v.trim() : null;
      if (trimOrNull(jobTitle) !== (initialProfile?.jobTitle ?? null)) patch.jobTitle = trimOrNull(jobTitle);
      if (trimOrNull(pronouns) !== (initialProfile?.pronouns ?? null)) patch.pronouns = trimOrNull(pronouns);
      if (trimOrNull(location) !== (initialProfile?.location ?? null)) patch.location = trimOrNull(location);
      if (trimOrNull(bio) !== (initialProfile?.bio ?? null)) patch.bio = trimOrNull(bio);
      if (trimOrNull(personalEmail) !== (initialProfile?.personalEmail ?? null)) patch.personalEmail = trimOrNull(personalEmail);
      if (trimOrNull(phone) !== (initialProfile?.phone ?? null)) patch.phone = trimOrNull(phone);
      if (trimOrNull(workHoursStart) !== (initialProfile?.workHoursStart ?? null)) patch.workHoursStart = trimOrNull(workHoursStart);
      if (trimOrNull(workHoursEnd) !== (initialProfile?.workHoursEnd ?? null)) patch.workHoursEnd = trimOrNull(workHoursEnd);
      if (trimOrNull(workTimezone) !== (initialProfile?.workTimezone ?? null)) patch.workTimezone = trimOrNull(workTimezone);
      if (Object.keys(patch).length > 0) {
        const res = await fetch("/api/users/me", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(patch)
        });
        if (!res.ok) {
          const d = await res.json().catch(() => null);
          throw new Error(d?.error ?? `failed (${res.status})`);
        }
      }

      // 2) Skill diff — pretend each row in `initialSkills` is the
      // baseline, walk the working copy and emit only the real changes.
      const initial = new Map(initialSkills.map((s) => [s.tag, s]));
      const ops: Promise<Response>[] = [];
      for (const s of skills) {
        const base = initial.get(s.tag);
        if (s.deleted && base) {
          ops.push(fetch(`/api/skills?id=${encodeURIComponent(base.id)}`, { method: "DELETE" }));
          continue;
        }
        if (s.deleted) continue; // never existed server-side
        if (!base || base.manualLevel !== s.manualLevel) {
          ops.push(fetch("/api/skills", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ userId, tag: s.tag, manualLevel: s.manualLevel })
          }));
        }
      }
      const results = await Promise.all(ops);
      const failed = results.filter((r) => !r.ok).length;
      if (failed > 0) {
        throw new Error(`${failed} skill change${failed === 1 ? "" : "s"} failed`);
      }

      toast.success("Profile updated.");
      await refreshPresence();
      router.refresh();
      onSaved();
    } catch (e) {
      toast.error(`Save failed: ${e instanceof Error ? e.message : "network error"}`);
    } finally {
      setSaving(false);
    }
  }

  async function uploadAvatar(file: File) {
    if (uploading) return;
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await fetch("/api/users/me/avatar", { method: "POST", body: fd });
      if (!res.ok) {
        const d = await res.json().catch(() => null);
        throw new Error(d?.error ?? `failed (${res.status})`);
      }
      toast.success("Avatar updated.");
      await refreshPresence();
      router.refresh();
    } catch (e) {
      toast.error(`Upload failed: ${e instanceof Error ? e.message : "network error"}`);
    } finally {
      setUploading(false);
    }
  }

  const visibleSkills = skills.filter((s) => !s.deleted);

  return (
    <div className="rounded-2xl border border-accent/40 bg-white/75 backdrop-blur-md p-4 space-y-4 shadow-soft">
      <div className="text-[12px] uppercase tracking-[0.18em] font-semibold text-accent">
        Edit profile
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="label">Name</label>
          <input
            className="input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={80}
            autoFocus
          />
        </div>
        <div>
          <label className="label">Avatar</label>
          <input
            type="file"
            accept="image/*"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) uploadAvatar(f);
            }}
            disabled={uploading}
            className="input py-1.5 text-sm file:mr-2 file:rounded-md file:border-0 file:bg-slate-100 file:px-2 file:py-1 file:text-xs"
          />
        </div>
        <div>
          <label className="label">Job title</label>
          <input
            className="input"
            value={jobTitle}
            onChange={(e) => setJobTitle(e.target.value)}
            placeholder="Lead designer, Senior copywriter…"
            maxLength={60}
          />
        </div>
        <div>
          <label className="label">Pronouns</label>
          <input
            className="input"
            value={pronouns}
            onChange={(e) => setPronouns(e.target.value)}
            placeholder="she/her · he/him · they/them"
            maxLength={30}
          />
        </div>
        <div>
          <label className="label">Location</label>
          <input
            className="input"
            value={location}
            onChange={(e) => setLocation(e.target.value)}
            placeholder="Toronto · Lahore · Remote"
            maxLength={80}
          />
        </div>
        <div>
          <label className="label">Phone <span className="text-[10px] text-muted font-normal">· private</span></label>
          <input
            className="input"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            placeholder="+1 555 …"
            maxLength={40}
          />
        </div>
        <div className="col-span-2">
          <label className="label">
            Personal email <span className="text-[10px] text-muted font-normal">· private — only you + leaders see this</span>
          </label>
          <input
            type="email"
            className="input"
            value={personalEmail}
            onChange={(e) => setPersonalEmail(e.target.value)}
            placeholder="you@personal.com"
            maxLength={120}
          />
        </div>
        <div className="col-span-2">
          <label className="label">Bio</label>
          <textarea
            className="input"
            rows={3}
            value={bio}
            onChange={(e) => setBio(e.target.value)}
            placeholder="One or two lines — strengths, what you're working on, anything you'd want a new teammate to know."
            maxLength={500}
          />
          <div className="text-[10px] text-muted mt-0.5 text-right tabular-nums">
            {bio.length} / 500
          </div>
        </div>
        <div>
          <label className="label">Work hours start</label>
          <input
            type="time"
            className="input"
            value={workHoursStart}
            onChange={(e) => setWorkHoursStart(e.target.value)}
          />
        </div>
        <div>
          <label className="label">Work hours end</label>
          <input
            type="time"
            className="input"
            value={workHoursEnd}
            onChange={(e) => setWorkHoursEnd(e.target.value)}
          />
        </div>
        <div className="col-span-2">
          <label className="label">Your timezone</label>
          <input
            className="input"
            value={workTimezone}
            onChange={(e) => setWorkTimezone(e.target.value)}
            placeholder="Asia/Karachi · America/New_York · Europe/London"
          />
          <div className="text-[10px] text-muted mt-0.5">
            Teammates in other zones see your hours converted to their own local time.
          </div>
        </div>
      </div>

      <div>
        <div className="flex items-center justify-between mb-1.5">
          <label className="label !mb-0">Skills &amp; task types</label>
          <span className="text-[10px] text-muted">
            Used by auto-delegation. Manual L0–L5; the system bumps you up automatically as you complete tagged tasks.
          </span>
        </div>
        <div className="flex flex-wrap gap-2">
          {visibleSkills.length === 0 && (
            <span className="text-[11px] text-muted italic">
              No skills yet — add your first below.
            </span>
          )}
          <AnimatePresence mode="popLayout">
            {visibleSkills.map((s) => (
              <motion.div
                key={s.id}
                layout
                initial={{ opacity: 0, scale: 0.85 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.85 }}
                transition={{ type: "spring", stiffness: 500, damping: 30 }}
              >
                <DraftSkillChip
                  skill={s}
                  onSetLevel={(lvl) => setLevel(s.id, lvl)}
                  onRemove={() => removeSkill(s.id)}
                />
              </motion.div>
            ))}
          </AnimatePresence>
        </div>
        <div className="flex items-center gap-2 mt-2.5">
          <input
            value={draftTag}
            onChange={(e) => setDraftTag(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") { e.preventDefault(); addTag(); }
            }}
            placeholder="e.g. wordpress, copywriting, figma"
            className="input py-1 text-sm flex-1"
          />
          <button
            type="button"
            onClick={addTag}
            disabled={!draftTag.trim()}
            className="btn text-xs disabled:opacity-50"
          >
            <Plus className="w-3.5 h-3.5" />
            Add
          </button>
        </div>
      </div>

      <div className="flex justify-end gap-2 pt-1">
        <button onClick={onCancel} className="btn">Cancel</button>
        <button onClick={save} disabled={saving} className="btn-primary disabled:opacity-50">
          {saving ? "Saving…" : "Save"}
        </button>
      </div>
    </div>
  );
}

/* ============================ DRAFT SKILL CHIP ============================ */

// Same chip recipe as SkillsSection's, but bound to a draft row instead
// of writing through to the API on every interaction. Save batches all
// changes at the end.
function DraftSkillChip({
  skill, onSetLevel, onRemove
}: {
  skill: { tag: string; manualLevel: number; autoScore: number; taskCount: number };
  onSetLevel: (lvl: number) => void;
  onRemove: () => void;
}) {
  const strengthPct = Math.min(100, ((skill.manualLevel * 6 + skill.autoScore) / 50) * 100);
  return (
    <div className="group relative rounded-xl border border-slate-200/70 bg-white px-3 py-2 min-w-[180px] shadow-sm hover:border-accent/40 transition-colors">
      <div className="flex items-center justify-between gap-2 mb-1.5">
        <div className="text-[12px] font-semibold text-ink truncate">#{skill.tag}</div>
        <button
          type="button"
          onClick={onRemove}
          className="opacity-0 group-hover:opacity-100 transition-opacity text-muted hover:text-urgent"
          title="Remove skill"
        >
          <Trash2 className="w-3 h-3" />
        </button>
      </div>
      <div className="flex items-center gap-1 mb-1.5">
        {[1, 2, 3, 4, 5].map((lvl) => {
          const active = skill.manualLevel >= lvl;
          return (
            <button
              key={lvl}
              type="button"
              onClick={() => onSetLevel(skill.manualLevel === lvl ? 0 : lvl)}
              className={cn(
                "w-3 h-3 rounded-full transition-all cursor-pointer",
                active ? "bg-accent shadow-sm" : "bg-slate-200 hover:bg-slate-300"
              )}
              title={`Set L${lvl}`}
            />
          );
        })}
        <span className="ml-1 text-[10px] text-muted tabular-nums">
          {skill.manualLevel > 0 ? `L${skill.manualLevel}` : "—"}
        </span>
      </div>
      <div className="flex items-center gap-1.5">
        <div className="flex-1 h-1 rounded-full bg-slate-100 overflow-hidden">
          <div
            className="h-full bg-gradient-to-r from-accent to-blue-400 transition-[width] duration-500"
            style={{ width: `${strengthPct}%` }}
          />
        </div>
        <span
          className="text-[10px] text-muted tabular-nums inline-flex items-center gap-0.5"
          title={`${skill.taskCount} task${skill.taskCount === 1 ? "" : "s"} completed with this tag`}
        >
          <TrendingUp className="w-2.5 h-2.5" />
          {skill.taskCount}
        </span>
      </div>
    </div>
  );
}

// Compact row used in the Contact section. Icon + label + value;
// when an `href` is provided the value becomes a clickable link
// (mailto, tel, etc.).
// Work-hours row in the Contact grid. Renders the user's stated
// hours in their own timezone PLUS the converted equivalent in the
// viewer's local timezone — so 7–2 Karachi shows up as
// "10:00 PM – 5:00 AM EST" for someone in New York.
function WorkHoursRow({
  start, end, tz, isSelf
}: { start: string; end: string; tz: string; isSelf: boolean }) {
  const localStart = formatHHMMInViewerTz(start, tz);
  const localEnd = formatHHMMInViewerTz(end, tz);
  const viewerTz = (typeof window !== "undefined")
    ? Intl.DateTimeFormat().resolvedOptions().timeZone
    : "";
  const showsViewerLine = !isSelf && viewerTz && viewerTz !== tz;
  const viewerAbbrev = viewerTzAbbrev();
  // Format the user's own hours for the headline line.
  const ownStart = formatHHMMInViewerTz(start, tz, tz);
  const ownEnd = formatHHMMInViewerTz(end, tz, tz);
  const tzLabel = tzShortLabel(tz);
  return (
    <div className="flex items-start gap-2 px-3 py-1.5 rounded-xl bg-white/85 border border-white/70 sm:col-span-2">
      <div className="mt-0.5 shrink-0">
        <Clock className="w-3.5 h-3.5 text-teal-600" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="text-[10px] uppercase tracking-wide font-semibold text-ink/45">
          Work hours
        </div>
        <div className="text-[13px] text-ink/85">
          {ownStart} – {ownEnd}{" "}
          <span className="text-ink/55">· {tzLabel} time</span>
        </div>
        {showsViewerLine && (
          <div className="text-[11px] text-accent mt-0.5">
            {localStart} – {localEnd}{viewerAbbrev && <> · {viewerAbbrev}</>} your time
          </div>
        )}
      </div>
    </div>
  );
}

function ContactRow({
  icon, label, value, href
}: {
  icon: React.ReactNode;
  label: string;
  value: string | null;
  href?: string;
}) {
  if (!value) return null;
  return (
    <div className="flex items-start gap-2 px-3 py-1.5 rounded-xl bg-white/85 border border-white/70">
      <div className="mt-0.5 shrink-0">{icon}</div>
      <div className="min-w-0 flex-1">
        <div className="text-[10px] uppercase tracking-wide font-semibold text-ink/45">
          {label}
        </div>
        {href ? (
          <a
            href={href}
            className="text-[13px] text-ink/85 hover:text-accent break-all"
          >
            {value}
          </a>
        ) : (
          <div className="text-[13px] text-ink/85 break-all">{value}</div>
        )}
      </div>
    </div>
  );
}
