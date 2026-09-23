"use client";

import * as Dialog from "@radix-ui/react-dialog";
import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { MessageSquare, X, ArrowUpRight } from "lucide-react";
import { TaskConversation } from "@/components/TaskConversation";
import { cn } from "@/lib/utils";

interface UserLite { id: string; name: string; avatarUrl?: string | null; email?: string | null; role?: string }

// Team notes for one onboarding, opened from its list card as a side panel —
// read and post without leaving the list. Same thread as the workspace and
// the task page. The card is a <Link>, so every click here is stopped before
// it can bubble (portal events travel the React tree) and navigate.
export function FbOnboardingNotesButton({
  taskId, provider, count, currentUserId, users
}: {
  taskId: string;
  provider: string;
  count: number;
  currentUserId: string;
  users: UserLite[];
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const stop = (e: React.SyntheticEvent) => { e.stopPropagation(); };

  return (
    <>
      <button
        type="button"
        onClick={(e) => { e.preventDefault(); e.stopPropagation(); setOpen(true); }}
        title="Team notes"
        aria-label={`Team notes (${count})`}
        className={cn(
          "inline-flex items-center gap-1 h-7 px-1.5 rounded-lg text-xs transition-colors",
          count > 0 ? "text-accent hover:bg-accent/10" : "text-muted hover:text-accent hover:bg-accent/10"
        )}
      >
        <MessageSquare className="w-3.5 h-3.5" />
        {count > 0 && <span className="tabular-nums font-medium">{count}</span>}
      </button>

      <Dialog.Root open={open} onOpenChange={(v) => { setOpen(v); if (!v) router.refresh(); }}>
        <Dialog.Portal>
          <Dialog.Overlay onClick={stop} className="fixed inset-0 bg-black/20 backdrop-blur-[2px] z-40" />
          <Dialog.Content
            onClick={stop}
            onKeyDown={stop}
            className="fixed inset-y-0 right-0 z-50 w-[440px] max-w-[100vw] bg-white border-l border-border shadow-lift flex flex-col outline-none anim-slide-in-right"
          >
            <header className="flex items-start justify-between gap-3 px-5 pt-5 pb-3 border-b border-border/60">
              <div className="min-w-0">
                <Dialog.Title className="text-base font-semibold truncate">{provider}</Dialog.Title>
                <Dialog.Description className="text-xs text-muted mt-0.5">
                  Team notes · @mention a teammate to ping them
                </Dialog.Description>
              </div>
              <div className="flex items-center gap-1 shrink-0">
                <Link href={`/fb-onboarding/${taskId}`} className="text-xs text-accent hover:underline inline-flex items-center gap-1 px-2">
                  Open <ArrowUpRight className="w-3.5 h-3.5" />
                </Link>
                <Dialog.Close className="btn p-1.5"><X className="w-3.5 h-3.5" /></Dialog.Close>
              </div>
            </header>
            <div className="flex-1 min-h-0 overflow-y-auto px-5 py-4">
              <TaskConversation taskId={taskId} currentUserId={currentUserId} users={users} />
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </>
  );
}
