# Executive AI Assistant: operations runbook

This is the runbook for the Executive AI Assistant inside DelegationDoer (DD): what it is, where it runs, how to set it
up, switch it off, rotate its secrets, watch it and take it apart again. It covers phases P0 to P9 as merged.

Writing rules for this file (the runbook test, `src/lib/exec/__tests__/runbook.test.ts`, checks some of them): plain
English; no content examples (no names, subjects or message text); every SQL statement is read-only unless its section
says otherwise; never a select-star; never a column that holds sealed secrets (the `*_enc` columns).

---

## 0. Scope and the never-list

The assistant's non-negotiables. Every change is judged against them.

- **Owner only.** It is Mitchell's (mitchell@scaledai.org) and nobody else's, enforced on the server. The session must
  be a strong sign-in: a password sign-in, with no one-time sign-in link anywhere in its record (the step-up, §4 P9).
  Everyone else, and every sign-in link session on his account, gets a 404 on the assistant's pages and APIs.
- **Mail is pinned to his account** (`exec_principals.mail_account_ids`).
- **Email is never sent automatically.** Only his confirmed click on the exact saved draft sends it.
- **Nothing is posted as Mitchell** except a check-in he clicks himself.
- **Only real DD records are used.** Recommendations and AI readings are labelled as such.
- **The never-watch list is mandatory and fails closed.** The FB lead Slack channels carry addiction-treatment intake
  data (42 CFR Part 2): they are never read, stored, logged or sent anywhere.
- **Restricted senders follow decision R** (policy `hidden`): the page and DD chat show counts only.
- **No finance** in the brief or on any Slack surface.
- **Never log content, names or credentials.** Logs, ops alerts, audit rows, job payloads and results carry ids,
  enums, counts and key ids only.
- **Every exec table:** row level security on, no policies, service_role only (§16 checks it).

Never:

- run `next dev` or `next start` with the production env (it boots the production in-process loops about 50 s later);
- select from `missive.email_accounts` with a star, or select any `*_enc` column;
- hand-delete Slack rows (use the RPCs in §8);
- press Slack's "Reinstall to Workspace"; enable public distribution or token rotation for the Slack app;
- roll the clone below CL0 while EA tokens exist;
- put an exec secret in a `NEXT_PUBLIC_` variable;
- run `node scripts/exec-purge-all.mjs --apply` while Slack is connected;
- give the second Railway service (energetic-surprise) `EXEC_ENABLED` or any exec variable (§2, the two-service rule).

---

## 1. Architecture map

### 1.1 Surfaces

- **Pages** under `src/app/(main)/executive`: Overview, Attention, Brief, Chat, Email (thread, `drafts/new`,
  `drafts/[id]`), Projects (and `[id]`), Settings, Slack, Team. Each page's first step is `requireExecPrincipalForPage`
  (owner, enabled principal, strong sign-in).
- **27 API routes** under `/api/exec`: attention (list, item, feedback), briefs (latest, regenerate, settings), chat
  (SSE), conversations, drafts (create, item, save, send, review, regenerate, resolve, outlook-opened), email assess,
  settings and voice-reset, slack (channel, channel links, digests, disconnect, reading/stop, watch-mode) and task
  proposals (confirm, dismiss). Every one gates first, the same way.
- **Slack:** `/api/integrations/exec-slack/start` and `/callback` need his strong session on the canonical host
  (`operations.scaledai.org`); `/events` and `/interactions` are public but Slack-signature checked (v0 HMAC over the raw
  body, 300 s window, constant-time compare).
- **`/api/cron/exec-tick`:** `CRON_SECRET` in the Authorization header only.
- **Legacy hooks:** `daily-briefing-runner.ts` (the brief ownership gate), DD's `/api/slack/interactions` (legacy
  check-in buttons answer "expired" once the assistant's brief supersedes them), the Ask AI drawer's routing
  (`ask_ai_uses_exec`), `/api/brain/inbox/draft` (legacy, owner-only).

### 1.2 Code

`src/lib/exec`: `access.ts` (the gate), `principal.ts`, `audit.ts` (insert before
acting, fail closed), `crypto.ts`, `llm/*` (Opus 5.5 for chat, drafts, the brief and check-ins; Haiku 5.5 for triage,
digests, DD text and voice), `jobs.ts`, `scheduler.ts`, `runtime.ts`, `sources/*`, `triage/*`, `producers/*`,
`attention*`, `agent/*`, `drafts*`, `send.ts` (the only reader of the send credential), `voice.ts`, `slack-*`,
`brief-*`, `handlers/*` (one per job kind), `ops.ts`, `dd-bot.ts`. The UI is `src/components/exec/**`. The in-process
loops and the shutdown drain are `src/lib/cron-bootstrap.ts`, started by `src/instrumentation.ts`.

### 1.3 Migrations, applied by hand in this order

Each file ends with a verify grid that must be all `ok`. Code first is safe in every phase.

1. `20261104000000_p0_lock_down_anon_access` (P0)
2. `20261104100000_exec_foundation` (P2a): principals, settings, jobs, audit log, access log, AI usage, sync state
3. `20261104200000_exec_attention` (P2b): attention items
4. `20261105100000_exec_email` (P3): email threads, commitments, email signals
5. `20261105200000_exec_drafts` (P4): drafts, voice profile
6. `20261106100000_exec_dashboard` (P5a): DD text items and signals, attention feedback; then, optionally and on its
   own, `20261106100500_optional_activity_logs_created_at_idx`
