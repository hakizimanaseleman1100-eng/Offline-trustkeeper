-- 0009_stock.sql
-- Stock tracking. products.stock_quantity is the units on hand; NULL means the
-- product isn't stock-tracked (services, rooms, etc.) and is always sellable.
--
-- Sales decrement stock and refunds add it back, applied through an atomic RPC
-- so concurrent devices can't clobber the count. The client sends a batch of
-- { id, qty } deltas; each qty is SUBTRACTED (a refund sends a negative qty,
-- which adds back). NULL-stock products are skipped.
--
-- Run in the Supabase SQL editor. Idempotent.

alter table products add column if not exists stock_quantity numeric;

create or replace function apply_stock_deltas(p_deltas jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  d jsonb;
begin
  for d in select value from jsonb_array_elements(p_deltas) loop
    update products
      set stock_quantity = stock_quantity - (d->>'qty')::numeric
      where id::text = (d->>'id') and stock_quantity is not null;
  end loop;
end;
$$;

grant execute on function apply_stock_deltas(jsonb) to anon, authenticated;
