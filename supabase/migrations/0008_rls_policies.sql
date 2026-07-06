-- 0008_rls_policies.sql
-- Fixes "401 Unauthorized" when the app reads/writes `staff` and
-- `kitchen_tickets`. Those tables had Row Level Security enabled (or lacked
-- grants) with no policy for the anonymous key the client uses, so every
-- request was rejected.
--
-- This app authenticates at the APP layer (staff PIN), not the database layer:
-- the public anon key already has full access to the other tables, and the
-- staff list (including pin hashes) is downloaded to every device for offline
-- login. So a permissive policy here matches the existing trust model rather
-- than weakening it.
--
-- Run in the Supabase SQL editor. Idempotent.

-- staff ---------------------------------------------------------------------
alter table staff enable row level security;
grant all on staff to anon, authenticated;

drop policy if exists "anon full access to staff" on staff;
create policy "anon full access to staff" on staff
  for all to anon, authenticated
  using (true) with check (true);

-- kitchen_tickets -----------------------------------------------------------
alter table kitchen_tickets enable row level security;
grant all on kitchen_tickets to anon, authenticated;

drop policy if exists "anon full access to kitchen_tickets" on kitchen_tickets;
create policy "anon full access to kitchen_tickets" on kitchen_tickets
  for all to anon, authenticated
  using (true) with check (true);
