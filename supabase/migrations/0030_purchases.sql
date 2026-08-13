-- 0030_purchases.sql
-- Purchase management: the missing term in the reconciliation equation.
--
--   expected stock = opening + PURCHASES − sales
--
-- Without the middle term a variance proves nothing: a storeman accused of
-- losing 12 bottles can always answer "a crate came in and nobody wrote it
-- down", and he is often right. Recording deliveries is what turns the count
-- into evidence. Secondary wins: true margins as supplier prices move (weighted
-- average cost), price history, and reorder suggestions.
--
-- THREE DELIBERATE DEVIATIONS FROM THE SPEC, forced by the existing schema:
--  1. business_id is TEXT, not uuid — auth_business_id() returns text (0011)
--     and every RLS policy compares against it. A uuid column would fail them.
--  2. product_id is TEXT — that is what station_stock and stock_movements use,
--     and receive_purchase has to join both.
--  3. A purchase lands at a STATION. station_stock is the only stock table in
--     this schema, so "increment stock" needs a place to go; the WAC
--     denominator still uses the whole venue's on-hand, because cost_price is
--     a property of the product, not of one counter.
--
-- Idempotent throughout.

-- Packaging ------------------------------------------------------------------
-- Bars think in crates (amakase), not bottles. Default 1 means "sold as it is
-- bought" — spirits, food portions, airtime — so existing rows behave exactly
-- as they do today.
alter table products add column if not exists units_per_package integer not null default 1;
alter table products add column if not exists package_name      text default 'case';

-- Header ---------------------------------------------------------------------
create table if not exists purchases (
  id            uuid primary key default gen_random_uuid(),
  uid           uuid not null,                 -- client-generated; the idempotency key
  business_id   text not null,
  station_id    uuid,                          -- where the goods land
  po_number     text not null,                 -- PO-{device}-{seq}, generated offline
  supplier_name text,
  status        text not null default 'received' check (status in ('draft', 'received', 'void')),
  notes         text,
  ordered_at    timestamptz,
  received_at   timestamptz,
  total_cost    bigint not null default 0,     -- RWF integer, denormalised
  prev_costs    jsonb,                         -- product_id -> cost_price before this receive
  created_by_staff_id   text,
  created_by_staff_name text,
  voided_at     timestamptz,
  voided_by     text,
  created_at    timestamptz not null default now()
);

-- Full (non-partial) unique constraint: PostgREST's ON CONFLICT cannot use a
-- partial index (42P10), and the outbox upserts on uid.
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'purchases_uid_key') then
    alter table purchases add constraint purchases_uid_key unique (uid);
  end if;
end $$;

create index if not exists purchases_business_created_idx on purchases (business_id, created_at desc);

-- Lines ----------------------------------------------------------------------
create table if not exists purchase_lines (
  id           uuid primary key default gen_random_uuid(),
  uid          uuid not null,
  business_id  text not null,
  purchase_uid uuid not null references purchases (uid) on delete cascade,
  product_id   text not null,
  product_name text,                            -- snapshot: a renamed product must not rewrite history
  packages     integer not null default 0,      -- crates entered
  loose_units  integer not null default 0,      -- partial-crate bottles
  units_per_package_snapshot integer not null default 1,
  quantity     integer generated always as (packages * units_per_package_snapshot + loose_units) stored,
  unit_cost    bigint not null,                 -- RWF per UNIT for THIS purchase
  line_cost    bigint generated always as ((packages * units_per_package_snapshot + loose_units) * unit_cost) stored
);

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'purchase_lines_uid_key') then
    alter table purchase_lines add constraint purchase_lines_uid_key unique (uid);
  end if;
end $$;

create index if not exists purchase_lines_purchase_idx on purchase_lines (purchase_uid);

