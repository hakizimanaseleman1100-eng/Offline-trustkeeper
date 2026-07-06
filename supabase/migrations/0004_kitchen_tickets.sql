-- 0004_kitchen_tickets.sql
-- Kitchen/bar tickets. When a waiter taps "Send Round", the round's items are
-- written here so a kitchen device (logged in as a KITCHEN-role staff member)
-- sees them live and marks them done.
--
-- Run in the Supabase SQL editor. Idempotent.

create extension if not exists "pgcrypto";

create table if not exists kitchen_tickets (
  id          uuid primary key default gen_random_uuid(),
  business_id text not null,
  tab_id      integer,               -- the waiter's local tab id (informational)
  tab_name    text,
  round       integer,
  items       jsonb not null,        -- [{ "name": "...", "quantity": n }]
  status      text not null default 'new' check (status in ('new', 'done')),
  staff_name  text,
  created_at  timestamptz not null default now()
);

create index if not exists kitchen_tickets_business_status_idx
  on kitchen_tickets (business_id, status);

-- Allow the new KITCHEN role on staff (0001 only permitted WAITER/MANAGER/OWNER).
alter table staff drop constraint if exists staff_role_check;
alter table staff add constraint staff_role_check
  check (role in ('WAITER', 'KITCHEN', 'MANAGER', 'OWNER'));

-- Realtime: the kitchen display subscribes to inserts/updates. Adding a table
-- to a publication twice errors, so guard it.
do $$
begin
  alter publication supabase_realtime add table kitchen_tickets;
exception
  when duplicate_object then null;
  when undefined_object then null;  -- publication missing (older projects)
end $$;
