"use client";

import * as Dialog from "@radix-ui/react-dialog";
import { useEffect, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Sparkles, Camera, Cake, ChevronRight, Check, Loader2, Upload, SkipForward,
  Briefcase, Clock, Globe, Mail, Wand2, X, Plus
} from "lucide-react";
import { toast } from "sonner";
import { Avatar } from "./Avatar";
import { detectTimezone, formatHHMMInViewerTz, viewerTzAbbrev, tzShortLabel } from "@/lib/work-hours";

interface MeShape {
  id: string;
  name: string;
  email: string;
  avatarUrl: string | null;
  birthday: string | null;
  onboardedAt: string | null;
  jobTitle: string | null;
  location: string | null;
  pronouns: string | null;
  personalEmail: string | null;
  workHoursStart: string | null;
  workHoursEnd: string | null;
  workTimezone: string | null;
}

// First-login onboarding wizard. Pops once for any user whose
// `onboarded_at` is null. Asks for a profile picture and birthday in
// two short steps. Each step is skippable; we mark the user
// onboarded when they finish OR explicitly skip the whole thing so it
// doesn't haunt them.
//
// Mounted at the (main) layout level so it shows up on whichever page
// they land on after sign-in. Lives client-side so it can do the
// file upload without round-tripping the page.
type Step = "avatar" | "birthday" | "workinfo" | "skills";

