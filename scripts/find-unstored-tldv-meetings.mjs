// Find tl;dv meetings that ran through intake and spawned tasks but have
// NO client_meetings record — i.e. they generated approval tasks ("What
// needs your eye") yet show nothing in the client's "Meetings & briefs"
// timeline. This is the exact Villa Wellness failure class.
//
// For each gap it prints the meetingId, the client_name stamped on the
// spawned tasks (the most likely client to backfill against), and a ready
// curl/route hint to backfill it.
//
// Dependency-free, mirrors the other scripts/*.mjs (same .env.local loader
// + Supabase REST via the service-role key). Run where the real secrets
// live so it inspects production data:
//   railway run node scripts/find-unstored-tldv-meetings.mjs
// or locally after putting the keys in .env.local:
//   node scripts/find-unstored-tldv-meetings.mjs
//
// Reads (same var names + fallbacks as the app):
//   NEXT_PUBLIC_SUPABASE_URL
//   SUPABASE_SERVICE_ROLE_KEY | SERVICE_ROLE_KEY

import fs from "node:fs";
import path from "node:path";

// Load .env.local without a dotenv dep (same loader as the sibling scripts).
const envPath = path.resolve(process.cwd(), ".env.local");
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*"?(.*?)"?\s*$/i);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}

const URL_BASE = (process.env.NEXT_PUBLIC_SUPABASE_URL || "").replace(/\/+$/, "");
const SERVICE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SERVICE_ROLE_KEY;

if (!URL_BASE || !SERVICE_KEY) {
  console.error(
    "Missing Supabase config. Need NEXT_PUBLIC_SUPABASE_URL and " +
      "SUPABASE_SERVICE_ROLE_KEY (or SERVICE_ROLE_KEY). Run with `railway run …`."
  );
  process.exit(1);
}

async function rest(pathAndQuery) {
  const r = await fetch(`${URL_BASE}/rest/v1/${pathAndQuery}`, {
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      Accept: "application/json"
    }
  });
  const text = await r.text();
  if (!r.ok) {
    throw new Error(`GET ${pathAndQuery} → HTTP ${r.status} ${r.statusText}: ${text.slice(0, 300)}`);
  }
  return text ? JSON.parse(text) : [];
}

(async () => {
  try {
    // 1) Every logged meeting + the tasks it spawned.
    const logs = await rest(
      "tldv_intake_log?select=meeting_id,task_ids,processed_at&order=processed_at.desc&limit=500"
    );
    // 2) Meetings already stored as a brief.
    const stored = await rest("client_meetings?select=meeting_id");
    const storedSet = new Set(stored.map((m) => m.meeting_id));

    // 3) Resolve the client_name stamped on each meeting's tasks so the
    //    operator knows which client to backfill against.
    const allTaskIds = Array.from(
      new Set(logs.flatMap((l) => l.task_ids || []))
    );
    const clientByTask = new Map();
    // Chunk the id list so the URL stays a sane length.
    for (let i = 0; i < allTaskIds.length; i += 100) {
      const chunk = allTaskIds.slice(i, i + 100);
      if (chunk.length === 0) continue;
      const rows = await rest(
        `tasks?select=id,client_name&id=in.(${chunk.map(encodeURIComponent).join(",")})`
      );
      for (const t of rows) clientByTask.set(t.id, t.client_name);
    }

    const gaps = logs
      .filter((l) => (l.task_ids || []).length > 0 && !storedSet.has(l.meeting_id))
      .map((l) => {
        const names = Array.from(
          new Set((l.task_ids || []).map((id) => clientByTask.get(id)).filter(Boolean))
        );
        return {
          meetingId: l.meeting_id,
          processedAt: l.processed_at,
          taskCount: (l.task_ids || []).length,
          clientNames: names
        };
      });

    if (gaps.length === 0) {
      console.log("✅ No gaps: every tl;dv meeting with spawned tasks has a client_meetings brief.");
      process.exit(0);
    }

    console.log(`⚠️  ${gaps.length} meeting(s) spawned tasks but have NO Meetings & briefs record:\n`);
    for (const g of gaps) {
      const who = g.clientNames.length
        ? g.clientNames.join(", ")
        : "(tasks have no client_name — pass an explicit clientId)";
      console.log(`• meetingId=${g.meetingId}`);
      console.log(`    processedAt=${g.processedAt}  tasks=${g.taskCount}  client(name)=${who}`);
      console.log(
        `    backfill: POST /api/integrations/tldv/meetings/${g.meetingId}/backfill ` +
          `(body { "clientId": "<id>" } if auto-match misses)\n`
      );
    }
    console.log(
      "Backfill reuses each meeting's existing task_ids (no duplicate tasks) and is\n" +
        "idempotent on (client_id, meeting_id), so it's safe to re-run."
    );
    process.exit(0);
  } catch (err) {
    console.error("Failed:", String(err && err.message ? err.message : err));
    process.exit(1);
  }
})();
