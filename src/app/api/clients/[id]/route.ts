import { NextRequest, NextResponse } from "next/server";
import { requireCurrentUserId } from "@/lib/session";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { isValidTeamId, isSeoTeamId, TEAM_DEPARTMENT, type TeamId } from "@/lib/client-teams";
import { canEditClientTeams } from "@/lib/access";

export const dynamic = "force-dynamic";

// PATCH /api/clients/[id]
//   body: {
//     teamId?: string | null,
//     assignedUserId?: string | null,
//     assignedUserIds?: string[],
//     // Core profile — leader/head/admin can edit. Sending null/empty
//     // string clears the field. Omitted keys are left untouched.
//     name?: string,
//     website?: string | null,
//     websites?: string[],
//     contactName?: string | null,
//     contactEmails?: string[],
//     onboardingDate?: string | null, // YYYY-MM-DD
//     businessInformation?: string | null
//   }
//
// Updates validate against the shared TEAMS catalog + the users table.
// Leader / admin / head can change everything here. (Any team member
// would be too loose for an org-wide ownership field, and the contact
// fields are equally sensitive — they drive who we email and how.)
export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  try {
    const userId = await requireCurrentUserId();
    const supabase = getSupabaseAdmin();

    const { data: me } = await supabase
      .from("users")
      .select("role, is_admin, email")
      .eq("id", userId)
      .maybeSingle();
    if (!(me?.role === "leader" || me?.role === "department_head" || me?.is_admin === true)) {
      return NextResponse.json({ error: "leader/head/admin only" }, { status: 403 });
    }

    const body = await req.json().catch(() => ({}));
    const update: Record<string, unknown> = {};

    if ("teamId" in body) {
      const raw = body.teamId;
      if (raw === null || raw === "" || raw === undefined) {
        update.team_id = null;
      } else if (isValidTeamId(raw)) {
        update.team_id = raw;
      } else {
        return NextResponse.json({ error: "teamId must be a known team or null" }, { status: 400 });
      }

      // Who owns which SEO client is restricted to four people
      // (canEditClientTeams). Enforced HERE rather than only on the
      // /client-teams board, because the board's `canEdit` prop just hides
      // affordances — this route is the actual boundary, and the team picker
      // on /clients reaches the same field.
      //
      // The check fires when the change touches an SEO bucket in EITHER
      // direction: moving a client INTO an SEO team, and equally moving one
      // OUT of it (to Websites, Software, or unassigned). Only testing the
      // target would leave a hole where a head could quietly strip a client
      // off an SEO lead's plate.
      const target = update.team_id as string | null;
      const { data: cur } = await supabase
        .from("clients").select("team_id").eq("id", params.id).maybeSingle();
      const current = (cur?.team_id as string | null) ?? null;
      if (
        (isSeoTeamId(target) || isSeoTeamId(current)) &&
        target !== current &&
        !canEditClientTeams({ email: me?.email ?? null })
      ) {
        return NextResponse.json(
          { error: "Only Mitch, Sam, Tabrez and Farez can change the SEO client split." },
          { status: 403 }
        );
      }
    }

    if ("assignedUserId" in body) {
      // Legacy single-owner path — translate to the array column for
      // forward compatibility, and still write the legacy column so
      // older readers that haven't been redeployed still see ownership.
      const raw = body.assignedUserId;
      if (raw === null || raw === "" || raw === undefined) {
        update.assigned_user_id = null;
        update.assigned_user_ids = [];
      } else if (typeof raw === "string") {
        const { data: u } = await supabase
          .from("users").select("id").eq("id", raw).maybeSingle();
        if (!u) {
          return NextResponse.json({ error: "assignedUserId not a known user" }, { status: 400 });
        }
        update.assigned_user_id = raw;
        update.assigned_user_ids = [raw];
      } else {
        return NextResponse.json({ error: "assignedUserId must be a string or null" }, { status: 400 });
      }
    }

    if ("assignedUserIds" in body) {
      const raw = body.assignedUserIds;
      if (!Array.isArray(raw)) {
        return NextResponse.json({ error: "assignedUserIds must be an array of user ids" }, { status: 400 });
      }
      const ids = raw.filter((v): v is string => typeof v === "string" && v.length > 0);
      // Dedup while preserving order.
      const seen = new Set<string>();
      const unique: string[] = [];
      for (const id of ids) {
        if (seen.has(id)) continue;
        seen.add(id);
        unique.push(id);
      }
      if (unique.length > 0) {
        const { data: existing } = await supabase
          .from("users").select("id").in("id", unique);
        const existingIds = new Set((existing ?? []).map((u: { id: string }) => u.id));
        const bad = unique.filter((id) => !existingIds.has(id));
        if (bad.length > 0) {
          return NextResponse.json(
            { error: `unknown user id${bad.length > 1 ? "s" : ""}: ${bad.join(", ")}` },
            { status: 400 }
          );
        }

        // Team scoping: point people must belong to the client's team
        // department. The effective team is the one in this same patch
        // (if teamId was sent) or the client's current team otherwise.
        // No team → no department constraint (legacy / unassigned clients).
        let effectiveTeam: string | null;
        if ("team_id" in update) {
          effectiveTeam = update.team_id as string | null;
        } else {
          const { data: client } = await supabase
            .from("clients").select("team_id").eq("id", params.id).maybeSingle();
          effectiveTeam = (client?.team_id as string | null) ?? null;
        }
        if (effectiveTeam && isValidTeamId(effectiveTeam)) {
          const dept = TEAM_DEPARTMENT[effectiveTeam as TeamId];
          const { data: mems } = await supabase
            .from("department_members")
            .select("user_id")
            .eq("department_id", dept)
            .in("user_id", unique);
          const inDept = new Set((mems ?? []).map((m: { user_id: string }) => m.user_id));
          const outsiders = unique.filter((id) => !inDept.has(id));
          if (outsiders.length > 0) {
            return NextResponse.json(
              { error: `user${outsiders.length > 1 ? "s" : ""} not on the selected team: ${outsiders.join(", ")}` },
              { status: 400 }
            );
          }
        }
      }
      update.assigned_user_ids = unique;
      // Keep the legacy single column in sync — first id, or null.
      update.assigned_user_id = unique[0] ?? null;
    }

    if ("name" in body) {
      if (typeof body.name !== "string") {
        return NextResponse.json({ error: "name must be a string" }, { status: 400 });
      }
      const trimmed = body.name.trim();
      if (trimmed.length === 0) {
        return NextResponse.json({ error: "name cannot be empty" }, { status: 400 });
      }
      update.name = trimmed.slice(0, 200);
    }

    if ("website" in body) {
      const raw = body.website;
      if (raw === null || raw === "" || raw === undefined) {
        update.website = null;
      } else if (typeof raw === "string") {
        update.website = raw.trim().slice(0, 500);
      } else {
        return NextResponse.json({ error: "website must be a string or null" }, { status: 400 });
      }
    }

    if ("websites" in body) {
      if (!Array.isArray(body.websites)) {
        return NextResponse.json({ error: "websites must be an array of strings" }, { status: 400 });
      }
      const cleaned = body.websites
        .filter((v: unknown): v is string => typeof v === "string")
        .map((v: string) => v.trim().slice(0, 500))
        .filter((v: string) => v.length > 0);
      // Dedup preserving first occurrence.
      const seen = new Set<string>();
      const unique: string[] = [];
      for (const w of cleaned) {
        if (seen.has(w)) continue;
        seen.add(w);
        unique.push(w);
      }
      update.websites = unique;
    }

    if ("contactName" in body) {
      const raw = body.contactName;
      if (raw === null || raw === "" || raw === undefined) {
        update.contact_name = null;
      } else if (typeof raw === "string") {
        update.contact_name = raw.trim().slice(0, 200);
      } else {
        return NextResponse.json({ error: "contactName must be a string or null" }, { status: 400 });
      }
    }

    if ("contactEmails" in body) {
      if (!Array.isArray(body.contactEmails)) {
        return NextResponse.json({ error: "contactEmails must be an array" }, { status: 400 });
      }
      // Allow comma/whitespace-tolerant clients but normalize here so
      // the column stores clean addresses. Light validation only — we
      // don't want to block weird-but-valid TLDs.
      const cleaned: string[] = [];
      const seen = new Set<string>();
      for (const raw of body.contactEmails) {
        if (typeof raw !== "string") continue;
        const trimmed = raw.trim().toLowerCase();
        if (trimmed.length === 0) continue;
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) {
          return NextResponse.json(
            { error: `not a valid email: ${raw}` },
            { status: 400 }
          );
        }
        if (seen.has(trimmed)) continue;
        seen.add(trimmed);
        cleaned.push(trimmed);
      }
      update.contact_emails = cleaned;
    }

    if ("onboardingDate" in body) {
      const raw = body.onboardingDate;
      if (raw === null || raw === "" || raw === undefined) {
        update.onboarding_date = null;
      } else if (typeof raw === "string" && /^\d{4}-\d{2}-\d{2}$/.test(raw)) {
        update.onboarding_date = raw;
      } else {
        return NextResponse.json(
          { error: "onboardingDate must be YYYY-MM-DD or null" },
          { status: 400 }
        );
      }
    }

    if ("businessInformation" in body) {
      const raw = body.businessInformation;
      if (raw === null || raw === "" || raw === undefined) {
        update.business_information = null;
      } else if (typeof raw === "string") {
        update.business_information = raw.slice(0, 8000);
      } else {
        return NextResponse.json(
          { error: "businessInformation must be a string or null" },
          { status: 400 }
        );
      }
    }

    if ("notes" in body) {
      const raw = body.notes;
      if (raw === null || raw === "" || raw === undefined) {
        update.notes = null;
      } else if (typeof raw === "string") {
        update.notes = raw.slice(0, 8000);
      } else {
        return NextResponse.json({ error: "notes must be a string or null" }, { status: 400 });
      }
    }

    if ("updateCadence" in body) {
      const raw = body.updateCadence;
      const allowed = ["daily", "biweekly", "weekly", "monthly", "none"];
      if (typeof raw !== "string" || !allowed.includes(raw)) {
        return NextResponse.json(
          { error: `updateCadence must be one of: ${allowed.join(", ")}` },
          { status: 400 }
        );
      }
      update.update_cadence = raw;
    }

    if (Object.keys(update).length === 0) {
      return NextResponse.json({ error: "nothing to update" }, { status: 400 });
    }

    const { error } = await supabase
      .from("clients")
      .update(update)
      .eq("id", params.id);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    return NextResponse.json({
      ok: true,
      teamId: ("team_id" in update ? (update.team_id as string | null) : undefined),
      assignedUserId: ("assigned_user_id" in update ? (update.assigned_user_id as string | null) : undefined),
      assignedUserIds: ("assigned_user_ids" in update ? (update.assigned_user_ids as string[]) : undefined)
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "unknown error" },
      { status: 500 }
    );
  }
}

// DELETE /api/clients/[id] — remove a client. Leader/admin only.
export async function DELETE(_req: NextRequest, { params }: { params: { id: string } }) {
  try {
    const userId = await requireCurrentUserId();
    const supabase = getSupabaseAdmin();

    const { data: me } = await supabase
      .from("users")
      .select("role, is_admin")
      .eq("id", userId)
      .maybeSingle();
    if (!(me?.role === "leader" || me?.is_admin === true)) {
      return NextResponse.json({ error: "leader only" }, { status: 403 });
    }

    const { error } = await supabase.from("clients").delete().eq("id", params.id);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "unknown error" },
      { status: 500 }
    );
  }
}