export function OnboardingDialog() {
  const [me, setMe] = useState<MeShape | null>(null);
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState<Step>("avatar");
  const [avatarUrl, setAvatarUrl] = useState<string | null>(null);
  const [birthday, setBirthday] = useState<string>("");
  // Step 3 — work info. All optional.
  const [jobTitle, setJobTitle] = useState("");
  const [location, setLocation] = useState("");
  const [pronouns, setPronouns] = useState("");
  const [personalEmail, setPersonalEmail] = useState("");
  const [workStart, setWorkStart] = useState("09:00");
  const [workEnd, setWorkEnd] = useState("17:00");
  const [workTz, setWorkTz] = useState<string>(() => detectTimezone());
  // Step 4 — skills. Free-text chips with optional preset suggestions.
  // Each chip becomes a user_skills row at manual_level=3 ("comfortable")
  // so it has real weight in the delegation engine on day one.
  const [skills, setSkills] = useState<string[]>([]);
  const [skillDraft, setSkillDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  // Load current user once. If they're already onboarded, do nothing.
  // Also handle the migration edge case: an existing user whose
  // onboarded_at is null but who clearly has been around (avatar +
  // birthday already set) shouldn't see the wizard — silently mark
  // them onboarded so the popup doesn't ambush them.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/users/me", { cache: "no-store" });
        if (!res.ok) return;
        const data = await res.json();
        if (cancelled || !data?.user) return;
        const u: MeShape = data.user;
        setMe(u);
        setAvatarUrl(u.avatarUrl);
        setBirthday(u.birthday ?? "");

        if (u.onboardedAt) return;
        if (u.avatarUrl && u.birthday) {
          // Silent backfill — don't show the wizard to people who
          // already have their profile filled in pre-migration.
          fetch("/api/users/me/onboarded", { method: "PUT" }).catch(() => {});
          return;
        }
        // Small delay so the page settles before the modal animates in.
        setTimeout(() => setOpen(true), 350);
      } catch { /* ignore */ }
    })();
    return () => { cancelled = true; };
  }, []);

  async function uploadAvatar(file: File) {
    if (!me) return;
    setBusy(true);
    try {
      const form = new FormData();
      form.append("file", file);
      form.append("taskId", `avatars/${me.id}`);
      const upRes = await fetch("/api/upload", { method: "POST", body: form });
      const upData = await upRes.json();
      if (!upRes.ok) throw new Error(upData?.error ?? `upload failed (${upRes.status})`);
      const url: string = upData.url;
      const saveRes = await fetch("/api/users/me/avatar", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url })
      });
      const saveData = await saveRes.json();
      if (!saveRes.ok) throw new Error(saveData?.error ?? `save failed (${saveRes.status})`);
      setAvatarUrl(url);
      toast.success("Picture saved");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "couldn't upload");
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  async function saveBirthday() {
    if (!birthday) {
      goNextOrFinish();
      return;
    }
    setBusy(true);
    try {
      const res = await fetch("/api/users/me/birthday", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ birthday })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? `failed (${res.status})`);
      toast.success("Birthday saved");
      goNextOrFinish();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "couldn't save");
    } finally {
      setBusy(false);
    }
  }

  async function saveWorkInfo() {
    setBusy(true);
    try {
      const trim = (s: string) => s.trim() || null;
      const patch: Record<string, unknown> = {
        jobTitle: trim(jobTitle),
        location: trim(location),
        pronouns: trim(pronouns),
        personalEmail: trim(personalEmail),
        workHoursStart: workStart,
        workHoursEnd: workEnd,
        workTimezone: workTz
      };
      // Drop the null entries — sending nulls clears any pre-existing
      // values which we don't want during onboarding.
      for (const k of Object.keys(patch)) if (patch[k] === null) delete patch[k];
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
      // Advance to the Skills step instead of finishing.
      setStep("skills");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "couldn't save");
    } finally {
      setBusy(false);
    }
  }

  async function saveSkills() {
    // Skip path — no chips, just advance.
    if (skills.length === 0 || !me) {
      finish();
      return;
    }
    setBusy(true);
    try {
      // Sequential, not parallel: /api/skills upserts (user, tag) one at
      // a time and a parallel storm hits the same unique key. 5 skills
      // takes ~500ms; tolerable for a one-time wizard.
      for (const tag of skills) {
        await fetch("/api/skills", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ userId: me.id, tag, manualLevel: 3 })
        });
      }
      toast.success(`Saved ${skills.length} skill${skills.length === 1 ? "" : "s"}`);
      finish();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "couldn't save skills");
    } finally {
      setBusy(false);
    }
  }

  function addSkill(raw: string) {
    const tag = raw.trim().toLowerCase();
    if (!tag) return;
    if (skills.includes(tag)) return;
    setSkills((cur) => [...cur, tag]);
    setSkillDraft("");
  }

  function removeSkill(tag: string) {
    setSkills((cur) => cur.filter((t) => t !== tag));
  }

  async function finish() {
    setBusy(true);
    try {
      await fetch("/api/users/me/onboarded", { method: "PUT" });
    } catch { /* ignore — worst case it pops once more */ }
    setBusy(false);
    setOpen(false);
  }

  function goNextOrFinish() {
    if (step === "avatar") setStep("birthday");
    else if (step === "birthday") setStep("workinfo");
    else if (step === "workinfo") setStep("skills");
    else finish();
  }

  if (!me) return null;

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(v) => {
        // Don't allow casual dismiss — only the Skip / Finish buttons
        // close it. Otherwise an accidental Escape would mark them
        // onboarded with nothing saved.
        if (!v && !busy) return;
        setOpen(v);
      }}
    >
      <AnimatePresence>
        {open && (
          <Dialog.Portal forceMount>
            <Dialog.Overlay asChild>
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.2 }}
                className="fixed inset-0 z-50 bg-slate-950/45 backdrop-blur-sm"
              />
            </Dialog.Overlay>
            <Dialog.Content
              aria-describedby={undefined}
              className="fixed inset-0 z-50 outline-none pointer-events-none flex items-center justify-center px-4"
            >
              <motion.div
                initial={{ opacity: 0, y: 24, scale: 0.96 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: 24, scale: 0.96 }}
                transition={{ duration: 0.24, ease: [0.2, 0.8, 0.2, 1] }}
                className="pointer-events-auto w-[480px] max-w-full rounded-3xl border border-white/60 bg-white shadow-[0_30px_60px_-20px_rgba(15,23,42,0.4)] overflow-hidden"
              >
                <div
                  className="px-6 pt-6 pb-4"
                  style={{
                    background:
                      "linear-gradient(120deg, #DBEAFE 0%, #EEF2FF 50%, #FCE7F3 100%)"
                  }}
                >
                  <div className="inline-flex items-center gap-1.5 text-[11px] uppercase tracking-wide font-semibold text-accent">
                    <Sparkles className="w-3.5 h-3.5" />
                    Welcome to DelegationDoer
                  </div>
                  <Dialog.Title className="text-xl font-bold text-ink mt-1.5">
                    Hi {me.name.split(" ")[0]} — let&apos;s set you up
                  </Dialog.Title>
                  <Dialog.Description className="text-sm text-ink/65 mt-1">
                    A few quick things so your teammates can recognize you,
                    celebrate your birthday, and know when you&apos;re around.
                  </Dialog.Description>
                  <div className="mt-4 flex items-center gap-1.5">
                    <StepDot
                      active={step === "avatar"}
                      done={step !== "avatar"}
                    />
                    <div className="h-px flex-1 bg-slate-300/50" />
                    <StepDot
                      active={step === "birthday"}
                      done={step === "workinfo" || step === "skills"}
                    />
                    <div className="h-px flex-1 bg-slate-300/50" />
                    <StepDot
                      active={step === "workinfo"}
                      done={step === "skills"}
                    />
                    <div className="h-px flex-1 bg-slate-300/50" />
                    <StepDot
                      active={step === "skills"}
                      done={false}
                    />
                  </div>
                </div>

                <div className="p-6">
                  {step === "avatar" && (
                    <AvatarStep
                      name={me.name}
                      avatarUrl={avatarUrl}
                      busy={busy}
                      fileRef={fileRef}
                      onFile={(f) => uploadAvatar(f)}
                    />
                  )}
                  {step === "birthday" && (
                    <BirthdayStep
                      birthday={birthday}
                      setBirthday={setBirthday}
                    />
                  )}
                  {step === "workinfo" && (
                    <WorkInfoStep
                      workEmail={me.email}
                      personalEmail={personalEmail}
                      setPersonalEmail={setPersonalEmail}
                      jobTitle={jobTitle}
                      setJobTitle={setJobTitle}
                      location={location}
                      setLocation={setLocation}
                      pronouns={pronouns}
                      setPronouns={setPronouns}
                      workStart={workStart}
                      setWorkStart={setWorkStart}
                      workEnd={workEnd}
                      setWorkEnd={setWorkEnd}
                      workTz={workTz}
                      setWorkTz={setWorkTz}
                    />
                  )}
                  {step === "skills" && (
                    <SkillsStep
                      skills={skills}
                      draft={skillDraft}
                      setDraft={setSkillDraft}
                      onAdd={addSkill}
                      onRemove={removeSkill}
                    />
                  )}
                </div>

                <footer className="px-6 py-4 border-t border-slate-100 flex items-center justify-between gap-2 bg-slate-50/50">
                  <button
                    type="button"
                    onClick={() => (step === "skills" ? finish() : goNextOrFinish())}
                    disabled={busy}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium text-ink/55 hover:text-ink hover:bg-white transition-colors disabled:opacity-60"
                  >
                    <SkipForward className="w-3.5 h-3.5" />
                    Skip {step === "skills" ? "this too" : "for now"}
                  </button>
                  <button
                    type="button"
                    onClick={
                      step === "avatar" ? goNextOrFinish :
                      step === "birthday" ? saveBirthday :
                      step === "workinfo" ? saveWorkInfo :
                      saveSkills
                    }
                    disabled={busy}
                    className="inline-flex items-center gap-1.5 px-4 py-1.5 rounded-full text-xs font-semibold text-white shadow-sm transition-all hover:-translate-y-0.5 hover:shadow-lift active:scale-95 disabled:opacity-60"
                    style={{ background: "linear-gradient(135deg, #0a4099 0%, #063270 100%)" }}
                  >
                    {busy ? (
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    ) : step === "skills" ? (
                      <Check className="w-3.5 h-3.5" />
                    ) : (
                      <ChevronRight className="w-3.5 h-3.5" />
                    )}
                    {busy
                      ? "Saving…"
                      : step === "skills"
                        ? "Finish"
                        : "Next"}
                  </button>
                </footer>
              </motion.div>
            </Dialog.Content>
          </Dialog.Portal>
        )}
      </AnimatePresence>
    </Dialog.Root>
  );
}