7. `20261107100000_exec_chat` (P5b): conversations, messages, task proposals
8. `20261108100000_exec_slack` (P6): Slack installations, events, posts, OAuth states, chat feedback
9. `20261109100000_exec_slack_reading` (P7a): Slack channels, threads, messages, items and the reading bookkeeping
10. `20261110100000_exec_slack_intel` (P7b): channel links, message links, digests
11. `20261111100000_exec_brief` (P8): briefs, check-ins, mentions
12. `20261111200000_exec_brief_dm_refs` (P9): three new `_v2` brief functions, nothing else. The code works before it
    is applied (it falls back to P8's functions and raises one `exec-brief-v2-missing` alert).
13. Later: `20261112100000_exec_slack_leads_replies` (P10).

After re-applying any earlier file by hand, re-run every later file's grid (later files version their functions, so a
re-run of an earlier file can't revert them), then the whole-surface grid (§16).

### 1.4 Background work

- **Railway "Delegation Doer"** runs DD's in-process loops (`cron-bootstrap.ts`), two of them the assistant's:
  - `exec-worker`, every 10 s (first run 40 s after boot): claims due jobs into free slots of two lanes (interactive 4,
    bulk 2), 120 s leases kept alive by heartbeats, a fenced finish, backoff 30 s x 2^n up to 1 h, 6 attempts by
    default. Since P9 it claims only the kinds this process can run (§2, the two-service rule).
  - `exec-scheduler`, every 60 s (first run 65 s after boot): requeues expired leases, enqueues the system work, then
    every enabled principal's due work under time-bucket dedupe keys. Since P9 a key this process already enqueued is
    not upserted again until it changes (re-checked against the table once an hour).
- **GitHub Action `exec-tick.yml`:** hourly at :07 from 10:07 to 17:07 UTC, POSTs `/api/cron/exec-tick` (3 tries), so
  the brief and its watchdog run on time even if the container slept.
- An enqueue of interactive work kicks the interactive lane in-process at once.
- **On SIGTERM (P9):** the worker stops claiming, the scheduler idles and every in-process loop stops scheduling ticks;
  with `NEXT_MANUAL_SIG_HANDLE=true` the process waits for the assistant's in-flight job runs before it exits (§5).

### 1.5 External systems

- Supabase (service role only).
- missiveclone: CL1 read signals; CL2 drafts, send by id, scoped tokens.
- The Slack app "ScaledAI Executive Assistant": a bot and his read-only user token; manifest
  `docs/exec-slack-manifest.json`; every URL on https://operations.scaledai.org.
- The DD bot (`SLACK_BOT_TOKEN`): ops alerts, the watchdog's mini-brief, identity checks.
- Anthropic (the models).
- energetic-surprise, the second Railway service: no domain; it must not run the assistant (§2).

### 1.6 Retention

| What | How long | Who deletes |
|---|---|---|
| Finished jobs | 14 days | system purge (03:30 UTC) |
| Access log (sign-ins, refused step-ups) | 90 days | system purge |
| Audit log, AI usage | 400 days | system purge |
| Resolved attention items | 90 days after last seen | system purge |
| Attention feedback | 365 days | system purge |
| Email rows | activity + `retention_days_email` (180) | system purge |
| Drafts | content 30 days after a terminal state; rows `retention_days_email` after it | system purge |
| DD text | `retention_days_ddtext` (90), plus a 14-day attention window; all of it within 10 min of turning it off | DD text job |
| Chat | `retention_days_chat` (90) | system purge |
| Slack events | 25 h | system purge |
| Slack items, messages, threads, digests | `retention_days_slack` (90) | system purge |
| Slack deleted markers / purge log / left channels | 26 h / 7 days / 30 days | system purge |
| Briefs | content 30 days, row 180 days; since P9 the ref arrays (ids only) stay while the brief DM can still exist (at most 740 days), so later deletions still reach the DM | system purge |
| Check-ins / mentions | 30 days / 90 days | system purge |
| Bot DMs in Slack | `retention_days_chat`; at most 80 deletes per installation per run | `exec.slack-dm-purge`, system work at 04:10 UTC since P9 (a disabled principal's DMs too) |
| DD-bot mini-brief DMs | `retention_days_chat` as it was at post time, at most 50 a day | system purge |

---

## 2. Environment variables

All on Railway "Delegation Doer" unless noted.

| Variable | Meaning |
|---|---|
| `EXEC_ENABLED` | Only `true` turns the assistant on. Off: pages and APIs 404, loops report "disabled", exec-tick skips, the legacy brief and legacy Ask AI resume, purges stop. Slack: since P9 (lead decision L2) deletion-type events (a delete, a thread parent's tombstone, channel deleted or left, app uninstalled, tokens revoked) are still applied; everything else is dropped with a 200. |
| `EXEC_TOKEN_KEY` | 32 random bytes in base64 (`openssl rand -base64 32`). Seals the Slack tokens; derives the OAuth-state and check-in button MAC keys. |
| `EXEC_TOKEN_KEY_PREVIOUS` | Set only during a rotation (§10). |
| `EXEC_OPS_SLACK_CHANNEL` | The ops channel id (the DD bot must be a member). Unset: alerts go to the server log only. |
| `EXEC_WORKER_INTERNAL_CRON`, `EXEC_SCHEDULER_INTERNAL_CRON` | `false` opts a process out of the exec loops. With the worker off, the mail bus hook isn't installed, so email arrives only through reconcile (within 5 min). |
| `EXEC_SLACK_CLIENT_ID`, `EXEC_SLACK_CLIENT_SECRET`, `EXEC_SLACK_SIGNING_SECRET`, `EXEC_SLACK_TEAM_ID` (T...), `EXEC_SLACK_APP_ID` (A...) | All five, or Slack is "not configured". |
| `MISSIVE_API_URL`, `MISSIVE_API_TOKEN` | The clone's URL and the legacy token (P3's reads). |
| `MISSIVE_EA_TOKEN` | The EA draft token (scopes read and draft; his pinned account). Since P9 only a process holding it claims `exec.draft-generate` and `exec.draft-reconcile`, and a process without it never overwrites the shared readiness verdict. |
| `MISSIVE_EA_SEND_TOKEN` | The EA send token (scope send); read only by `send.ts`, on every send. |
| `SLACK_BOT_TOKEN`, `SLACK_OUTBOUND_CHANNEL` | DD's existing bot; load-bearing for the identity checks and the watchdog's mini-brief. |
| `ANTHROPIC_API_KEY` | The model key. |
| `CRON_SECRET` | On Railway and as a GitHub secret (exec-tick.yml, daily-briefing.yml). |
| `NEXT_PUBLIC_APP_URL` | The link origin (`https://operations.scaledai.org`). |
| `NEXT_MANUAL_SIG_HANDLE` | P9, optional (lead decision L5). Set it to `true` to turn the graceful drain on: Next 14.2 then registers no signal handler of its own, and DD's SIGTERM handler waits for the assistant's in-flight job runs before it exits. Next drops its own handler for ANY non-empty value; DD's handler then exits at once for a value other than `true`, so never set it to `1` or `yes` by mistake. Unset: Next's handler closes the server and exits, as before. |
| `RAILWAY_DEPLOYMENT_DRAINING_SECONDS` | P9, set by you on Railway, read by DD. Railway's gap between SIGTERM and SIGKILL. Set `120`; the drain then waits at most min(120 x 1000 - 5000, 110000) ms = 110 s. Unset (Railway's default 0): no wait. |

On GitHub: the variable `EXEC_TICK_URL` = `https://operations.scaledai.org/api/cron/exec-tick` and the secret
`CRON_SECRET`. On the clone: `EA_SEND_ENABLED` = his account id; `JWT_SECRET` (rotating it kills every clone token).

Not used: any `SLACK_USER_TOKEN` fallback; any Slack bot token of the assistant in env. `VERCEL=1` makes every
in-process loop stand down.

**The two-service rule (lead decision L1).** The assistant runs only on "Delegation Doer". energetic-surprise keeps
`EXEC_ENABLED` unset and gets none of the exec variables (this supersedes the P6, P7b and P8 instructions to set the
Slack variables on both services). Check it in the Railway dashboard after every env change. If energetic-surprise ever
needs the app env, it must also get `EXEC_WORKER_INTERNAL_CRON=false` and `EXEC_SCHEDULER_INTERNAL_CRON=false`. P9 makes
a violation less harmful (a process without `MISSIVE_EA_TOKEN` leaves the draft kinds queued for the one that has it)
but not harmless: every other kind would still be claimed there.

---

## 3. Switches and settings

`exec_settings` column = its default, and where it is set.

- Morning brief (Settings, Morning brief; his strong session; at most 30 changes per 10 min):
  - `brief_enabled` = false; `brief_local_time` = 08:00;
  - `brief_timezone` = null, falling back to his work timezone, then America/New_York (it also moves the cost-cap day);
  - `supersede_legacy_brief` = false ("Send the brief to Slack instead of the 8am DD brief");
  - `checkins_enabled` = true (check-ins happen only for a brief that was sent to his DM).
- `restricted_policy` = `hidden` (`dd_only` is accepted but not built and is treated as hidden). SQL only.
- `watch_mode` = `member_only` (`active_public` is opt-in, in the channel picker). Per channel: `watch_state`
  (watched, muted or unwatched; a finance channel needs an explicit Watch confirm) and client or project tags.
- Retention: `retention_days_slack` = 90 (Settings 7-365); `retention_days_email` = 180 (7-730);
  `retention_days_chat` = 90 (7-730; it also governs the Slack DM purge); `retention_days_ddtext` = 90 (7-730).
- `daily_cost_cap_usd` = 15 ($1-$100 in Settings; 0 by SQL turns all AI off).
- `email_enabled` = false (P3 scripts: pin, then enable). `drafts_enabled` = false and `send_enabled` = false (P4
  scripts). `voice_enabled` = true ("Learn my writing style").
- `ddtext_enabled` = false (Settings, or the disable script), with a $1 a day ceiling.
- `chat_enabled` = false; `ask_ai_uses_exec` = false; `chat_daily_cap_usd` = 9 (at most 0.6 x the daily cap).
- `slack_reading_enabled` = false (the Read Slack switch; its confirm attests the checklist); `slack_daily_cap_usd` = 2
  (at most 0.2 x the daily cap).
- `exec_principals.enabled` = true (seeded). `mail_account_ids`: set by the P3 pin script. Slack ids: bound at OAuth.
- Constants: chat 30 requests per 10 min and 2 answers at once; brief regenerate 6 an hour, dry run 3 an hour, a 240 s
  build, the watchdog at +45 min, the delivery cutoff at max(12:00, brief time + 4 h); check-ins at most 3 a brief,
  valid 48 h; the per-process spend memo trusts a spend read for 30 s (P9, §11).

---

## 4. Setup order

Code first is safe in every phase. Each phase's steps in order, with its acceptance checks.

- **P0:** apply the P0 migration. Set `CRON_SECRET` on Railway and in GitHub. Sign Mitchell out everywhere, and again
  right before `EXEC_ENABLED=true`.
- **P2a:** apply the foundation migration. Set `EXEC_ENABLED=false`, `EXEC_TOKEN_KEY` and `EXEC_OPS_SLACK_CHANNEL`. Run
  `scripts/exec-llm-spike.cjs` locally with an API key: it must pass Haiku structured output, the streamed Opus tool loop
  with signatures, and the text replay.
- **P2b:** apply the migration; the owner sidebar item appears.
- **P3:** deploy missiveclone CL1; review his Outlook rules and folders (decision R); apply the migration, run the pin
  script, then the enable script. Acceptance: a test email is triaged within about a minute and its attention item
  appears by the next minute.
- **P4:** deploy CL2 (ready, send off) and run its live tests; mint both EA tokens for his pinned account and set them
  on "Delegation Doer" only; apply the migration and run the enable-drafts script. Live save test: the draft appears in
  Outlook Drafts with inline images, one signature and the right quoted zone; discarding it moves it to Deleted Items.
  Then set the clone's `EA_SEND_ENABLED`, restart the clone, run the enable-send script. First send: an internal reply
  at a time he chooses; check Sent Items, the feed row, the draft reaching `sent`, a finished audit row and exactly one
  delivery.
- **P5a:** apply the migration (and the optional index on its own); update the employee notice; Settings, DD text on.
  Acceptance: snooze, dismiss with undo, vote; spot-check Team; a test mention produces an item within about 10 min;
  turning it off deletes within about 10 min.
- **P5b:** apply the migration; Settings, Chat on; optionally "Use the assistant for Ask AI". Check the SSE stream
  through operations.scaledai.org; run `scripts/exec-chat-eval.mjs` on a test key.
- **P6:** create the Slack app from the manifest (never distribute it; minimum collaborators; Delayed Events on); set
  the five `EXEC_SLACK_*` variables on "Delegation Doer" only (L1); apply the migration; deploy; verify the Request URL;
  pre-approve the app if "Require app approval" is on. Mitchell: Slack two-factor, sign out other sessions, then Connect
  on the canonical host. Live checks; notice, privacy page, DPA.
- **P7a:** legal sign-off first (42 CFR Part 2, the BAA and DPA). Paste the manifest, do not press Reinstall; re-check
  Delayed Events; pre-approve the scopes. Apply the migration, re-run P6's grid, deploy. Confirm `SLACK_BOT_TOKEN` and
  `SLACK_OUTBOUND_CHANNEL`. Mitchell clicks "Allow reading"; discovery runs. Pre-enable checks: a test lead channel in
  both naming styles is denied and stores only its marker (a select of the channel's class and deny reason, and a count
  of its stored messages, which must be 0). Review the picker; turn Read Slack on. Post-enable: deletes arrive hidden.
  Watch the "Slack reading" row for a day.
- **P7b:** Read Slack off unless the P7b checklist is signed; apply the migration; deploy; sign off the checklist; Read
  Slack on; tag 3-5 client channels and one project. Digests appear after 00:30; check the Slack budget after the
  first plan run.
- **P8:** apply the migration. Set `EXEC_TICK_URL` and `CRON_SECRET`; a workflow_dispatch of exec-tick must answer 200.
  Turn "Build a morning brief" on (page-only at first). Confirm the DD bot is in the ops channel and the check-in token
  reads "Yours". Employee notice for check-ins. After the P8 checklist: turn supersede on. Live checks: a check-in posts
  as Mitchell, a double click posts once, the brief carries its metadata, a forced timeout is recovered, the mini-brief
  arrives when the bot is disconnected. Retire daily-briefing.yml after a week.
- **P9 (this release):**
  1. Merge and deploy.
  2. Apply `20261111200000_exec_brief_dm_refs.sql` after P8's; its grid must be all ok. Re-run P8's grid. Run the
     whole-surface grid (§16).
  3. Check energetic-surprise has no `EXEC_ENABLED` and no exec variable (L1).
  4. Check: `/executive` opens for him after a password sign-in; a fresh sign-in link session on his account gets a 404
     there and an `exec-step-up-refused:<date>` alert; Settings, recent access shows the refused row. If no alert
     appears (one per key per 15 min per process), the refused row in Settings, recent access is the proof.
  5. Optional, in a quiet hour (L5): `NEXT_MANUAL_SIG_HANDLE=true` and `RAILWAY_DEPLOYMENT_DRAINING_SECONDS=120` on
     "Delegation Doer"; then a deploy during a Slack question lets the answer finish.

  **The authenticator was removed on 2026-11-10.** As first merged, P9 also asked for the 6-digit code of his
  authenticator and pinned his factors in `EXEC_OWNER_MFA_FACTOR_IDS`. Now the step-up is the password sign-in alone
  (§0), whatever the session's aal: nothing reads his factors any more, `/login` has no code step, DD Settings has no
  "Two-step sign-in" section, the alerts `exec-owner-unpinned-factor:` and `exec-owner-mfa-misconfigured` are gone, and
  his sign-ins no longer sign the team's link sessions out. The gap this re-opens is in §14. To do once, after the
  deploy:

  - If `EXEC_OWNER_MFA_FACTOR_IDS` was set on Railway, delete it (it's ignored now).
  - Only if Mitchell already added an authenticator to his account: remove that factor in Supabase (Authentication,
    Users, his user; or the admin API `auth.admin.mfa.deleteFactor`), so nothing is left half set up. With a factor on
    the account, Supabase can ask for a code in flows DD no longer has a screen for (for example changing his password).
  - Re-run step 4.

  A rollback to a deployment from before this change brings the code requirement back, and the assistant's pages and
  APIs then 404 for him too (his brief and his Slack DM keep working).

---

## 5. Deploy and rollback

- A merge to main auto-deploys both Railway services. A ref in the GitHub deployments list only means a deploy
  STARTED: read its statuses. Only "Delegation Doer" serves traffic.
- Migrations are additive and have no down scripts. Older code ignores newer objects (the `_v2` functions).
- **Shutdown during a deploy (P9).** Railway sends SIGTERM to the old deployment once the new one is up, then SIGKILL
  after `RAILWAY_DEPLOYMENT_DRAINING_SECONDS`. On SIGTERM DD's handler always: sets the exec draining flag (no new job is
  claimed, a kick starts nothing, the exec scheduler idles), and stops every in-process loop from starting a tick (their
  heartbeats show "shutting down (SIGTERM)"). Then:
  - `NEXT_MANUAL_SIG_HANDLE` unset: Next closes the server and exits as before; runs still in flight die with the
    process (inert, the default).
  - `NEXT_MANUAL_SIG_HANDLE=true`: the handler waits until no exec run is in flight, at most
    min(draining seconds x 1000 - 5000, 110000) ms, then exits 0. A run that doesn't finish in time is cut; one-attempt
    kinds (a Slack reply, a button action, the brief, its delivery, a check-in) then end dead after their lease, as
    before P9. The HTTP server is not drained: a web request still open when the handler exits (a long chat answer) is
    cut, as it would be at SIGKILL.
  - Any other non-empty value: Next registered no handler, so DD's exits at once (no wait).
- Rollback: flip a switch (§6), or redeploy the previous Railway deployment, or revert the PR. Before rolling back
  below P8 with supersede on, expect the legacy brief to resume. **Rolling back below P9 re-opens the step-up bypass**
  (a sign-in link session could enrol its own authenticator and use the assistant): don't, unless the assistant is
  switched off (§6 B). A rollback past the 2026-11-10 step-up change also closes the assistant's pages and APIs to him
  (§4 P9).
- Clone: CL0 or CL1 is safe; below CL0 never, unless `JWT_SECRET` is rotated and every token re-minted.

---

## 6. Turning things off (fastest first)

- **A) Soft off, instant, no deploy:**
  `update exec_principals set enabled = false where user_id = '<his DD user id>';` (a write, on purpose). Routes 404,
  his queued jobs are cancelled when they run, the legacy brief resumes. Slack deletes still apply, the system purge
  keeps running and, since P9, so does the Slack DM purge.
