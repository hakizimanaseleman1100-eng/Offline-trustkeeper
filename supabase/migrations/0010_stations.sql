-- 0010_stations.sql
-- Multi-station support. A venue has several selling stations (main bar,
-- restaurant, pool bar, reception…). Each station holds its OWN stock, so a
-- storeman is accountable for what he was issued vs. what he sold vs. what
-- remains at day-end.
--
--   stations        — the selling points.
--   staff.station_id— which station a staff member works.
--   station_stock   — current on-hand quantity per (station, product).
--   stock_movements — append-only log of every change (issue/sale/refund/
--                     adjust/transfer) for the reconciliation trail.
--   hospitality_sales.station_id/station_name — tag each sale to its station.
--
-- apply_station_stock(p_moves) applies a batch of { station_id, product_id,
-- business_id, delta, reason, staff_name } atomically: it adjusts
-- station_stock and logs a movement. delta is signed — issue/refund positive,
-- sale negative.
--
-- Run in the Supabase SQL editor. Idempotent.

create extension if not exists "pgcrypto";

-- Stations ------------------------------------------------------------------
create table if not exists stations (
  id          uuid primary key default gen_random_uuid(),
  business_id text not null,
  name        text not null,
  active      boolean not null default true,
  created_at  timestamptz not null default now()
);
create index if not exists stations_business_idx on stations (business_id);

alter table staff             add column if not exists station_id uuid;
alter table hospitality_sales add column if not exists station_id   uuid;
alter table hospitality_sales add column if not exists station_name text;

-- Per-station current stock -------------------------------------------------
create table if not exists station_stock (
  station_id  uuid not null,
  product_id  text not null,   -- text so it matches products.id whatever its type
  business_id text not null,
  quantity    numeric not null default 0,
  primary key (station_id, product_id)
);
create index if not exists station_stock_station_idx on station_stock (station_id);

-- Movement log (reconciliation trail) ---------------------------------------
create table if not exists stock_movements (
  id          uuid primary key default gen_random_uuid(),
  business_id text not null,
  station_id  uuid not null,
  product_id  text not null,
  delta       numeric not null,
  reason      text not null default 'adjust',  -- issue | sale | refund | adjust | transfer
  staff_name  text,
  created_at  timestamptz not null default now()
);
create index if not exists stock_movements_station_created_idx
  on stock_movements (station_id, created_at);

-- Atomic batch apply --------------------------------------------------------
create or replace function apply_station_stock(p_moves jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  m jsonb;
begin
  for m in select value from jsonb_array_elements(p_moves) loop
    insert into station_stock (station_id, product_id, business_id, quantity)
      values ((m->>'station_id')::uuid, m->>'product_id', m->>'business_id', (m->>'delta')::numeric)
      on conflict (station_id, product_id)
      do update set quantity = station_stock.quantity + (m->>'delta')::numeric;

    insert into stock_movements (business_id, station_id, product_id, delta, reason, staff_name)
      values (m->>'business_id', (m->>'station_id')::uuid, m->>'product_id',
              (m->>'delta')::numeric, coalesce(m->>'reason', 'adjust'), m->>'staff_name');
  end loop;
end;
$$;
grant execute on function apply_station_stock(jsonb) to anon, authenticated;

-- RLS: same app-layer trust model as the other tables (see 0008) -----------
alter table stations enable row level security;
grant all on stations to anon, authenticated;
drop policy if exists "anon full access to stations" on stations;
create policy "anon full access to stations" on stations
  for all to anon, authenticated using (true) with check (true);

alter table station_stock enable row level security;
grant all on station_stock to anon, authenticated;
drop policy if exists "anon full access to station_stock" on station_stock;
create policy "anon full access to station_stock" on station_stock
  for all to anon, authenticated using (true) with check (true);

alter table stock_movements enable row level security;
grant all on stock_movements to anon, authenticated;
drop policy if exists "anon full access to stock_movements" on stock_movements;
create policy "anon full access to stock_movements" on stock_movements
  for all to anon, authenticated using (true) with check (true);
