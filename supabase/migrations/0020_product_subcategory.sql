-- 0020_product_subcategory.sql
-- Adds a second taxonomy level to products: `category` (e.g. Beverages) plus a
-- finer `sub_category` (e.g. Beer, Liquor, Soft Drinks). Nullable — existing
-- products keep working with just a category.
--
-- Auto-applied by the migrations workflow.

alter table products add column if not exists sub_category text;

-- Defensive: the import writes item_code, so make sure the column exists even on
-- venues whose base schema predates it. No-op where it's already present.
alter table products add column if not exists item_code text;
