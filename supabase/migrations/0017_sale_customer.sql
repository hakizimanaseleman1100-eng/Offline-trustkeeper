-- 0017_sale_customer.sql
-- Attaches a signed-in customer to their sales, so spend can be tracked per
-- customer (the basis for coupons by amount/profit). Nullable — walk-in and
-- flag-only orders leave these empty.
--
-- Auto-applied by the migrations workflow.

alter table hospitality_sales add column if not exists customer_id       uuid;
alter table hospitality_sales add column if not exists customer_username text;

create index if not exists hospitality_sales_customer_idx on hospitality_sales (customer_id);