function StepDot({ active, done }: { active: boolean; done: boolean }) {
  return (
    <span
      className={
        "w-2 h-2 rounded-full transition-all " +
        (active
          ? "bg-accent ring-4 ring-accent/25"
          : done
            ? "bg-emerald-500"
            : "bg-slate-300")
      }
    />
  );
}

function AvatarStep({
  name, avatarUrl, busy, fileRef, onFile
}: {
  name: string;
  avatarUrl: string | null;
  busy: boolean;
  fileRef: React.RefObject<HTMLInputElement>;
  onFile: (f: File) => void;
}) {
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <div className="w-10 h-10 rounded-xl bg-blue-50 ring-1 ring-blue-200/60 grid place-items-center text-blue-700 shrink-0">
          <Camera className="w-5 h-5" />
        </div>
        <div>
          <div className="text-sm font-semibold">Add a profile picture</div>
          <div className="text-xs text-ink/55 mt-0.5">
            Shows up on your tasks, org chart, kudos. Helps people put a face
            to the name.
          </div>
        </div>
      </div>

      <div className="flex flex-col items-center justify-center gap-3 py-4 rounded-2xl border-2 border-dashed border-slate-200 bg-slate-50/60">
        <div className="ring-4 ring-white shadow-soft rounded-full">
          <Avatar name={name} imageUrl={avatarUrl} size={88} />
        </div>
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) onFile(f);
          }}
        />
        <button
          type="button"
          onClick={() => fileRef.current?.click()}
          disabled={busy}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium bg-white border border-slate-200 hover:border-accent/40 hover:text-accent transition-colors shadow-sm disabled:opacity-60"
        >
          {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Upload className="w-3.5 h-3.5" />}
          {avatarUrl ? "Replace picture" : "Choose a picture"}
        </button>
      </div>
    </div>
  );
}

