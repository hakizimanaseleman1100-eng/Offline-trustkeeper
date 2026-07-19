-- 0023_debts.sql
-- Debt management (amadeni): a customer takes goods on credit. Each debt records
-- the waiter in charge (staff_id/staff_name — same pattern as hospitality_sales
-- and audit_logs) so reports can break debts down by waiter, and the station so
-- the per-station reconcile can show new/recovered/outstanding. Recoveries are
-- individual debt_payments rows, so "recovered today" is answerable per day.
--
-- Auto-applied by the migrations workflow.

create extension if not exists "pgcrypto";

create table if not exists debts (
  id            uuid primary key default gen_random_uuid(),  -- client-generated when created offline at the POS
  business_id   text not null,
  customer_id   uuid,                                        -- optional link to a registered customer
  customer_name text not null,                               -- who owes (free text; walk-in credit)
  amount        numeric not null,                            -- original debt amount
  staff_id      text,                                        -- waiter in charge
  staff_name    text,
  station_id    text,
  station_name  text,
  receipt_no    text,
  note          text,
  status        text not null default 'open' check (status in ('open', 'settled', 'void')),
  created_at    timestamptz not null default now()
);

create index if not exists debts_business_idx on debts (business_id);
create index if not exists debts_station_idx  on debts (station_id);
create index if not exists debts_staff_idx    on debts (staff_name);

create table if not exists debt_payments (
  id            uuid primary key default gen_random_uuid(),
  business_id   text not null,
  debt_id       uuid not null references debts (id) on delete cascade,
  amount        numeric not null,
  staff_id      text,
  staff_name    text,
  station_id    text,   -- inherited from the debt, so per-station recovery totals work
  station_name  text,
  created_at    timestamptz not null default now()
);

create index if not exists debt_payments_business_idx on debt_payments (business_id);
create index if not exists debt_payments_debt_idx     on debt_payments (debt_id);
create index if not exists debt_payments_station_idx  on debt_payments (station_id);

-- Tenant isolation (same pattern as 0013). Staff/owner only — not anon.
alter table debts enable row level security;
grant all on debts to authenticated;
drop policy if exists "tenant isolation" on debts;
create policy "tenant isolation" on debts
  for all to authenticated
  using (business_id = auth_business_id()) with check (business_id = auth_business_id());

alter table debt_payments enable row level security;
grant all on debt_payments to authenticated;
drop policy if exists "tenant isolation" on debt_payments;
create policy "tenant isolation" on debt_payments
  for all to authenticated
  using (business_id = auth_business_id()) with check (business_id = auth_business_id());
