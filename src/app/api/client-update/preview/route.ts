import { NextRequest, NextResponse } from "next/server";
import { requireCurrentUserId } from "@/lib/session";
import { getSupabaseAdmin } from "@/lib/supabase-admin";

export const dynamic = "force-dynamic";

// GET /api/client-update/preview?clientName=...&from=ISO&to=ISO
//
// Returns the EOD client-work entries that feed the Client Update
// composer's AI draft for the given window — what each contributor logged
// they did for this client (worked_on + results), grouped by the
// contributor's department (SEO vs Website). Surfaced as a selectable
// checklist so the operator picks exactly which work goes into the email.
//
// EOD-sourced (the client emails are drafted from the EOD forms, not from
// tasks). Lightweight twin of /api/client-update/draft — no model calls,
// just the data. Already-reported entries (reported_to_client_at set) are
// excluded so nothing gets reported twice.

interface WorkRow {
  id: string;
  user_id: string;
  note_date: string;
  worked_on: string;
  results: string | null;
}

export interface ComposerPreview {
  clientName: string;
  fromIso: string;
  toIso: string;
  entries: Array<{
    id: string;
    workedOn: string;
    results: string | null;
    noteDate: string;
    authorName: string | null;
    departmentId: string | null;
    departmentName: string | null;
  }>;
}

export async function GET(req: NextRequest) {
  try {
    await requireCurrentUserId();
    const url = new URL(req.url);
    const clientName = (url.searchParams.get("clientName") ?? "").trim();
    const fromRaw = url.searchParams.get("from") ?? "";
    const toRaw = url.searchParams.get("to") ?? "";
    if (!clientName || !fromRaw || !toRaw) {
      return NextResponse.json({ error: "clientName, from, to required" }, { status: 400 });
    }
    const from = new Date(fromRaw);
    const to = new Date(toRaw);
    if (isNaN(from.getTime()) || isNaN(to.getTime())) {
      return NextResponse.json({ error: "invalid from/to" }, { status: 400 });
    }
    const fromIso = from.toISOString();
    const toIso = to.toISOString();
    const fromDateStr = fromIso.slice(0, 10);
    const toDateStr = toIso.slice(0, 10);

    const supabase = getSupabaseAdmin();

    // EOD client-work entries for this client in the window that haven't
    // already been reported in an earlier email.
    const { data: workRes } = await supabase
      .from("eod_client_work")
      .select("id, user_id, note_date, worked_on, results")
      .eq("client_name", clientName)
      .is("reported_to_client_at", null)
      .gte("note_date", fromDateStr)
      .lte("note_date", toDateStr)
      .order("note_date", { ascending: false })
      .limit(200);
    const work = (workRes ?? []) as WorkRow[];

    // Resolve each contributor's name + department (SEO vs Website). A
    // user's department comes from department_members; we pick a single
    // department per user (the email groups by it). Names + dept names are
    // one round-trip each.
    const userIds = Array.from(new Set(work.map((w) => w.user_id)));
    const userById = new Map<string, string>();
    const deptByUser = new Map<string, string>(); // user_id -> department_id
    const deptNameById = new Map<string, string>();

    if (userIds.length > 0) {
      const [usersRes, membersRes] = await Promise.all([
        supabase.from("users").select("id, name").in("id", userIds),
        supabase.from("department_members").select("user_id, department_id").in("user_id", userIds)
      ]);
      for (const u of ((usersRes.data ?? []) as { id: string; name: string }[])) {
        userById.set(u.id, u.name);
      }
      // Prefer the client-facing departments (SEO, then Website) when a
      // user belongs to several; otherwise take their first membership.
      const PREFER = ["dep_seo", "dep_web"];
      const membersByUser = new Map<string, string[]>();
      for (const m of ((membersRes.data ?? []) as { user_id: string; department_id: string }[])) {
        const arr = membersByUser.get(m.user_id) ?? [];
        arr.push(m.department_id);
        membersByUser.set(m.user_id, arr);
      }
      for (const [uid, depts] of membersByUser) {
        const pick = PREFER.find((p) => depts.includes(p)) ?? depts[0];
        if (pick) deptByUser.set(uid, pick);
      }
      const deptIds = Array.from(new Set([...deptByUser.values()]));
      if (deptIds.length > 0) {
        const { data: deptRows } = await supabase.from("departments").select("id, name").in("id", deptIds);
        for (const d of ((deptRows ?? []) as { id: string; name: string }[])) {
          deptNameById.set(d.id, d.name);
        }
      }
    }

    const out: ComposerPreview = {
      clientName,
      fromIso,
      toIso,
      entries: work.map((w) => {
        const deptId = deptByUser.get(w.user_id) ?? null;
        return {
          id: w.id,
          workedOn: w.worked_on,
          results: w.results,
          noteDate: w.note_date,
          authorName: userById.get(w.user_id) ?? null,
          departmentId: deptId,
          departmentName: deptId ? (deptNameById.get(deptId) ?? null) : null
        };
      })
    };

    return NextResponse.json(out);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "unknown error" },
      { status: 500 }
    );
  }
}