function BirthdayStep({
  birthday, setBirthday
}: {
  birthday: string;
  setBirthday: (v: string) => void;
}) {
  // Default max = today, min = 1920 (anything earlier is suspicious).
  const todayISO = new Date().toISOString().slice(0, 10);
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <div className="w-10 h-10 rounded-xl bg-pink-50 ring-1 ring-pink-200/60 grid place-items-center text-pink-700 shrink-0">
          <Cake className="w-5 h-5" />
        </div>
        <div>
          <div className="text-sm font-semibold">When&apos;s your birthday?</div>
          <div className="text-xs text-ink/55 mt-0.5">
            We&apos;ll surface it to the team on the day so they can celebrate
            you. Year stays private — we just need it for the math.
          </div>
        </div>
      </div>

      <div className="rounded-2xl border border-slate-200/70 bg-white p-4">
        <label className="block text-[11px] uppercase tracking-wide text-ink/55 font-semibold mb-1.5">
          Birthday
        </label>
        <input
          type="date"
          value={birthday}
          onChange={(e) => setBirthday(e.target.value)}
          min="1920-01-01"
          max={todayISO}
          className="w-full px-3 py-2 rounded-xl bg-slate-50 border border-slate-200 text-sm outline-none focus:bg-white focus:ring-2 focus:ring-accent/30 focus:border-accent/40"
        />
        <div className="text-[11px] text-ink/45 mt-2">
          We&apos;ll only show the month + day publicly.
        </div>
      </div>
    </div>
  );
}

