-- 0018_coupons.sql
-- Customer loyalty: coupons a venue grants to a customer (manually, or by an
-- automatic spend rule), then redeems at the till as a bill discount. Also adds
-- the venue's optional auto-reward rule (spend threshold -> percent off).
--
-- Auto-applied by the migrations workflow.

create extension if not exists "pgcrypto";

create table if not exists customer_coupons (
  id                uuid primary key default gen_random_uuid(),
  business_id       text not null,
  customer_id       uuid not null,
  customer_username text,
  kind              text not null default 'percent' check (kind in ('percent', 'amount')),
  value             numeric not null,          -- percent (0-100) or a fixed RWF amount
  reason            text,                      -- e.g. "Loyalty — spent 50,000" or "Regular"
  status            text not null default 'active' check (status in ('active', 'redeemed', 'void')),
  created_at        timestamptz not null default now(),
  redeemed_at       timestamptz
);

create index if not exists customer_coupons_lookup_idx
  on customer_coupons (business_id, customer_id, status);

-- Tenant isolation (same pattern as customers / 0013).
alter table customer_coupons enable row level security;
grant all on customer_coupons to authenticated;
drop policy if exists "tenant isolation" on customer_coupons;
create policy "tenant isolation" on customer_coupons
  for all to authenticated
  using (business_id = auth_business_id()) with check (business_id = auth_business_id());

-- Optional auto-reward rule, per venue: customers whose lifetime spend reaches
-- loyalty_threshold RWF become eligible for a loyalty_reward_pct % coupon. Left
-- null = feature off (owner grants coupons manually only).
alter table businesses add column if not exists loyalty_threshold   numeric;
alter table businesses add column if not exists loyalty_reward_pct   numeric;