-- Tenant isolation, same shape as 0013/0023 -----------------------------------
do $$
declare t text;
begin
  foreach t in array array['purchases', 'purchase_lines'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon', t);
    execute format('grant all on public.%I to authenticated', t);
    execute format('drop policy if exists "tenant isolation" on public.%I', t);
    execute format(
      'create policy "tenant isolation" on public.%I for all to authenticated ' ||
      'using (business_id = auth_business_id()) with check (business_id = auth_business_id())',
      t
    );
  end loop;
end $$;

-- Receive: stock in + weighted average cost, atomically ----------------------
-- Idempotent two ways: the status check short-circuits a whole retry, and each
-- line's movement is keyed by the line uid so a half-applied call (impossible
-- inside one function, but possible if a caller re-drives it another way)
-- cannot double the balance.
create or replace function receive_purchase(p_uid uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_biz      text := auth_business_id();
  v_purchase purchases%rowtype;
  l          purchase_lines%rowtype;
  v_stock    numeric;
  v_old_cost numeric;
  v_new_cost bigint;
  v_prev     jsonb := '{}'::jsonb;
  v_written  int;
begin
  if v_biz is null then
    raise exception 'not authenticated';
  end if;

  select * into v_purchase from purchases where uid = p_uid and business_id = v_biz;
  if not found then
    raise exception 'purchase % not found', p_uid;
  end if;
  if v_purchase.status = 'received' then
    return; -- already applied: the retry-after-half-failure guard
  end if;
  if v_purchase.status = 'void' then
    raise exception 'purchase % is void', p_uid;
  end if;

  for l in select * from purchase_lines where purchase_uid = p_uid and business_id = v_biz loop
    -- The movement row is the receipt, exactly as in apply_station_stock (0028).
    insert into stock_movements (business_id, station_id, product_id, delta, reason, staff_name, uid)
      values (v_biz, v_purchase.station_id, l.product_id, l.quantity, 'purchase',
              v_purchase.created_by_staff_name, l.uid)
      on conflict (uid) do nothing;
    get diagnostics v_written = row_count;
    if v_written = 0 then
      continue;
    end if;

    -- Weighted average cost over the WHOLE venue's on-hand: cost_price belongs
    -- to the product, not to one counter.
    select coalesce(sum(ss.quantity), 0) into v_stock
      from station_stock ss
      where ss.business_id = v_biz and ss.product_id = l.product_id;
    select coalesce(cost_price, 0) into v_old_cost from products where id::text = l.product_id;

    v_new_cost := round(
      (v_stock * v_old_cost + l.quantity * l.unit_cost) / nullif(v_stock + l.quantity, 0)
    );

    -- Remember what it was, so a void can put it back.
    v_prev := v_prev || jsonb_build_object(l.product_id, v_old_cost);
    update products set cost_price = coalesce(v_new_cost, v_old_cost) where id::text = l.product_id;

    if v_purchase.station_id is not null then
      insert into station_stock (station_id, product_id, business_id, quantity)
        values (v_purchase.station_id, l.product_id, v_biz, l.quantity)
        on conflict (station_id, product_id)
        do update set quantity = station_stock.quantity + l.quantity;
    end if;
  end loop;

  update purchases
    set status = 'received',
        received_at = coalesce(received_at, now()),
        prev_costs = v_prev
    where uid = p_uid;
end;
$$;

grant execute on function receive_purchase(uuid) to authenticated;

-- Void: reverse the stock, restore the costs -----------------------------------
-- Deliberately NOT a retroactive recalculation. Costs go back to the snapshot
-- taken at receive; sales already priced against the newer cost keep their
-- recorded margin, because a report that changes after the fact is worse than
-- one that is slightly stale.
create or replace function void_purchase(p_uid uuid, p_staff text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_biz      text := auth_business_id();
  v_purchase purchases%rowtype;
  l          purchase_lines%rowtype;
  v_prev     numeric;
begin
  if v_biz is null then
    raise exception 'not authenticated';
  end if;

  select * into v_purchase from purchases where uid = p_uid and business_id = v_biz;
  if not found then
    raise exception 'purchase % not found', p_uid;
  end if;
  if v_purchase.status = 'void' then
    return; -- idempotent
  end if;

  if v_purchase.status = 'received' then
    for l in select * from purchase_lines where purchase_uid = p_uid and business_id = v_biz loop
      if v_purchase.station_id is not null then
        insert into stock_movements (business_id, station_id, product_id, delta, reason, staff_name, uid)
          values (v_biz, v_purchase.station_id, l.product_id, -l.quantity, 'purchase_void', p_staff,
                  gen_random_uuid())
          on conflict (uid) do nothing;

        update station_stock
          set quantity = quantity - l.quantity
          where station_id = v_purchase.station_id and product_id = l.product_id;
      end if;

      v_prev := (v_purchase.prev_costs ->> l.product_id)::numeric;
      if v_prev is not null then
        update products set cost_price = v_prev where id::text = l.product_id;
      end if;
    end loop;
  end if;

  update purchases
    set status = 'void', voided_at = now(), voided_by = p_staff
    where uid = p_uid;
end;
$$;

grant execute on function void_purchase(uuid, text) to authenticated;
