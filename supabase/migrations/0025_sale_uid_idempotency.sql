-- 0025_sale_uid_idempotency.sql
-- Makes the sales sync idempotent. Every sale line created at the POS carries
-- a client-generated uuid (`uid`); the client pushes with
-- upsert(onConflict:'uid', ignoreDuplicates:true), so a retry after a
-- half-failed sync (insert succeeded, local synced_status update didn't — the
-- classic flaky-2G failure) can never duplicate revenue.
--
-- `uid` is nullable: rows from pre-uid app versions have NULL, which is safe
-- under a plain UNIQUE constraint because NULLs never conflict with each other.
-- NOTE: this must be a FULL (non-partial) constraint — PostgREST's ON CONFLICT
-- cannot use partial indexes (error 42P10).
--
-- Written to be idempotent: safe whether the database has nothing, the old
-- partial index from the first version of this file, or the finished
-- constraint (already applied manually via the SQL editor).

alter table hospitality_sales add column if not exists uid uuid;

do $$
begin
  -- Remove the old partial index only if it exists as a standalone index
  -- (i.e. not owned by the constraint below).
  if exists (
    select 1 from pg_indexes
    where tablename = 'hospitality_sales'
      and indexname = 'hospitality_sales_uid_key'
  ) and not exists (
    select 1 from pg_constraint
    where conrelid = 'hospitality_sales'::regclass
      and conname = 'hospitality_sales_uid_key'
  ) then
    execute 'drop index hospitality_sales_uid_key';
  end if;

  -- Ensure the full unique constraint.
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'hospitality_sales'::regclass
      and conname = 'hospitality_sales_uid_key'
  ) then
    alter table hospitality_sales
      add constraint hospitality_sales_uid_key unique (uid);
  end if;
end $$;