- **B) Hard off:** `EXEC_ENABLED=false` and redeploy. Everything stops, purges included; since P9 deletion-type Slack
  events are still applied. Use B for an incident in exec code.
- **C) Per feature:** send off, or unset the clone's `EA_SEND_ENABLED` (the strongest send kill); drafts; email; DD
  text; chat; Ask AI routing; Read Slack off (pause), Stop reading (revoke and purge within 24 h) or Disconnect (both
  tokens); brief off, supersede off, check-ins off; `daily_cost_cap_usd` = 0 (all AI off).
- **D) Decommission:** §15.

---

## 7. Scheduled and event-driven jobs

Every job is a row in `exec_jobs`, claimed by `exec-worker`. "Gate" is the settings switch (or check) that must hold for
the scheduler to enqueue it; the scheduler key dedupes, so a missed tick or two processes never double-enqueue.

System work (no principal; keyed `<kind>:system:...`; runs whether or not a principal is enabled, while
`EXEC_ENABLED=true`):

| Kind | Cadence | Notes |
|---|---|---|
| `exec.purge` | daily 03:30 UTC, 3 attempts, 300 s | every retention in §1.6; since P9 also re-seals Slack tokens still under `EXEC_TOKEN_KEY_PREVIOUS` (§10) and keeps brief refs while the DM may exist |
| `exec.ops-watch` | every 15 min | lease-reaper alerts (`job-reaped:`) |
| `exec.slack-dm-purge` | daily 04:10 UTC, 2 attempts (system work since P9) | every active installation, a disabled principal's included, with that principal's `retention_days_chat` |

