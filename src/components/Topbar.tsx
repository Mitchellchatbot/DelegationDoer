"use client";

import { Search, Bell, Plus } from "lucide-react";
import { Avatar } from "./Avatar";
import { currentUser } from "@/lib/mock-data";
import { ROLE_LABELS } from "@/lib/auth";
import Link from "next/link";

export function Topbar() {
  return (
    <header className="h-14 border-b border-border bg-bg/80 backdrop-blur sticky top-0 z-10 flex items-center gap-3 px-5">
      <div className="flex items-center gap-2 max-w-md w-full">
        <div className="relative w-full">
          <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
          <input className="input pl-9" placeholder="Search tickets, projects, people…" />
        </div>
      </div>
      <div className="ml-auto flex items-center gap-2">
        <Link href="/tickets/new" className="btn-primary">
          <Plus className="w-4 h-4" /> New ticket
        </Link>
        <button className="btn"><Bell className="w-4 h-4" /></button>
        <div className="flex items-center gap-2 px-2 py-1 rounded-xl border border-border">
          <Avatar name={currentUser.name} size={22} />
          <div className="text-xs leading-tight">
            <div className="text-ink">{currentUser.name}</div>
            <div className="text-muted">{ROLE_LABELS[currentUser.role]}</div>
          </div>
        </div>
      </div>
    </header>
  );
}
