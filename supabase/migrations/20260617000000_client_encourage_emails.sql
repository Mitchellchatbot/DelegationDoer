-- Per-client "Encourage emails" toggle. Defaults to TRUE so the
-- touchpoint dashboard behaves the same for every existing client;
-- leaders can flip it OFF for clients where weekly email cadence
-- isn't part of the relationship (pure-delivery / one-shot site
-- builds / billing-only customers). When OFF:
--   * touchpoint badge ("Never emailed", "Neglected", "Healthy")
--     is hidden / muted on every surface
--   * the client is excluded from the Needs-follow-up widget
--   * the client doesn't count toward sidebar Clients badge
--   * everything ELSE (tasks, satisfaction sentiment, client tab)
--     keeps working unchanged

alter table public.clients
  add column if not exists encourage_emails boolean not null default true;