Per principal (in his zone; the brief's works in the brief zone):

| Kind | Cadence | Gate |
|---|---|---|
| `exec.dd-attention` | every 10 min | none |
| `exec.email-reconcile` | every 5 min | email on and installed |
| `exec.email-attention` | every 10 min | none (off resolves, not installed skips) |
| `exec.draft-reconcile` | every 5 min | drafts installed and a draft row due; only a process with `MISSIVE_EA_TOKEN` claims it (P9) |
| `exec.voice-refresh` | Sundays 04:00 | drafts, voice and email on and installed |
| `exec.ddtext-triage` | every 10 min | none (turned off, it deletes its own rows) |
| `exec.slack-sweep` | every 5 min | an active installation |
| `exec.slack-discover` | daily 05:10 | Slack reading installed |
| `exec.slack-read-sweep` | every 30 min in his work window (08:00-19:00), every 3 h otherwise | Read Slack on |
| `exec.slack-probe` | every 15 min | Read Slack on and watch mode active_public |
| `exec.slack-attention` | every 10 min | Slack reading installed |
| `exec.slack-read-recheck` | daily 04:20 | Slack reading installed |
| `exec.slack-correlate` | every 15 min | Read Slack on |
| `exec.slack-digest-plan` | daily 00:30 | Read Slack on |
| `exec.slack-intel-sweep` | every 10 min | Slack reading installed (it deletes, so it runs with reading off) |
| `exec.brief` | daily at `brief_local_time`, one attempt; its companion `exec.brief-fallback` (the watchdog) at +45 min | brief on |
| `exec.brief-prep` | brief time - 15 min | brief on |
| `exec.brief-sweep` | every 5 min | none (skips cheaply when not installed) |
| `exec.brief-health` | daily 06:00 | brief and check-ins on |

Event-driven kinds (enqueued by a route, a Slack event, a button or another job): `exec.email-triage`,
`exec.draft-generate` (only a process with `MISSIVE_EA_TOKEN` claims it, P9), `exec.slack-reply`, `exec.slack-action`,
`exec.slack-card`, `exec.slack-home`, `exec.slack-uninstall`, `exec.slack-classify`, `exec.slack-triage`,
`exec.slack-rekey`, `exec.slack-user-check`, `exec.slack-read-purge`, `exec.slack-digest`, `exec.brief-deliver`,
`exec.checkin-send`, `exec.checkin-rewrite`, `exec.access-alert`.

---

## 8. A person's Slack deletion request

1. His principal id: `select p.id from exec_principals p join users u on u.id = p.user_id where lower(u.email) =
   'mitchell@scaledai.org';`
2. The person's Slack member id (their profile, Copy member ID).
3. `select public.exec_slack_purge_author('<principal id>', '<member id>');` (a write, on purpose). It records the
   opt-out first, removes every IM with them, their stored messages and every stored row of threads holding them, and
   writes purge-log rows.
4. If they name a group DM or a channel: `select public.exec_slack_purge_conversation('<principal id>', '<channel id>',
   'author_optout');` (a write, on purpose).
5. The followers need no manual step: digests are blanked and chat answers redacted within about 10 min (Slack DM
   answers re-rendered within about 5 min after that); brief lines and brief DMs are replaced within about 5 min. Since
   P9 this includes brief lines that came from a digest (the opt-out opens a 30-minute re-scrub window for every brief
   that still holds refs) and briefs older than 30 days whose DM still exists.
6. Record the date and the result counts (no names) in the ops log. Keep the member id privately: the decommission
   purge deletes the opt-outs.
7. Never a hand delete. Stop reading is not a substitute. A withdrawal of the request means deleting the opt-out row by
   hand.

---

## 9. Restricted senders and tombstones

- The rules are DD's `restricted_senders` and `restricted_sender_viewers` (SQL). A rule where Mitchell is a viewer is
  dropped for the assistant.
- Matching: the from, to and cc of every message plus the thread's participants (at most 600 screen hashes).
- Policy `hidden`: counts only (the Email tab, the brief, the mini-brief).
- Where the screen runs: triage (the read and the write), render, the attention pass, chat tools, the drafts pack,
  intake approvals, DD text.
- A tombstone keeps a whitelist-only row and deletes the thread's commitments, signals and email attention rows; purges
  its drafts (Slack cards re-render within about 5 min); redacts chat (answers that consulted or cited it, and every
  later answer of that conversation); scrubs the brief to "[Removed: restricted sender]" with the headline cleared; the
  brief DM is replaced within about 5 min. Since P9 that also reaches briefs older than 30 days and briefs whose
  delivery was left unclear.

---

## 10. Secret rotation

- **`EXEC_TOKEN_KEY`:** set `EXEC_TOKEN_KEY_PREVIOUS` = the old key and `EXEC_TOKEN_KEY` = the new one, redeploy. Since
  P9 the daily system purge (03:30 UTC) re-seals both Slack tokens under the new key (a compare-and-set on the old
  blob; one `slack.token_resealed` audit row each, ids and key ids only). Watch the System card's "Slack tokens on the
  previous key: N". Remove `EXEC_TOKEN_KEY_PREVIOUS` only when it reads 0 and at least 48 h have passed since the switch
  (the life of a check-in button and of an OAuth state). A token "on a key this server doesn't have" can't be re-sealed:
  Reconnect Slack.
- **Slack client and signing secrets:** regenerate (Basic Information), set them on "Delegation Doer" only, redeploy;
  expect a short window of 401s (Slack retries events; clicks must be repeated). When a collaborator leaves, regenerate
  both and Reconnect.
- **Slack tokens:** no env copy; leave Slack token rotation off.
- **Clone tokens:** mint with the CL2 script, set them, check the System card's Draft and Send token verdicts; revoke the
  old token id in the clone's registry (unsetting the env doesn't revoke it). Rotating `MISSIVE_API_TOKEN` means
  rotating the clone's `JWT_SECRET` (re-mint all).
