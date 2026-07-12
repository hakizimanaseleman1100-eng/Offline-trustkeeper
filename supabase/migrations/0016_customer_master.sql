-- 0016_customer_master.sql
-- A venue-level "customer master password" the owner sets, used to help a
-- customer who forgot their own password (reset/override). Stored hashed on the
-- business. Customers self-register on the self-service screen; the owner only
-- views them and manages this master password.
--
-- Auto-applied by the migrations workflow.

alter table businesses add column if not exists customer_master_hash text;
