-- 0014_default_station.sql
-- Stock is tracked per station, so a venue needs at least one station before it
-- can set quantities. To keep setup simple, every venue gets a default "Main"
-- station automatically — a single-bar venue never has to touch the Stations
-- tab, and the Inventory quantity field just works.
--
-- Idempotent: only creates a station when a business has none.

-- Backfill: a "Main" station for any business that doesn't have one yet.
insert into stations (business_id, name)
select b.id, 'Main'
from businesses b
where not exists (select 1 from stations s where s.business_id = b.id);

-- Carry any old global product stock (from 0009's products.stock_quantity) into
-- the venue's first station, so counts entered before per-station stock aren't
-- lost. Never overwrites a live count (on conflict do nothing).
insert into station_stock (station_id, product_id, business_id, quantity)
select st.id, p.id::text, p.business_id, p.stock_quantity
from products p
cross join lateral (
  select id from stations where business_id = p.business_id order by created_at asc limit 1
) st
where p.stock_quantity is not null
on conflict (station_id, product_id) do nothing;

-- New venues get a default station as part of signup.
create or replace function create_business(p_name text)
returns text
language plpgsql security definer set search_path = public
as $$
declare
  bid text;
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;

  select business_id into bid from profiles where id = auth.uid();
  if bid is not null then
    return bid;
  end if;

  if not exists (select 1 from profiles) and exists (select 1 from businesses where id = 'biz_123') then
    bid := 'biz_123';
  else
    insert into businesses (name) values (coalesce(nullif(p_name, ''), 'My Venue')) returning id into bid;
  end if;

  insert into profiles (id, business_id) values (auth.uid(), bid);

  -- Give the new venue a default station so stock works out of the box.
  insert into stations (business_id, name)
  select bid, 'Main'
  where not exists (select 1 from stations where business_id = bid);

  return bid;
end;
$$;