- **`CRON_SECRET`:** Railway and GitHub together, then a workflow_dispatch of exec-tick.
- **Anthropic key:** rotate in the console; keep a console spend limit and alert.

---

## 11. Monitoring

- **The System card** (Overview): background jobs per kind (last success, queued, due, oldest due, failed in 24 h; the
  Slack reading kinds grouped as one row); the Draft and Send token verdicts and Draft checks; the Slack app and "Slack
  reading" rows; Morning brief (owner and reason, status and reason, channel, mode, fallback, check-ins; "Not built yet
  today, late" 45 min past the due time); the check-in token; AI spend today by feature and model refusals in 24 h;
  since P9 "Slack tokens on the previous key".
- **Settings, recent access:** every sign-in and, since P9, every refused step-up ("Refused: not a password sign-in").
  New-network alerts come from successful sign-ins only.
- **Ops alert keys** (the ops channel; rate-limited per key, one per 15 min):
  - jobs: `job-dead:<kind>`, `auth:<kind>`, `job-reaped:<kind>`;
  - cost and clone: `exec-cost-cap:<principal>`, `exec-usage-write`, `clone-ea-readiness:<reason>`,
    `email-account-problem:...`, `email-triage-refusal:...`, `draft-generate-request-shape`;
  - Slack: `exec-slack-events-missed:<principal>`, `exec-slack-revoked`, `exec-slack-read-revoked`,
    `exec-slack-read-revoke-failed`, `exec-slack-v2-missing`, `exec-chat-binding`;
  - brief: `brief-failed:`, `brief-delivery-unknown:`, `brief-fallback:`, `brief-fallback-failed:`, `brief-late:`,
    `brief-not-owned:`, `checkin-token-mismatch:`, `exec-access-new-network:`;
  - P9: `exec-step-up-refused:<UTC date>` (title "A session on the owner's account that wasn't a password sign-in was
    refused"; the detail is that session's sign-in methods and aal, for example `otp aal=aal1`: `otp`, `magiclink`,
    `recovery`, `invite`, `email/signup` and `email_change` are one-time links and codes), `exec-brief-v2-missing` (the
    P9 migration isn't applied yet), `brief-compose-timeout:<local date>` (the AI summary timed out and the
    deterministic brief was used).
