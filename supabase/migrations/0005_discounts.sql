-- 0005_discounts.sql
-- Records how much of a bill-level discount was allocated to each sale line.
-- total_price is stored NET (already discounted), so revenue reports need no
-- special handling; discount_amount is kept for a future discount report and
-- for reconciling the original gross.
--
-- Run in the Supabase SQL editor. Idempotent.

alter table hospitality_sales add column if not exists discount_amount numeric not null default 0;
