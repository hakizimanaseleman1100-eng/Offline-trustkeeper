# Database migrations

The Supabase schema for this project lives here as plain SQL, applied in order.

## Applying migrations — automatic (preferred)

A GitHub Action (`.github/workflows/db-migrate.yml`) runs the migration `.sql`
files with `psql` whenever a file under `migrations/` changes on `main`. **Just
commit the new `.sql` file and push — it applies itself.** No more pasting into
the dashboard. (Migrations are idempotent, so it safely re-runs them all in
order.)

**One-time setup:** add a repository secret so the Action can reach the database.
1. Supabase → **Project Settings → Database → Connection string → URI**, and copy
   it (it includes your DB password).
2. GitHub → repo **Settings → Secrets and variables → Actions → New repository
   secret** → name `SUPABASE_DB_URL`, value = that URI.

You can also trigger it by hand from the repo's **Actions** tab → *Apply DB
migrations* → *Run workflow*.

## Applying migrations — manual fallback

If you ever need to apply one by hand: Supabase → **SQL Editor → New query** →
paste the file → **Run**. Every migration is **idempotent** (guarded with
`IF NOT EXISTS` etc.), so re-running one is harmless.

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
| `0010_stations.sql` | Multi-station: `stations`, `station_stock`, `stock_movements`, `staff.station_id`, sale `station_id`/`station_name`, and the `apply_station_stock` RPC. Per-station stock supersedes the global `products.stock_quantity` from 0009. |
| `0011_tenancy.sql` | SaaS tenancy: `businesses`, `profiles`, `auth_business_id()`, and `create_business()` (first account adopts existing `biz_123` data). Also turn OFF email confirmation in Supabase Auth settings. |
| `0012_authenticated_access.sql` | Lets the signed-in (`authenticated`) venue read/write the original tables (products/sales/expenses/etc.) — fixes empty inventory & reports after 0011. |
| `0013_tenant_isolation.sql` | **Stage 1c:** strict per-tenant RLS (`business_id = auth_business_id()`) on every table, removes public/anon table access, and hardens `apply_station_stock` against cross-tenant writes. |
| `0014_default_station.sql` | Auto-provisions a default "Main" station per venue (and at signup). |
| `0015_customers.sql` | Adds the `customers` table (CRM foundation: username/password + optional phone/email/TIN), tenant-scoped. |
| `0016_customer_master.sql` | Adds `businesses.customer_master_hash` — the owner's master password for customer lockouts. |
| `0017_sale_customer.sql` | Adds `customer_id` / `customer_username` to `hospitality_sales` for per-customer spend tracking. |

After running `0001`, the app's PIN login and per-waiter accountability work
end-to-end. Until then, the app falls back to a local-only default owner
(PIN `1234`) so it stays usable offline on first run.
