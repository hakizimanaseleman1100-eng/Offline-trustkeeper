-- 0003_product_active.sql
-- Soft-delete for products. We never hard-delete a product because historical
-- sales reference it by id (and reports resolve the item name through it);
-- instead it's marked inactive and hidden from the POS menu.
--
-- Run in the Supabase SQL editor. Idempotent.

alter table products add column if not exists active boolean not null default true;
