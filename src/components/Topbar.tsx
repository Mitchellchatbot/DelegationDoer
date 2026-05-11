"use client";

import * as Dialog from "@radix-ui/react-dialog";
import { Search, Bell, Plus, LogOut, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { PersonAvatar } from "./PersonAvatar";
import { NewTaskForm } from "./NewTaskForm";
import { ROLE_LABELS } from "@/lib/auth";
import type { User } from "@/lib/types";
import { toast } from "sonner";
import { WorkdayRemainingPill } from "./WorkdayRemainingPill";

export function Topbar({ user }: { user: User }) {
  const [newTaskOpen, setNewTaskOpen] = useState(false);
  const router = useRouter();

  async function logout() {
    await fetch("/api/auth/logout", { method: "POST" });
    window.location.href = "/login";
  }

  return (
    <header className="h-16 sticky top-3 z-30 px-5 grid grid-cols-[1fr_auto_1fr] items-center gap-3 rounded-3xl border border-slate-200/70 bg-white/85 backdrop-blur-xl shadow-soft">
      {/* Left placeholder so the search sits in the dead center of the bar */}
      <div />

      {/* Centered search */}
      <div className="relative w-[460px] max-w-full justify-self-center">
        <Search className="w-4 h-4 absolute left-3.5 top-1/2 -translate-y-1/2 text-muted z-10" />
        <input
          className="w-full h-10 pl-10 pr-3 rounded-xl bg-slate-50 border border-slate-200 text-[15px] text-ink placeholder:text-muted focus:outline-none focus:bg-white focus:border-accent/50 focus:ring-2 focus:ring-accent/20 transition-colors"
          placeholder="Search tasks, projects, people…"
        />
      </div>

      {/* Controls — right-aligned */}
      <div className="flex items-center gap-2 justify-self-end">
        <Dialog.Root open={newTaskOpen} onOpenChange={setNewTaskOpen}>
          <Dialog.Trigger asChild>
            <button className="inline-flex items-center gap-1.5 px-4 py-2 rounded-full text-[14px] font-medium text-white bg-accent hover:bg-accent/90 shadow-sm transition-all hover:-translate-y-0.5 hover:shadow-lift">
              <Plus className="w-4 h-4" /> New task
            </button>
          </Dialog.Trigger>
          <Dialog.Portal>
            <Dialog.Overlay className="fixed inset-0 bg-black/30 backdrop-blur-sm z-40 anim-fade-in" />
            {/* Dialog.Content fills the viewport but is pointer-transparent
                except for the inner card. The flex parent + lg:pl-[264px]
                (12px outer p-3 + 240px sidebar + 12px gap) reserves the
                sidebar width on lg+ so the card centers over just the main
                content panel. On narrow viewports the padding drops to 0
                and we center on the viewport. The card itself caps at
                900px and shrinks below that to avoid overflow at any size. */}
            <Dialog.Content
              aria-describedby={undefined}
              className="fixed inset-0 z-50 outline-none pointer-events-none flex items-start justify-center pt-20 px-4 lg:pl-[264px]"
            >
              <div className="pointer-events-auto w-full max-w-[900px] max-h-[calc(100vh-6rem)] overflow-y-auto rounded-3xl border border-white/60 bg-gradient-to-br from-blue-50/90 via-white/95 to-indigo-50/85 backdrop-blur-md shadow-[0_24px_72px_-24px_rgba(60,60,120,0.45)] anim-fade-in-up">
                <div className="flex items-center justify-between px-6 py-4 border-b border-white/60 sticky top-0 bg-white/70 backdrop-blur-sm z-10">
                  <div>
                    <Dialog.Title className="text-base font-semibold">New task</Dialog.Title>
                    <Dialog.Description className="text-xs text-muted mt-0.5">
                      Stays on this page — fill it in, hit Create, get back to what you were doing.
                    </Dialog.Description>
                  </div>
                  <Dialog.Close asChild>
                    <button
                      className="w-8 h-8 rounded-full grid place-items-center text-muted hover:text-ink hover:bg-white/70 transition-colors"
                      aria-label="Close"
                    >
                      <X className="w-4 h-4" />
                    </button>
                  </Dialog.Close>
                </div>
                <div className="p-6">
                  <NewTaskForm
                    onCreated={(taskId) => {
                      setNewTaskOpen(false);
                      // Refresh the current route so any list of tasks on
                      // the page re-fetches and includes the new row. Toast
                      // is already raised by the form itself.
                      router.refresh();
                      // Give the user a one-click jump to the new task
                      // without forcing the navigation.
                      toast.message("Task created", {
                        action: {
                          label: "Open",
                          onClick: () => router.push(`/tasks/${taskId}`)
                        }
                      });
                    }}
                    onCancel={() => setNewTaskOpen(false)}
                    hideCancel
                  />
                </div>
              </div>
            </Dialog.Content>
          </Dialog.Portal>
        </Dialog.Root>

        <WorkdayRemainingPill />

        <button
          aria-label="Notifications"
          className="w-10 h-10 rounded-full inline-flex items-center justify-center bg-slate-50 border border-slate-200 text-ink/65 hover:text-ink hover:bg-slate-100 transition-colors"
        >
          <Bell className="w-4 h-4" />
        </button>
        <div className="flex items-center gap-2.5 pl-1 pr-3 py-1 rounded-full border border-slate-200 bg-slate-50">
          <PersonAvatar userId={user.id} name={user.name} imageUrl={user.avatarUrl} size={28} />
          <div className="text-[12px] leading-tight">
            <div className="text-ink font-semibold">{user.name}</div>
            <div className="text-muted">{ROLE_LABELS[user.role]}</div>
          </div>
        </div>
        <button
          onClick={logout}
          title="Log out"
          className="w-10 h-10 rounded-full inline-flex items-center justify-center bg-slate-50 border border-slate-200 text-ink/65 hover:text-ink hover:bg-slate-100 transition-colors"
        >
          <LogOut className="w-4 h-4" />
        </button>
      </div>
    </header>
  );
}