// A common IANA list. Picker is searchable so people in obscure
// zones can still find theirs; the default is auto-detected.
const COMMON_TIMEZONES = [
  "Pacific/Honolulu", "America/Anchorage", "America/Los_Angeles",
  "America/Denver", "America/Chicago", "America/New_York",
  "America/Toronto", "America/Mexico_City", "America/Sao_Paulo",
  "Atlantic/Reykjavik", "Europe/London", "Europe/Lisbon", "Europe/Madrid",
  "Europe/Paris", "Europe/Berlin", "Europe/Amsterdam", "Europe/Stockholm",
  "Europe/Athens", "Africa/Cairo", "Africa/Johannesburg",
  "Europe/Istanbul", "Europe/Moscow", "Asia/Dubai", "Asia/Tehran",
  "Asia/Karachi", "Asia/Kolkata", "Asia/Dhaka", "Asia/Bangkok",
  "Asia/Singapore", "Asia/Hong_Kong", "Asia/Shanghai", "Asia/Tokyo",
  "Asia/Seoul", "Australia/Perth", "Australia/Sydney",
  "Pacific/Auckland"
];

function WorkInfoStep({
  workEmail, personalEmail, setPersonalEmail,
  jobTitle, setJobTitle,
  location, setLocation,
  pronouns, setPronouns,
  workStart, setWorkStart,
  workEnd, setWorkEnd,
  workTz, setWorkTz
}: {
  workEmail: string;
  personalEmail: string; setPersonalEmail: (v: string) => void;
  jobTitle: string; setJobTitle: (v: string) => void;
  location: string; setLocation: (v: string) => void;
  pronouns: string; setPronouns: (v: string) => void;
  workStart: string; setWorkStart: (v: string) => void;
  workEnd: string; setWorkEnd: (v: string) => void;
  workTz: string; setWorkTz: (v: string) => void;
}) {
  // Make sure the auto-detected tz is in the dropdown even if it
  // isn't in COMMON_TIMEZONES (e.g. some obscure city).
  const tzOptions = COMMON_TIMEZONES.includes(workTz)
    ? COMMON_TIMEZONES
    : [workTz, ...COMMON_TIMEZONES];

  const startPreview = formatHHMMInViewerTz(workStart, workTz);
  const endPreview = formatHHMMInViewerTz(workEnd, workTz);
  const viewerAb = viewerTzAbbrev();

  return (
    <div className="space-y-4 max-h-[60vh] overflow-y-auto pr-1">
      <div className="flex items-center gap-3">
        <div className="w-10 h-10 rounded-xl bg-indigo-50 ring-1 ring-indigo-200/60 grid place-items-center text-indigo-700 shrink-0">
          <Briefcase className="w-5 h-5" />
        </div>
        <div>
          <div className="text-sm font-semibold">A bit about your work</div>
          <div className="text-xs text-ink/55 mt-0.5">
            Helps your team know what you do and when you&apos;re around.
            Everything is optional and editable from your profile later.
          </div>
        </div>
      </div>

      <div className="rounded-2xl border border-slate-200/70 bg-white p-4 space-y-3">
        <div>
          <label className="text-[11px] uppercase tracking-wide text-ink/55 font-semibold mb-1 inline-flex items-center gap-1">
            <Mail className="w-3 h-3" /> Work email
          </label>
          <div className="px-3 py-2 rounded-lg bg-slate-50 border border-slate-200 text-sm text-ink/75">
            {workEmail}
            <span className="text-[10px] text-ink/45 ml-2">· what you signed up with</span>
          </div>
        </div>
        <div>
          <label className="text-[11px] uppercase tracking-wide text-ink/55 font-semibold mb-1 inline-flex items-center gap-1">
            <Mail className="w-3 h-3" /> Personal email
            <span className="text-[10px] font-normal text-ink/45 ml-1">· private</span>
          </label>
          <input
            type="email"
            value={personalEmail}
            onChange={(e) => setPersonalEmail(e.target.value)}
            placeholder="you@personal.com"
            className="w-full px-3 py-2 rounded-lg bg-slate-50 border border-slate-200 text-sm outline-none focus:bg-white focus:ring-2 focus:ring-accent/30"
          />
          <div className="text-[10px] text-ink/45 mt-1">
            Only you + leaders ever see this.
          </div>
        </div>
        <div className="grid grid-cols-2 gap-2">
          <div>
            <label className="block text-[11px] uppercase tracking-wide text-ink/55 font-semibold mb-1">Job title</label>
            <input
              value={jobTitle}
              onChange={(e) => setJobTitle(e.target.value)}
              placeholder="Senior designer"
              className="w-full px-3 py-2 rounded-lg bg-slate-50 border border-slate-200 text-sm outline-none focus:bg-white focus:ring-2 focus:ring-accent/30"
            />
          </div>
          <div>
            <label className="block text-[11px] uppercase tracking-wide text-ink/55 font-semibold mb-1">Pronouns</label>
            <input
              value={pronouns}
              onChange={(e) => setPronouns(e.target.value)}
              placeholder="she/her · he/him · they/them"
              className="w-full px-3 py-2 rounded-lg bg-slate-50 border border-slate-200 text-sm outline-none focus:bg-white focus:ring-2 focus:ring-accent/30"
            />
          </div>
        </div>
        <div>
          <label className="block text-[11px] uppercase tracking-wide text-ink/55 font-semibold mb-1">Location</label>
          <input
            value={location}
            onChange={(e) => setLocation(e.target.value)}
            placeholder="Karachi · Toronto · Remote"
            className="w-full px-3 py-2 rounded-lg bg-slate-50 border border-slate-200 text-sm outline-none focus:bg-white focus:ring-2 focus:ring-accent/30"
          />
        </div>
      </div>

      <div className="rounded-2xl border border-slate-200/70 bg-white p-4 space-y-3">
        <div className="text-[11px] uppercase tracking-wide text-ink/55 font-semibold inline-flex items-center gap-1">
          <Clock className="w-3 h-3" /> Work hours
        </div>
        <div className="grid grid-cols-2 gap-2">
          <div>
            <label className="block text-[10px] uppercase tracking-wide text-ink/55 font-semibold mb-1">Start</label>
            <input
              type="time"
              value={workStart}
              onChange={(e) => setWorkStart(e.target.value)}
              className="w-full px-3 py-2 rounded-lg bg-slate-50 border border-slate-200 text-sm outline-none focus:bg-white focus:ring-2 focus:ring-accent/30"
            />
          </div>
          <div>
            <label className="block text-[10px] uppercase tracking-wide text-ink/55 font-semibold mb-1">End</label>
            <input
              type="time"
              value={workEnd}
              onChange={(e) => setWorkEnd(e.target.value)}
              className="w-full px-3 py-2 rounded-lg bg-slate-50 border border-slate-200 text-sm outline-none focus:bg-white focus:ring-2 focus:ring-accent/30"
            />
          </div>
        </div>
        <div>
          <label className="text-[10px] uppercase tracking-wide text-ink/55 font-semibold mb-1 inline-flex items-center gap-1">
            <Globe className="w-3 h-3" /> Your timezone
          </label>
          <select
            value={workTz}
            onChange={(e) => setWorkTz(e.target.value)}
            className="w-full px-3 py-2 rounded-lg bg-slate-50 border border-slate-200 text-sm outline-none focus:bg-white focus:ring-2 focus:ring-accent/30"
          >
            {tzOptions.map((tz) => (
              <option key={tz} value={tz}>
                {tz.replace(/_/g, " ")}
              </option>
            ))}
          </select>
        </div>
        {/* Live preview — show how teammates in viewer's tz will see
            these hours. Detects viewer tz from the browser so the
            preview is honest. */}
        <div className="rounded-lg bg-gradient-to-r from-blue-50 to-indigo-50 border border-blue-200/60 px-3 py-2 text-[12px]">
          <div className="text-ink/85">
            <strong>{workStart}–{workEnd}</strong> in {tzShortLabel(workTz)}{" "}
            shows up as <strong>{startPreview} – {endPreview}</strong>{" "}
            {viewerAb && <>({viewerAb})</>} to viewers in your local timezone.
          </div>
          <div className="text-[10px] text-ink/55 mt-0.5">
            Teammates in other zones see your hours converted to their own.
          </div>
        </div>
      </div>
    </div>
  );
}

