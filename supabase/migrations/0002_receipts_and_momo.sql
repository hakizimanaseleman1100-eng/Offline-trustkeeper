-- 0002_receipts_and_momo.sql
-- Fiscal receipt reference, the device that issued it, and the MoMo payment
-- reference — all on the sale record.
--
-- Run in the Supabase SQL editor. Idempotent.

-- receipt_no is the customer-facing fiscal reference printed on the bill
-- (e.g. "REC-00042"). device_id identifies which POS device issued it, so
-- that once multiple devices are in use the same local sequence on two
-- devices can still be told apart / reconciled server-side.
alter table hospitality_sales add column if not exists receipt_no text;
alter table hospitality_sales add column if not exists device_id  text;

-- MoMo (MTN Mobile Money) transaction reference the waiter records at
-- checkout, so the owner can reconcile POS takings against the MTN dashboard.
alter table hospitality_sales add column if not exists momo_ref text;

create index if not exists hospitality_sales_receipt_idx on hospitality_sales (receipt_no);
