-- 0021_public_menu.sql
-- A read-only public menu so a guest who scans a table/room QR on their OWN
-- phone (no venue login) can still see what to order. Returns only display-safe
-- fields — never cost_price — for the given venue. SECURITY DEFINER so it can
-- read past the per-tenant RLS, but it only ever exposes the menu, and callers
-- can only pass a business_id (which is what the QR already carries).
--
-- Auto-applied by the migrations workflow.

create or replace function get_public_menu(p_business_id text)
returns jsonb
language sql
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'name', (select name from businesses where id = p_business_id),
    'items', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', id,
        'item_name', item_name,
        'category', category,
        'sub_category', sub_category,
        'unit_price', unit_price,
        'tax_label', tax_label,
        'tax_rate', tax_rate
      ) order by category, item_name)
      from products
      where business_id = p_business_id and active is not false
    ), '[]'::jsonb)
  );
$$;

grant execute on function get_public_menu(text) to anon, authenticated;
