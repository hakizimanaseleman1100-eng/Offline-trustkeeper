-- 0011_tenancy.sql
-- SaaS multi-tenancy foundation (Stage 1a). Additive and non-breaking: it adds
-- the account model without changing how the existing tables behave yet. The
-- strict per-tenant RLS on those tables is a later, deliberate step (Stage 1c).
--
--   businesses — one row per venue/tenant.
--   profiles   — maps a Supabase Auth user to its business.
--   auth_business_id() — the caller's business id, for RLS policies.
--   create_business(name) — called right after signup; the FIRST ever account
--     adopts the pre-existing `biz_123` data, later accounts get a fresh business.
--
-- Run in the Supabase SQL editor. Idempotent.
--
-- Also (one-time, in the dashboard): Authentication → Providers → Email, turn
-- OFF "Confirm email" so signup logs the venue in immediately (self-serve).

create extension if not exists "pgcrypto";

create table if not exists businesses (
  id         text primary key default gen_random_uuid()::text,
  name       text not null,
  momo_code  text,                         -- venue's MoMo pay code (future use)
  plan       text not null default 'trial',
  created_at timestamptz not null default now()
);

create table if not exists profiles (
  id          uuid primary key references auth.users (id) on delete cascade,
  business_id text not null references businesses (id) on delete cascade,
  created_at  timestamptz not null default now()
);
create index if not exists profiles_business_idx on profiles (business_id);

-- Seed the existing single-tenant data as the first business.
insert into businesses (id, name) values ('biz_123', 'My Venue')
  on conflict (id) do nothing;

-- The caller's business id — SECURITY DEFINER so RLS policies can call it
-- without needing their own read policy on profiles.
create or replace function auth_business_id()
returns text
language sql stable security definer set search_path = public
as $$
  select business_id from profiles where id = auth.uid();
$$;
grant execute on function auth_business_id() to anon, authenticated;

-- Called once, straight after signup, to attach the new user to a business.
create or replace function create_business(p_name text)
returns text
language plpgsql security definer set search_path = public
as $$
declare
  bid text;
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;

  -- Already linked? Return it (idempotent).
  select business_id into bid from profiles where id = auth.uid();
  if bid is not null then
    return bid;
  end if;

  -- The very first account adopts the pre-existing venue data.
  if not exists (select 1 from profiles) and exists (select 1 from businesses where id = 'biz_123') then
    bid := 'biz_123';
  else
    insert into businesses (name) values (coalesce(nullif(p_name, ''), 'My Venue')) returning id into bid;
  end if;

  insert into profiles (id, business_id) values (auth.uid(), bid);
  return bid;
end;
$$;
grant execute on function create_business(text) to authenticated;

-- RLS for the account tables: a user only ever sees their own business/profile.
alter table businesses enable row level security;
grant all on businesses to authenticated;
drop policy if exists "own business" on businesses;
create policy "own business" on businesses
  for all to authenticated
  using (id = auth_business_id()) with check (id = auth_business_id());

alter table profiles enable row level security;
grant all on profiles to authenticated;
drop policy if exists "own profile" on profiles;
create policy "own profile" on profiles
  for all to authenticated
  using (id = auth.uid()) with check (id = auth.uid());
