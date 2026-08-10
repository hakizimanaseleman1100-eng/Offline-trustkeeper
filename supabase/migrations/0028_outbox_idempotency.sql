-- 0028_outbox_idempotency.sql
-- Makes every write the offline outbox performs safe to retry.
--
-- Sales and debts already carry a client-generated key (hospitality_sales.uid,
-- debts.id) so a retry upserts harmlessly. The other three writes did not, and
-- the worst of them was the stock RPC: `apply_station_stock` ADDS deltas, so a
-- call that reached Postgres but whose response was lost on 2G could not be
-- retried without decrementing the same beer twice. That is why the client only
-- ever console.error'd it — silently letting station stock drift instead, which
-- then shows up as phantom shrinkage in the next day's count and gets blamed on
-- whoever was holding the keys.
--
-- Fix: every movement carries a client uuid, and the movement row IS the
-- receipt. If the uid is already present the insert does nothing and the
-- balance is left alone, so applying a batch twice is identical to once.
--
-- Idempotent, and safe to run against a database mid-flight: the uid column is
-- nullable, so in-progress clients that don't send one keep working exactly as
-- before (NULLs never conflict under a unique constraint).

-- Client keys for the tables the outbox writes -------------------------------
alter table stock_movements add column if not exists uid uuid;
alter table audit_logs      add column if not exists uid uuid;
alter table expenses        add column if not exists uid uuid;

do $$
begin
  -- Full (non-partial) constraints: PostgREST's ON CONFLICT cannot use partial
  -- indexes (42P10), and the outbox upserts audit_logs and expenses by uid.
  if not exists (select 1 from pg_constraint where conname = 'stock_movements_uid_key') then
    alter table stock_movements add constraint stock_movements_uid_key unique (uid);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'audit_logs_uid_key') then
    alter table audit_logs add constraint audit_logs_uid_key unique (uid);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'expenses_uid_key') then
    alter table expenses add constraint expenses_uid_key unique (uid);
  end if;
end $$;

-- Retry-safe stock application ----------------------------------------------
-- Still SECURITY DEFINER and still tenant-scoped from the caller (0013), with
-- the movement now written FIRST so it can act as the idempotency receipt.
create or replace function apply_station_stock(p_moves jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  m         jsonb;
  v_biz     text := auth_business_id();
  v_uid     uuid;
  v_written int;
begin
  if v_biz is null then
    raise exception 'not authenticated';
  end if;

  for m in select value from jsonb_array_elements(p_moves) loop
    -- Only touch stations owned by the caller's business.
    if not exists (
      select 1 from stations
      where id = (m->>'station_id')::uuid and business_id = v_biz
    ) then
      continue;
    end if;

    v_uid := nullif(m->>'uid', '')::uuid;

    insert into stock_movements (business_id, station_id, product_id, delta, reason, staff_name, uid)
      values (v_biz, (m->>'station_id')::uuid, m->>'product_id', (m->>'delta')::numeric,
              coalesce(m->>'reason', 'adjust'), m->>'staff_name', v_uid)
      on conflict (uid) do nothing;

    -- 0 rows means this exact movement is already recorded: a retry of a call
    -- that did land. The balance already includes it — moving it again is the
    -- double-decrement this migration exists to prevent.
    get diagnostics v_written = row_count;
    if v_written = 0 then
      continue;
    end if;

    insert into station_stock (station_id, product_id, business_id, quantity)
      values ((m->>'station_id')::uuid, m->>'product_id', v_biz, (m->>'delta')::numeric)
      on conflict (station_id, product_id)
      do update set quantity = station_stock.quantity + (m->>'delta')::numeric;
  end loop;
end;
$$;

grant execute on function apply_station_stock(jsonb) to authenticated;
