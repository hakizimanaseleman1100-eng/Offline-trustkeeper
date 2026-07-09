-- 0012_authenticated_access.sql
-- Fix: after adding venue accounts (0011) the app talks to Supabase as the
-- `authenticated` role instead of `anon`. The original tables (products,
-- hospitality_sales, expenses, audit_logs) had RLS policies for `anon` only, so
-- a signed-in venue could not read them — inventory and reports came back empty
-- even though the data is intact.
--
-- This gives every business table a uniform permissive policy for BOTH roles so
-- the signed-in venue can read/write its data (still filtered app-side by
-- business_id). Tightening this to strict per-tenant RLS is Stage 1c.
--
-- Run in the Supabase SQL editor. Idempotent.

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
      execute format('grant all on public.%I to anon, authenticated', t);
      execute format('drop policy if exists "app access" on public.%I', t);
      execute format(
        'create policy "app access" on public.%I for all to anon, authenticated using (true) with check (true)',
        t
      );
    end if;
  end loop;
end $$;
