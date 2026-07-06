-- 0007_covers_and_rooms.sql
-- Cover (guest) count per sale, and check-in/out dates for room lines.
--   * guest_count powers "average spend per cover" in reports.
--   * check_in_date / check_out_date give room sales a folio window; the
--     number of nights is the line quantity.
--
-- Run in the Supabase SQL editor. Idempotent.

alter table hospitality_sales add column if not exists guest_count    integer;
alter table hospitality_sales add column if not exists check_in_date  date;
alter table hospitality_sales add column if not exists check_out_date date;
