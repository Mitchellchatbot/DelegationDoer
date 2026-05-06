"use client";

import { Search, Bell, Plus, LogOut } from "lucide-react";
import { Avatar } from "./Avatar";
import { ROLE_LABELS } from "@/lib/auth";
import Link from "next/link";
import type { User } from "@/lib/types";

export function Topbar({ user }: { user: User }) {
  async function logout() {
    await fetch("/api/auth/logout", { method: "POST" });
    window.location.href = "/login";
  }

  return (
    <header className="h-14 border-b border-border bg-bg/80 backdrop-blur sticky top-0 z-10 flex items-center gap-3 px-5">
      <div className="flex items-center gap-2 max-w-md w-full">
        <div className="relative w-full">
          <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
          <input className="input pl-9" placeholder="Search tasks, projects, people…" />
        </div>
      </div>
      <div className="ml-auto flex items-center gap-2">
        <Link href="/tasks/new" className="btn-primary">
          <Plus className="w-4 h-4" /> New task
        </Link>
        <button className="btn"><Bell className="w-4 h-4" /></button>
        <div className="flex items-center gap-2 px-2 py-1 rounded-xl border border-border">
          <Avatar name={user.name} imageUrl={user.avatarUrl} size={22} />
          <div className="text-xs leading-tight">
            <div className="text-ink">{user.name}</div>
            <div className="text-muted">{ROLE_LABELS[user.role]}</div>
          </div>
        </div>
        <button onClick={logout} className="btn" title="Log out">
          <LogOut className="w-4 h-4" />
        </button>
      </div>
    </header>
  );
}