- **`/api/cron/status`:** the exec-worker and exec-scheduler heartbeats (after a SIGTERM: "shutting down (SIGTERM)"); the
  legacy brief's skip reasons.
- **The brief's cost and latency** (lead decision L3; read-only): run it daily for two weeks after the brief is on. If
  more than 1 day in 10 ends with stop reason `aborted` (the 150 s compose deadline; each also raises
  `brief-compose-timeout:`), set the brief's effort to `medium` (one line in `src/lib/exec/llm/models.ts`).

  ```sql
  select date(u.created_at) as day, u.latency_ms, u.input_tokens, u.output_tokens, u.cost_usd, u.stop_reason
    from exec_ai_usage u
   where u.feature = 'brief'
   order by u.created_at desc
   limit 30;
  ```

- **Spend is soft-capped.** Since P9 each process keeps today's spend for 30 s per principal and feature, plus its own
  recorded calls at once; another process's spend shows up within 30 s. The chat cap still reads fresh after every
  tool round.
- **The whole-surface lockdown grid (§16):** after every exec migration; every row ok.

---

## 12. Troubleshooting by symptom

- **Mitchell gets a 404 on /executive (P9):**
  1. Is he signed in with his password, not through a sign-in link or a password reset link? Those sessions are
     refused: sign out, then sign back in with his password.
  2. Is `EXEC_ENABLED=true`, and is his principal enabled?
  3. Is there a refused row in Settings, recent access ("Refused: not a password sign-in", visible once the assistant
     opens for him) or an `exec-step-up-refused:` alert (§11)? Its detail names the refused session's sign-in methods.
- **His password stops working:** a sign-in link session on his account may have set a new one from DD Settings and
  signed in with it, which the assistant admits (§14). In this order, and note both steps in the ops log:
  1. Mitchell sets a new password (`/login`, "Forgot password?"), so the changed one stops working.
  2. Right after, end every session on his account, in the Supabase SQL editor (refresh tokens and amr claims go with
     their sessions; the team then needs a fresh sign-in link, agreed arrangement Q3):

     ```sql
     -- The one deliberate write in this runbook: ends every session on his account (P9 fixer security-1).
     delete from auth.sessions
      where user_id = (select u.id from auth.users u where lower(u.email) = 'mitchell@scaledai.org');
     ```

  3. He signs in with the new password.
