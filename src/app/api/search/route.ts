import { NextRequest, NextResponse } from "next/server";
import { requireCurrentUserId } from "@/lib/session";
import {
  getUserById, getAllTasks, getAllUsersLight, getDepartments
} from "@/lib/server-data";
import { getSupabaseAdmin } from "@/lib/supabase-admin";

export const dynamic = "force-dynamic";

// GET /api/search?q=… — feeds the Topbar live-search dropdown.
// Substring match across tasks (title + description), people
// (name + email), and projects (name + description). Caps each
// category at 5 results so the dropdown stays scannable; the
// /search page is the "see everything" fallback when the user
// hits Enter.
export async function GET(req: NextRequest) {
  const q = (req.nextUrl.searchParams.get("q") ?? "").trim();
  if (!q) {
    return NextResponse.json({ tasks: [], users: [], projects: [], sops: [] });
  }

  await requireCurrentUserId(); // gate behind auth; middleware already does this

  const lower = q.toLowerCase();
  const supabase = getSupabaseAdmin();

  // SOP lookup is a substring match on title + filename. Vector search
  // would be more accurate but fires on every keystroke here — for the
  // dropdown we want cheap and instant. The "Ask AI" flow on /sops is
  // where semantic search lives.
  const [tasks, users, depts, projectsRes, sopsRes] = await Promise.all([
    getAllTasks(),
    getAllUsersLight(),
    getDepartments(),
    supabase.from("projects").select("id,name,description,department_id"),
    supabase.from("sops").select("id,title,source_filename,mime_type,file_url")
  ]);

  const userById = new Map(users.map((u) => [u.id, u]));
  const deptById = new Map(depts.map((d) => [d.id, d]));

  const taskMatches = tasks
    .filter((t) =>
      `${t.title} ${t.description ?? ""}`.toLowerCase().includes(lower)
    )
    .slice(0, 5)
    .map((t) => ({
      id: t.id,
      title: t.title,
      status: t.status,
      priority: t.priority,
      assigneeName: t.assigneeId
        ? userById.get(t.assigneeId)?.name ?? null
        : null
    }));

  const userMatches = users
    .filter((u) =>
      u.name.toLowerCase().includes(lower) ||
      (u.email ?? "").toLowerCase().includes(lower)
    )
    .slice(0, 5)
    .map((u) => ({
      id: u.id,
      name: u.name,
      email: u.email,
      avatarUrl: u.avatarUrl ?? null
    }));

  const projectMatches = (projectsRes.data ?? [])
    .filter((p) => {
      const hay = `${p.name} ${p.description ?? ""}`.toLowerCase();
      return hay.includes(lower);
    })
    .slice(0, 5)
    .map((p) => ({
      id: p.id,
      name: p.name,
      departmentName: p.department_id
        ? deptById.get(p.department_id)?.name ?? null
        : null
    }));

  const sopRows = sopsRes?.data ?? [];
  const sopMatches = sopRows
    .filter((s) =>
      `${s.title ?? ""} ${s.source_filename ?? ""}`.toLowerCase().includes(lower)
    )
    .slice(0, 5)
    .map((s) => ({
      id: s.id as string,
      title: s.title as string,
      sourceFilename: s.source_filename as string,
      mimeType: s.mime_type as string,
      fileUrl: s.file_url as string
    }));

  return NextResponse.json({
    tasks: taskMatches,
    users: userMatches,
    projects: projectMatches,
    sops: sopMatches
  });
}
