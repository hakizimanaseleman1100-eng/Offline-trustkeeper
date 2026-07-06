-- 0006_refunds.sql
-- Post-payment refunds. A refund inserts reversing rows (negative quantity and
-- total_price) that mirror the original receipt's lines. refund_of holds the
-- original receipt_no so a receipt can be shown as refunded and reports can net
-- the reversal automatically.
--
-- Run in the Supabase SQL editor. Idempotent.

alter table hospitality_sales add column if not exists refund_of text;

create index if not exists hospitality_sales_refund_of_idx on hospitality_sales (refund_of);