- **The brief didn't arrive:** `brief_enabled` and supersede (page-only otherwise); the System card's owner reason
  (exec_disabled, not_installed, brief_off, legacy_delivered, not_superseding, no_installation) and status reason
  (page_only: after_cutoff, after_fallback, delivery_failed, rate_limited, ownership_lapsed, screen_unavailable;
  delivery_unknown is never re-posted; failed: pre_model, post_model, stale_build, never_built); the worker heartbeats
  and the exec-tick runs (a sleeping container can delay it up to an hour); the watchdog fires at +45 min (it needs
  `SLACK_BOT_TOKEN`); a cost cap reached gives the deterministic brief (reason budget); a compose timeout gives the
  deterministic brief (reason timeout, alert `brief-compose-timeout:`); the zone and DST.
- **The Slack DM is silent:** `EXEC_ENABLED` and the five `EXEC_SLACK_*` variables; chat on and Slack connected; the
  Request URL verified, Delayed Events on, the signing secret current; the message in his assistant DM, from his user
  id; the budget, the rate limit; a token sealed under a key this server doesn't have (§10); dead `exec.slack-reply`
  jobs (a deploy without the drain kills a reply in flight, §5).
- **Drafts not saving:** the Draft token verdict (token_missing, base_url_missing, not_scoped, token_expired,
  clone_unreachable, cl2_missing, cl2_not_ready, me_failed, wrong_scopes, wrong_accounts, multiple_principals, no_pin);
  drafts and email on and the pin; review blockers; generation errors; draft checks overdue. Drafts flapping between ok
  and token_missing, or draft jobs that never run: a second service runs the exec loops without `MISSIVE_EA_TOKEN` (L1;
  since P9 it leaves the draft kinds queued instead of failing them).
- **Chat says off:** chat on and installed; `EXEC_ENABLED`; a password sign-in (link sessions get the legacy Ask AI);
  the budget (it pauses until local midnight); the Slack tools need reading on, the email tools email and the pin.
- **Email not triaged:** the pin; CL1; `EXEC_WORKER_INTERNAL_CRON`; reconcile catches up within 5 min.
- **Spend at the cap:** the System card's AI spend by feature; the cap resets at his local midnight; the Slack budget is
  separate.
- **Jobs pile up after a deploy:** the old deployment drained (no new claims) and the new one claims them; a one-attempt
  job killed mid-run ends dead after its 120 s lease (`job-reaped:`); set the drain (§4 P9 step 5).

---

## 13. Live acceptance

The plan's eight items:

1. A non-owner gets a 404 on every page and API.
2. Needs Attention items match the DD rows they cite.
3. A test email is triaged in about a minute.
4. A draft appears in Outlook Drafts and its link opens it.
5. Send asks for confirmation and sends exactly the reviewed draft, once.
6. A Slack question gets an answer with working permalinks; a colleague's DM to Mitchell triggers nothing; a non-owner
   DM to the bot gets silence or a refusal; a retried event id gets one reply.
7. The brief arrives once at the configured time and matches the page; the old 8am brief is skipped; the watchdog fires
   when delivery is blocked.
8. A job killed mid-run is reclaimed after its lease, with no double post.

P7a: the lead-channel deny check (§4 P7a) and the hidden-delete check.

P9:

- His password sign-in opens `/executive`; `/login` shows no code step.
- A fresh sign-in link session on his account gets a 404 on `/executive`, one refused row and an `exec-step-up-refused:`
  alert (§4 P9 step 4). The "enrols its own authenticator" case (still refused, P9 F1) is proven by the automated tests
  (`page-access`, `access-session`, `drafts-send-route`); the "sets a new password" case is a known gap (§14).
  Never try them on his account: a password change locks him out of his password sign-in, and a factor left on his
  account can make Supabase ask for a code where DD has no screen for one (§4 P9). Run them live only against a
  non-production Supabase project.
- The two-worker claim and fence suites passed on real PostgreSQL 15 and 17 (scratch harness, §14).
- The injection and exfiltration set passed.
- The 390 px tap-target and contrast checks passed.
- With the drain on, a deploy during a Slack question lets the answer finish.
- The whole-surface grid (§16) is all ok.

---

## 14. Known gaps

- Each phase's own "known gaps" list stays valid: the P3 to P8 contracts, section 7.5 each (in the lead's scratch
  folder).
- P9's deferred follow-up: promises Mitchell makes himself in Slack are counted (the triage job result's
  `ownCommitments` and `ownCommitmentsDue`), not stored or shown (owner question Q5). Build the held design if, after
  the P7a live checks, about 3 or more a week carry a due date.
- The SQL suites (about 1,700 cases on PGlite, PostgreSQL 15 and 17, the claim and fence races among them) live in the
  lead's scratch harness, not in the repo (lead decision L6). From that folder (`p9-sql`):
  `node --test --test-reporter=spec tests/pglite.test.mjs`; `node --test --test-reporter=spec tests/realpg.test.mjs`;
  `PG_BIN=pgbin17 PG_LABEL=postgres17 node --test --test-reporter=spec tests/realpg.test.mjs`.
