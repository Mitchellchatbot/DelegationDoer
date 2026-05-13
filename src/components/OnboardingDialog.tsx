"use client";

import * as Dialog from "@radix-ui/react-dialog";
import { useEffect, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Sparkles, Camera, Cake, ChevronRight, Check, Loader2, Upload, SkipForward
} from "lucide-react";
import { toast } from "sonner";
import { Avatar } from "./Avatar";

interface MeShape {
  id: string;
  name: string;
  avatarUrl: string | null;
  birthday: string | null;
  onboardedAt: string | null;
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
export function OnboardingDialog() {
  const [me, setMe] = useState<MeShape | null>(null);
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState<"avatar" | "birthday">("avatar");
  const [avatarUrl, setAvatarUrl] = useState<string | null>(null);
  const [birthday, setBirthday] = useState<string>("");
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
      finish();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "couldn't save");
    } finally {
      setBusy(false);
    }
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
                    Two quick things so your teammates can recognize you and we
                    can celebrate your birthday.
                  </Dialog.Description>
                  <div className="mt-4 flex items-center gap-1.5">
                    <StepDot active={step === "avatar"} done={step === "birthday"} />
                    <div className="h-px flex-1 bg-slate-300/50" />
                    <StepDot active={step === "birthday"} done={false} />
                  </div>
                </div>

                <div className="p-6">
                  {step === "avatar" ? (
                    <AvatarStep
                      name={me.name}
                      avatarUrl={avatarUrl}
                      busy={busy}
                      fileRef={fileRef}
                      onFile={(f) => uploadAvatar(f)}
                    />
                  ) : (
                    <BirthdayStep
                      birthday={birthday}
                      setBirthday={setBirthday}
                    />
                  )}
                </div>

                <footer className="px-6 py-4 border-t border-slate-100 flex items-center justify-between gap-2 bg-slate-50/50">
                  <button
                    type="button"
                    onClick={() => (step === "avatar" ? goNextOrFinish() : finish())}
                    disabled={busy}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium text-ink/55 hover:text-ink hover:bg-white transition-colors disabled:opacity-60"
                  >
                    <SkipForward className="w-3.5 h-3.5" />
                    Skip {step === "avatar" ? "for now" : "this too"}
                  </button>
                  <button
                    type="button"
                    onClick={step === "avatar" ? goNextOrFinish : saveBirthday}
                    disabled={busy}
                    className="inline-flex items-center gap-1.5 px-4 py-1.5 rounded-full text-xs font-semibold text-white shadow-sm transition-all hover:-translate-y-0.5 hover:shadow-lift active:scale-95 disabled:opacity-60"
                    style={{ background: "linear-gradient(135deg, #2563EB 0%, #1e63ff 100%)" }}
                  >
                    {busy ? (
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    ) : step === "avatar" ? (
                      <ChevronRight className="w-3.5 h-3.5" />
                    ) : (
                      <Check className="w-3.5 h-3.5" />
                    )}
                    {busy
                      ? "Saving…"
                      : step === "avatar"
                        ? "Next"
                        : "Finish"}
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
