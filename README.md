# Scaled Operations

Internal task-management & delegation tool for digital agencies. Next.js 14 (App Router) + Tailwind + Prisma/Postgres + Electron widget.

This is a **UI-first skeleton**: every route, model, and screen exists. Most data is served from `src/lib/mock-data.ts` so you can click through without provisioning a DB. Wire up Prisma + NextAuth + Anthropic when you're ready.

## What's in here

- `src/app/(main)/` — Dashboard, My Tasks (Focus), Board (Kanban DnD), Projects (RACI + Milestones), Team, Incidents, Settings
- `src/app/tickets/` — list, detail (activity log), new ticket (with Ask-AI department routing + auto-suggest assignees)
- `src/app/widget/` — Compact view loaded by the Electron shell
- `src/app/api/` — `/api/widget/my-tickets`, `/api/ai/route-department`, `/api/ai/chat`, `/api/cron/inactivity`
- `src/components/` — Sidebar, Topbar, ReportIncidentDialog, AIAssistantDrawer, TicketCard, RACITable, CapacityBar, badges, avatar
- `src/lib/` — types, mock data, capacity math, delegation scoring
- `prisma/schema.prisma` — full data model (User, Department, Ticket, Project, Milestone, RACIEntry, IncidentLog, SkillProfile, ActivityLog)
- `electron/` — main process, preload, tray, polling notifier

## Setup

```bash
npm install
npm run dev
```

Open <http://localhost:3000>. The widget is at <http://localhost:3000/widget>.

## Run the desktop widget

In another terminal (with `npm run dev` already running):

```bash
npm run electron
```

Or run both together:

```bash
npm run electron:dev
```

The widget is frameless, 380×520, always-on-top, snaps to the bottom-right of the primary display. Tray icon has Show/Hide, Open full app, Quit. It polls `/api/widget/my-tickets` every 60s and fires a system notification on any new ticket id it hasn't seen before.

To ship a real tray icon, drop a 16×16 (or 22×22 retina) `iconTemplate.png` into `electron/assets/`. Until then the tray uses an empty image.

## Install the desktop widget (macOS, end users)

The packaged macOS build is an unsigned `.dmg` (arm64 / Apple Silicon) hosted in the Supabase
`desktop-app` bucket and linked from **Settings → Desktop widget**.

1. **Download** — in Scaled Operations, go to **Settings → Desktop widget → Mac (.dmg)**.
2. **Install** — open the `.dmg` and drag **DelegationDoer** into **Applications**. <!-- the packaged app bundle is still named DelegationDoer (productName unchanged) -->
   The app bundle still installs as **DelegationDoer** until the desktop build is re-cut.
3. **First launch (unsigned)** — open it from Applications; macOS blocks it. Right-click the app →
   **Open → Open**. If still blocked: **System Settings → Privacy & Security → Open Anyway**. One-time.
4. **Sign in** — the widget keeps its own session. On the Sign-in card click **"Sign in here →"**,
   log in, and it returns to the live view.
5. **Allow notifications** — choose **Allow** when prompted. macOS delivers them via the bundled
   **terminal-notifier** helper, so they appear under that name in System Settings → Notifications.

Once running: drag the floating bubble to reposition (it snaps to edges); a new email pops a system
notification and an in-widget card — clicking either opens that thread in the browser. Click the
bubble to expand the panel (tasks, kudos, mentions, presence, clock); the menu-bar icon has
Show/Hide, Open full app, Quit.

Notes: the app is unsigned, so notifications are attributed to **terminal-notifier**, not
DelegationDoer. The build is arm64 — Intel Macs would need a universal/x64 build. To cut a new build,
run `npm run electron:build:mac` **on macOS** and upload the resulting
`dist-electron/DelegationDoer-<version>-arm64.dmg` to the `desktop-app` bucket.

## Connecting the real database

`.env.local` is pre-filled with your Supabase project ref + anon key. Replace `PASSWORD` in `DATABASE_URL` with the database password from Supabase → Project Settings → Database, then:

```bash
npx prisma generate
npx prisma db push
```

To switch the app off mocks: replace imports of `@/lib/mock-data` with Prisma queries (start with the dashboard, board, and `/api/widget/my-tickets`).

## Wiring up Anthropic via Supabase Vault

The two AI surfaces (`/api/ai/chat` and `/api/ai/route-department`) call Claude through `@anthropic-ai/sdk`. The API key is sourced from **Supabase Vault** (not `.env.local`) so it's never sitting in the repo or the local env. Setup is one-time:

### 1. Store the key in Vault

In Supabase → Project Settings → Vault, add a secret named exactly `ANTHROPIC_API_KEY`.

### 2. Create the `get_secret` RPC

Run this in the Supabase SQL editor — it lets the service role read Vault entries by name without exposing direct `vault` schema access:

```sql
create or replace function public.get_secret(secret_name text)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare v text;
begin
  select decrypted_secret into v
  from vault.decrypted_secrets
  where name = secret_name
  limit 1;
  return v;
end; $$;

revoke all on function public.get_secret(text) from public, anon, authenticated;
grant execute on function public.get_secret(text) to service_role;
```

### 3. Add the service role key to `.env.local`

```
SUPABASE_SERVICE_ROLE_KEY=<from Supabase → Project Settings → API → service_role>
```

The service role key is **server-only** — it has no `NEXT_PUBLIC_` prefix, so Next.js will refuse to expose it to the browser. It's used solely by `src/lib/anthropic-key.ts` to call the RPC above.

### Models

- Chat (`/api/ai/chat`) → `claude-sonnet-4-6` with the system prompt cached (`cache_control: ephemeral`)
- Department classifier (`/api/ai/route-department`) → `claude-haiku-4-5-20251001` with strict JSON output

To bump models, edit the `MODELS` constants in `src/lib/anthropic-client.ts`.

### Escape hatch

If `ANTHROPIC_API_KEY` is set directly in `.env.local`, that takes precedence over the Vault read. Useful for one-off testing without going through the SQL setup.

## Auth

NextAuth is in `package.json` but not wired. The current user is hard-coded as `currentUser` in `src/lib/mock-data.ts` (Henry Chen, admin). Plug in NextAuth's `getServerSession` and replace that one constant to flip on real auth.

## Inactivity cron

`/api/cron/inactivity` is the hourly job. Wire it from `vercel.json`:

```json
{ "crons": [{ "path": "/api/cron/inactivity", "schedule": "0 * * * *" }] }
```

Or run `node-cron` from a long-lived worker if self-hosting.

## Roles

Three roles defined in `prisma/schema.prisma`: `admin`, `manager`, `member`. Permission gates aren't enforced yet — the UI shows everything. Add a `requireRole(["manager","admin"])` middleware on server actions / route handlers when you wire auth.

## Known gaps (intentional, this is a skeleton)

- No persistence: form submissions log to console / mutate in-memory mock data.
- No real auth: every visitor is "Henry Chen, admin".
- AI endpoints return stubbed strings.
- Drag-and-drop on the board is local state only; doesn't persist.
- RACI export CSV button is a stub.
- Tray icon is an empty image — drop a real `iconTemplate.png` in `electron/assets/`.
