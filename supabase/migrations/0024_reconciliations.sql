-- 0024_reconciliations.sql
-- Saved end-of-day reconciliations, so a reconciliation is a dated record the
-- owner can pull up later for investigation ("find the past tables"), stamped
-- with who submitted it and when. One per station per business day (re-saving
-- updates it). The full sheet — every line + the summary — is kept in `data`
-- (jsonb) as a faithful snapshot; a few figures are also top-level columns so a
-- history list can be queried without parsing the json.
--
-- Auto-applied by the migrations workflow.

create extension if not exists "pgcrypto";

create table if not exists reconciliations (
  id             uuid primary key default gen_random_uuid(),
  business_id    text not null,
  station_id     text not null,
  station_name   text,
  business_day   date not null,
  submitted_by   text,
  submitted_at   timestamptz not null default now(),
  sales_total    numeric,
  cash_counted   numeric,
  cash_difference numeric,
  shrinkage_cost numeric,           -- total variance value at cost (negative = loss)
  data           jsonb not null default '{}'::jsonb,
  unique (business_id, station_id, business_day)
);

create index if not exists reconciliations_lookup_idx on reconciliations (business_id, station_id, business_day desc);

alter table reconciliations enable row level security;
grant all on reconciliations to authenticated;
drop policy if exists "tenant isolation" on reconciliations;
create policy "tenant isolation" on reconciliations
  for all to authenticated
  using (business_id = auth_business_id()) with check (business_id = auth_business_id());
