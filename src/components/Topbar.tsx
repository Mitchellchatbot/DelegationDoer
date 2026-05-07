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
    <header
      className="h-14 sticky top-3 z-10 px-5 grid grid-cols-[1fr_auto_1fr] items-center gap-3 rounded-3xl border border-white/50 backdrop-blur shadow-soft"
      style={{
        background: "linear-gradient(90deg, rgba(219,234,254,0.85) 0%, rgba(199,210,254,0.85) 50%, rgba(221,214,254,0.85) 100%)"
      }}
    >
      {/* Left placeholder so the search sits in the dead center of the bar */}
      <div />

      {/* Centered search */}
      <div className="relative w-[420px] max-w-full justify-self-center">
        <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
        <input className="input pl-9 bg-white/70" placeholder="Search tasks, projects, people…" />
      </div>

      {/* Controls — right-aligned */}
      <div className="flex items-center gap-2 justify-self-end">
        <Link
          href="/tasks/new"
          className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-full text-sm font-medium text-white shadow-sm transition-all hover:-translate-y-0.5 hover:shadow-lift"
          style={{
            background: "linear-gradient(135deg, #2563EB 0%, #7C3AED 100%)"
          }}
        >
          <Plus className="w-4 h-4" /> New task
        </Link>
        <button
          aria-label="Notifications"
          className="w-9 h-9 rounded-full inline-flex items-center justify-center bg-white/70 border border-white/60 text-ink/70 hover:text-ink hover:bg-white transition-colors"
        >
          <Bell className="w-4 h-4" />
        </button>
        <div className="flex items-center gap-2 pl-1 pr-2.5 py-1 rounded-full border border-white/60 bg-white/70">
          <Avatar name={user.name} imageUrl={user.avatarUrl} size={26} />
          <div className="text-xs leading-tight">
            <div className="text-ink font-medium">{user.name}</div>
            <div className="text-muted">{ROLE_LABELS[user.role]}</div>
          </div>
        </div>
        <button
          onClick={logout}
          title="Log out"
          className="w-9 h-9 rounded-full inline-flex items-center justify-center bg-white/70 border border-white/60 text-ink/70 hover:text-ink hover:bg-white transition-colors"
        >
          <LogOut className="w-4 h-4" />
        </button>
      </div>
    </header>
  );
}