// Common suggestions across the agency. Picking one adds it to chips;
// typing your own works the same way. The delegation engine reads
// these (user_skills.tag) when ranking who should get a task whose
// tags overlap with the user's skills.
const SKILL_SUGGESTIONS = [
  "web design", "frontend", "backend", "wordpress", "seo",
  "copywriting", "content writing", "video editing", "graphic design",
  "qa", "client comms", "google ads", "meta ads", "analytics",
  "email marketing", "project management", "social media"
];

function SkillsStep({
  skills, draft, setDraft, onAdd, onRemove
}: {
  skills: string[];
  draft: string;
  setDraft: (v: string) => void;
  onAdd: (raw: string) => void;
  onRemove: (tag: string) => void;
}) {
  const lowerSet = new Set(skills.map((s) => s.toLowerCase()));
  const unused = SKILL_SUGGESTIONS.filter((s) => !lowerSet.has(s));

  return (
    <div className="space-y-4 max-h-[60vh] overflow-y-auto pr-1">
      <div className="flex items-center gap-3">
        <div className="w-10 h-10 rounded-xl bg-violet-50 ring-1 ring-violet-200/60 grid place-items-center text-violet-700 shrink-0">
          <Wand2 className="w-5 h-5" />
        </div>
        <div>
          <div className="text-sm font-semibold">What are you good at?</div>
          <div className="text-xs text-ink/55 mt-0.5">
            Pick the skills you already have. We&apos;ll route the right kinds
            of tasks your way and grow your skill score as you finish them.
          </div>
        </div>
      </div>

      <div className="rounded-2xl border border-slate-200/70 bg-white p-4 space-y-3">
        <div>
          <label className="block text-[11px] uppercase tracking-wide text-ink/55 font-semibold mb-1.5">
            Your skills · {skills.length}
          </label>
          {skills.length === 0 ? (
            <div className="text-[11px] text-ink/45 italic px-1 py-2">
              No skills yet — add some below.
            </div>
          ) : (
            <div className="flex flex-wrap gap-1.5">
              {skills.map((s) => (
                <span
                  key={s}
                  className="inline-flex items-center gap-1 text-[12px] px-2 py-1 rounded-full bg-violet-100 text-violet-700 border border-violet-200/70"
                >
                  {s}
                  <button
                    type="button"
                    onClick={() => onRemove(s)}
                    className="hover:text-rose-600 transition-colors"
                    title="Remove"
                  >
                    <X className="w-3 h-3" />
                  </button>
                </span>
              ))}
            </div>
          )}
        </div>

        <div className="flex items-center gap-2">
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              // Enter or comma commits the chip — comma so people who
              // paste "seo, frontend, qa" don't end up with one weird tag.
              if (e.key === "Enter" || e.key === ",") {
                e.preventDefault();
                onAdd(draft);
              }
              if (e.key === "Backspace" && !draft && skills.length > 0) {
                // Backspace on empty input pops the last chip — Notion-style.
                onRemove(skills[skills.length - 1]);
              }
            }}
            placeholder="Type a skill and press Enter — e.g. wordpress"
            className="flex-1 px-3 py-2 rounded-lg bg-slate-50 border border-slate-200 text-sm outline-none focus:bg-white focus:ring-2 focus:ring-accent/30"
          />
          <button
            type="button"
            onClick={() => onAdd(draft)}
            disabled={!draft.trim()}
            className="inline-flex items-center gap-1 px-3 py-2 rounded-lg text-xs font-semibold bg-accent/10 text-accent hover:bg-accent/15 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <Plus className="w-3.5 h-3.5" /> Add
          </button>
        </div>
      </div>

      {unused.length > 0 && (
        <div className="rounded-2xl border border-slate-200/70 bg-slate-50/60 p-4">
          <div className="text-[10px] uppercase tracking-wide text-ink/55 font-semibold mb-2">
            Quick picks
          </div>
          <div className="flex flex-wrap gap-1.5">
            {unused.map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => onAdd(s)}
                className="text-[11px] px-2.5 py-1 rounded-full bg-white border border-slate-200 text-ink/75 hover:border-accent/40 hover:text-accent transition-colors"
              >
                + {s}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
