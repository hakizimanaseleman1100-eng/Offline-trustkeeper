-- 0025_sale_uid_idempotency.sql
-- Makes the sales sync idempotent. Every sale line created at the POS now
-- carries a client-generated uuid (`uid`). The client pushes with
-- upsert(onConflict: 'uid', ignoreDuplicates: true), so a retry after a sync
-- that half-failed (insert succeeded, local synced_status update didn't — the
-- classic flaky-2G failure) can never duplicate revenue.
--
-- `uid` is nullable so rows synced by app versions predating this migration
-- keep working; the partial unique index only enforces uniqueness where a uid
-- exists.
--
-- Auto-applied by the migrations workflow.

alter table hospitality_sales add column if not exists uid uuid;

create unique index if not exists hospitality_sales_uid_key
  on hospitality_sales (uid)
  where uid is not null;
