-- 0015_customers.sql
-- Customer accounts (CRM foundation). Registered with a username + password
-- (for a future customer sign-in); phone, email, and TIN are optional. Sets up
-- later features: per-customer order tracking and coupons by spend/profit.
--
-- Auto-applied by the migrations workflow.

create extension if not exists "pgcrypto";

create table if not exists customers (
  id          uuid primary key default gen_random_uuid(),
  business_id text not null,
  username    text not null,
  pw_hash     text not null,          -- salted SHA-256, computed client-side; never plaintext
  phone       text,
  email       text,
  tin         text,
  active      boolean not null default true,
  created_at  timestamptz not null default now()
);

create index if not exists customers_business_idx on customers (business_id);
-- Username is unique within a business among active customers (for login later).
create unique index if not exists customers_business_username_idx
  on customers (business_id, lower(username)) where active;

-- Tenant isolation (same pattern as 0013): a venue only sees its own customers.
alter table customers enable row level security;
grant all on customers to authenticated;
drop policy if exists "tenant isolation" on customers;
create policy "tenant isolation" on customers
  for all to authenticated
  using (business_id = auth_business_id()) with check (business_id = auth_business_id());
