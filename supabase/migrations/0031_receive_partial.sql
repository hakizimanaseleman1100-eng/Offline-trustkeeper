-- 0031_receive_partial.sql
-- Deliveries rarely match the order. The supplier is out of Fanta, brings 8
-- crates instead of 10, and the price has moved since last month. The storeman
-- corrects the lines at the door, and only what ACTUALLY arrived may touch
-- stock and cost.
--
-- Two changes to receive_purchase:
--  1. Skip lines with quantity 0. A line edited to zero is kept on the purchase
--     as a record that the supplier did not deliver it — worth knowing about a
--     supplier — but it must not write a zero movement or drag a product's
--     weighted average toward nothing.
--  2. Recompute total_cost from the lines. The header total was written when
--     the ORDER was raised; after corrections the server, which is the last to
--     see the lines, owns the truth.
--
-- Idempotent (create or replace); everything else about the function is
-- unchanged from 0030, including the two idempotency guards.

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
    -- Ordered but not delivered: keep the row, touch nothing.
    if l.quantity <= 0 then
      continue;
    end if;

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
        prev_costs = v_prev,
        -- What arrived, not what was asked for.
        total_cost = (
          select coalesce(sum(line_cost), 0) from purchase_lines
          where purchase_uid = p_uid and business_id = v_biz
        )
    where uid = p_uid;
end;
$$;

grant execute on function receive_purchase(uuid) to authenticated;
