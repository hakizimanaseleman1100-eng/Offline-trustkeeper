# Database migrations

The Supabase schema for this project lives here as plain SQL, applied in order.
There is no automated runner — each file is meant to be pasted into the
**Supabase SQL editor** and run once, oldest first.

## How to apply a migration

1. Open your project at <https://supabase.com/dashboard>.
2. Go to **SQL Editor → New query**.
3. Paste the contents of the next un-applied file from `migrations/`.
4. Click **Run**.

Every migration is written to be **idempotent** (guarded with `IF NOT EXISTS`),
so re-running one by accident is harmless.

## Applied order

| File | What it does |
|------|--------------|
| `0001_staff_and_identity.sql` | Adds the `staff` table (PIN login) and stamps `staff_id` / `staff_name` onto `hospitality_sales` and `audit_logs`. |
| `0002_receipts_and_momo.sql` | Adds `receipt_no`, `device_id`, and `momo_ref` to `hospitality_sales`. |
| `0003_product_active.sql` | Adds a soft-delete `active` flag to `products`. |
| `0004_kitchen_tickets.sql` | Adds the `kitchen_tickets` table (realtime) for the kitchen display. |
| `0005_discounts.sql` | Adds `discount_amount` to `hospitality_sales` for bill-level discounts. |
| `0006_refunds.sql` | Adds `refund_of` to `hospitality_sales` for post-payment refunds. |
| `0007_covers_and_rooms.sql` | Adds `guest_count` and room `check_in_date` / `check_out_date` to `hospitality_sales`. |
| `0008_rls_policies.sql` | Grants the anon key access to `staff` and `kitchen_tickets` (fixes 401 errors). |
| `0009_stock.sql` | Adds `products.stock_quantity` + the `apply_stock_deltas` RPC that sales/refunds call to adjust stock atomically. |

After running `0001`, the app's PIN login and per-waiter accountability work
end-to-end. Until then, the app falls back to a local-only default owner
(PIN `1234`) so it stays usable offline on first run.