- The live model evals (chat, the hostile corpus, the brief's effort) have not been run: they need an owner-approved key
  and spend.
- The SIGTERM drain waits for the assistant's job runs only, not for open web requests (§5), and ships off (L5).
- A sign-in link session on his account can set a new password from DD Settings and then sign in with it; the assistant
  admits that password sign-in (P9's authenticator closed this until its removal on 2026-11-10, §4 P9). The visible
  sign: his old password stops working (§12, "His password stops working"). A link session that enrols an
  authenticator of its own is still refused: a one-time link anywhere in the session's record refuses it, whatever its
  aal (P9 F1).
- Brief lines citing a Slack channel later reclassified stay on the page until content expiry (they are withheld on
  render and in the DM); DD text lines already in a brief or chat stay until they expire; Slack's own copies of bot DMs
  after Disconnect stay in Slack.

---

## 15. Decommission

1. Settings, Slack, Disconnect; wait for the purge.
2. `node scripts/exec-purge-all.mjs` (a dry run). Since P9 it also reports the DD-bot mini-brief DMs still in Slack.
   Then `--apply`: it refuses while Slack is active and, since P9, while a mini-brief DM is undeleted unless
   `--delete-fallback-dms` (which needs `SLACK_BOT_TOKEN`) is given. `--include-audit` only if the audit log should go
   too.
3. Unset `EXEC_ENABLED`.
4. Clone: revoke the EA tokens, unset `EA_SEND_ENABLED`.
5. Delete the Slack app.
6. The opt-outs are deleted too (keep the member ids privately, §8).

---

## 16. Whole-surface lockdown grid

Paste into the Supabase SQL editor (read-only). Failing rows sort first. Every row must be ok. The counts are after P9:
39 exec tables, 6 exec sequences, 78 exec functions (P2a to P8 had 75; P9 adds three `_v2` functions; P10 adds its
own). The scratch harness runs this exact query on PGlite, PostgreSQL 15 and 17 after every migration.

```sql
with rel as (select c.oid, c.relname::text as name, c.relkind, c.relrowsecurity as rls, c.relacl from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relname like 'exec\_%' and c.relkind in ('r','p','v','m','f','S')),
fn as (select p.oid, p.proname::text as name, p.oid::pg_catalog.regprocedure::text as sig, p.prosecdef, p.proacl, (select c from unnest(p.proconfig) c where c like 'search_path=%' limit 1) as sp from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname like 'exec\_%')
select check_name, ok, detail from (
 select 'inventory: exec tables = 39' as check_name, count(*) = 39 as ok, count(*)::text as detail from rel where relkind in ('r','p')
 union all select 'inventory: exec sequences = 6', count(*) = 6, count(*)::text from rel where relkind = 'S'
 union all select 'inventory: exec functions = 78', count(*) = 78, count(*)::text from fn
 union all select 'inventory: no exec view/matview/foreign table', count(*) = 0, string_agg(name, ', ') from rel where relkind in ('v','m','f')
 union all select 'rls on: ' || name, rls, null from rel where relkind in ('r','p')
 union all select 'no policies: ' || r.name, count(p.policyname) = 0, string_agg(p.policyname::text, ', ') from rel r left join pg_catalog.pg_policies p on p.schemaname = 'public' and p.tablename = r.name where r.relkind in ('r','p') group by r.name
 union all select 'not in any publication: ' || r.name, count(pt.pubname) = 0, string_agg(pt.pubname::text, ', ') from rel r left join pg_catalog.pg_publication_tables pt on pt.schemaname = 'public' and pt.tablename = r.name where r.relkind in ('r','p') group by r.name
 union all select 'no anon/authenticated/PUBLIC privilege: ' || r.name, not x.bad, case when x.bad then coalesce(r.relacl::text, '(default ACL)') end from rel r cross join lateral (select case when r.relkind = 'S' then has_sequence_privilege('anon', r.oid, 'USAGE, SELECT, UPDATE') or has_sequence_privilege('authenticated', r.oid, 'USAGE, SELECT, UPDATE') else has_table_privilege('anon', r.oid, 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER') or has_table_privilege('authenticated', r.oid, 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER') or has_any_column_privilege('anon', r.oid, 'SELECT, INSERT, UPDATE, REFERENCES') or has_any_column_privilege('authenticated', r.oid, 'SELECT, INSERT, UPDATE, REFERENCES') end as bad) x
 union all select 'service_role access: ' || r.name, x.good, case when not x.good then coalesce(r.relacl::text, '(default ACL)') end from rel r cross join lateral (select case when r.relkind = 'S' then has_sequence_privilege('service_role', r.oid, 'USAGE') else has_table_privilege('service_role', r.oid, 'SELECT') and has_table_privilege('service_role', r.oid, 'INSERT') and has_table_privilege('service_role', r.oid, 'UPDATE') and has_table_privilege('service_role', r.oid, 'DELETE') end as good) x
 union all select 'security invoker: ' || sig, not prosecdef, case when prosecdef then 'SECURITY DEFINER' end from fn
 union all select 'search_path pinned: ' || sig, coalesce(sp = 'search_path=""' or (name = 'exec_ddtext_replace_item' and sp = 'search_path=public'), false), coalesce(sp, '(not set)') from fn
 union all select 'no anon/authenticated/PUBLIC execute: ' || sig, not (has_function_privilege('anon', oid, 'EXECUTE') or has_function_privilege('authenticated', oid, 'EXECUTE')), case when has_function_privilege('anon', oid, 'EXECUTE') or has_function_privilege('authenticated', oid, 'EXECUTE') then coalesce(proacl::text, '(default: PUBLIC may execute)') end from fn
 union all select 'service_role execute: ' || sig, has_function_privilege('service_role', oid, 'EXECUTE'), case when not has_function_privilege('service_role', oid, 'EXECUTE') then coalesce(proacl::text, '(default ACL)') end from fn
 union all select 'one signature per name: ' || name, count(*) = 1, case when count(*) > 1 then string_agg(sig, ' | ') end from fn group by name
 union all select 'service_role bypasses RLS', coalesce(bool_and(rolbypassrls), false), null from pg_catalog.pg_roles where rolname = 'service_role'
 union all select 'no CREATE on schema public: ' || r, not has_schema_privilege(r, 'public', 'CREATE'), null from unnest(array['anon','authenticated']) r
 union all select 'default privileges of postgres in public (' || t.k::text || ') grant nothing to anon/authenticated', not coalesce(bool_or(a.grantee in ('anon'::regrole, 'authenticated'::regrole) or (a.grantee = 0 and t.k <> 'f')), false), string_agg(case when a.grantee = 0 then 'PUBLIC' else a.grantee::regrole::text end || '=' || a.privilege_type, ', ') from (values ('r'::"char"), ('S'::"char"), ('f'::"char")) t(k) left join pg_catalog.pg_default_acl d on d.defaclrole = 'postgres'::regrole and d.defaclnamespace = 'public'::regnamespace and d.defaclobjtype = t.k left join lateral pg_catalog.aclexplode(d.defaclacl) a on true group by t.k
) checks order by ok, check_name;
```

`exec_ddtext_replace_item` is the one function pinned to `search_path=public` (a P5a choice, safe while anon and
authenticated have no CREATE on schema public, which the grid checks too).
