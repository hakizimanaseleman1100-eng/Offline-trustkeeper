-- 0013_tenant_isolation.sql  (SaaS Stage 1c — the security gate)
-- Enforces per-tenant isolation at the DATABASE level. Until now rows were
-- separated only by the app filtering on business_id, and the public anon key
-- could read everything. This replaces the permissive policies with strict
-- ones so a signed-in venue can only ever touch rows where
--   business_id = auth_business_id()
-- and the anon key gets no table access at all.
--
-- Safe for the existing venue: its data is tagged business_id = 'biz_123' and
-- its profile resolves to 'biz_123', so the scoped policy still returns it.
-- Offline use is unaffected (RLS only applies to Supabase, not the local mirror).
--
-- Run order matters — this must come after 0011 (auth_business_id) and 0012.

do $$
declare
  t text;
  tables text[] := array[
    'products', 'hospitality_sales', 'expenses', 'audit_logs',
    'staff', 'kitchen_tickets', 'stations', 'station_stock', 'stock_movements'
  ];
begin
  foreach t in array tables loop
    if to_regclass('public.' || t) is not null then
      execute format('alter table public.%I enable row level security', t);

      -- Remove the permissive policies from 0008 / 0010 / 0012.
      execute format('drop policy if exists "app access" on public.%I', t);
      execute format('drop policy if exists %I on public.%I', 'anon full access to ' || t, t);

      -- The public anon key must not reach tenant data; only signed-in venues.
      execute format('revoke all on public.%I from anon', t);
      execute format('grant all on public.%I to authenticated', t);

      -- Scope every row to the caller's business.
      execute format('drop policy if exists "tenant isolation" on public.%I', t);
      execute format(
        'create policy "tenant isolation" on public.%I for all to authenticated ' ||
        'using (business_id = auth_business_id()) with check (business_id = auth_business_id())',
        t
      );
    end if;
  end loop;
end $$;

-- Harden the per-station stock RPC: it runs as SECURITY DEFINER (bypasses RLS),
-- so it must derive the business from the caller and refuse stations that
-- aren't theirs — otherwise a signed-in venue could write another's stock.
create or replace function apply_station_stock(p_moves jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  m     jsonb;
  v_biz text := auth_business_id();
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

    insert into station_stock (station_id, product_id, business_id, quantity)
      values ((m->>'station_id')::uuid, m->>'product_id', v_biz, (m->>'delta')::numeric)
      on conflict (station_id, product_id)
      do update set quantity = station_stock.quantity + (m->>'delta')::numeric;

    insert into stock_movements (business_id, station_id, product_id, delta, reason, staff_name)
      values (v_biz, (m->>'station_id')::uuid, m->>'product_id',
              (m->>'delta')::numeric, coalesce(m->>'reason', 'adjust'), m->>'staff_name');
  end loop;
end;
$$;

-- The old global-stock RPC (0009) is superseded by per-station stock and no
-- longer called — drop it so it can't be abused across tenants.
drop function if exists apply_stock_deltas(jsonb);
