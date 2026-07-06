-- 0001_staff_and_identity.sql
-- PIN-based staff accounts, and stamping *who* performed each sale / action.
--
-- Run this in the Supabase SQL editor (see supabase/README.md).
-- Safe to run more than once — every statement is guarded with IF NOT EXISTS.

create extension if not exists "pgcrypto";  -- provides gen_random_uuid()

-- ---------------------------------------------------------------------------
-- Staff accounts
-- ---------------------------------------------------------------------------
-- pin_hash is a SHA-256 of `${business_id}:${pin}` computed client-side. The
-- raw 4-digit PIN is never stored or transmitted. A 4-digit PIN is about
-- accountability + casual access control on a shared device, not cryptographic
-- secrecy, but hashing still avoids storing it in the clear.
create table if not exists staff (
  id          uuid primary key default gen_random_uuid(),
  business_id text not null,
  name        text not null,
  pin_hash    text not null,
  role        text not null default 'WAITER' check (role in ('WAITER', 'MANAGER', 'OWNER')),
  active      boolean not null default true,
  created_at  timestamptz not null default now()
);

create index if not exists staff_business_idx on staff (business_id);

-- A PIN must be unique within a business among *active* staff, otherwise login
-- (look up by hash) would be ambiguous. Deactivated staff free up their PIN.
create unique index if not exists staff_business_pin_active_idx
  on staff (business_id, pin_hash) where active;

-- ---------------------------------------------------------------------------
-- Stamp identity onto transactions
-- ---------------------------------------------------------------------------
-- Nullable so historical rows and any not-logged-in fallback still insert.
-- staff_name is denormalized (snapshotted) so reports keep the correct name
-- even if the staff member is later renamed or removed — same philosophy as
-- snapshotting price/tax on a sale.
alter table hospitality_sales add column if not exists staff_id   uuid;
alter table hospitality_sales add column if not exists staff_name text;

alter table audit_logs        add column if not exists staff_id   uuid;
alter table audit_logs        add column if not exists staff_name text;

-- ---------------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------------
-- New tables have RLS disabled by default, which matches how the existing
-- tables are accessed with the anon key today. If you later enable RLS on the
-- project, add a policy for `staff` mirroring your other tables, e.g.:
--
--   alter table staff enable row level security;
--   create policy "anon full access to staff" on staff
--     for all using (true) with check (true);
