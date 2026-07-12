-- 0019_business_settings.sql
-- The owner's Settings hub: business constants set once and reused across
-- receipts and payments. `name` (0011) and `momo_code` (0011) already exist and
-- are reused as the business name and the MoMo pay number; this adds the rest of
-- the receipt identity and a footer message. Coupon rule columns come from 0018.
--
-- Auto-applied by the migrations workflow.

alter table businesses add column if not exists address        text;
alter table businesses add column if not exists phone          text;
alter table businesses add column if not exists email          text;
alter table businesses add column if not exists tin            text;
alter table businesses add column if not exists receipt_footer text;
