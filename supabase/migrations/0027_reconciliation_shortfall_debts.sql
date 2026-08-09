-- 0027_reconciliation_shortfall_debts.sql
-- A cash-up that comes up short is not a rounding error to be shrugged off —
-- it is money someone owes the venue. The Reconcile tab now refuses to save a
-- day until any shortfall has been recorded as a debt, so the two-sided amadeni
-- ledger becomes the single place every franc owed lives (RC-4), whether it was
-- taken on credit at the POS or went missing at close.
--
-- These two columns tag such a debt so the reconcile screen can tell whether
-- THIS day's shortfall has already been recorded (and not double-count it):
--   source       — null/'pos' for a normal credit sale, 'reconciliation' here
--   business_day — the day being reconciled (created_at is the moment of entry,
--                  which is not the same thing once someone closes after midnight)
--
-- Idempotent. Partial index is safe: it only serves SELECTs, never an upsert's
-- ON CONFLICT (PostgREST cannot use partial indexes there — 42P10).

alter table debts add column if not exists source       text;
alter table debts add column if not exists business_day date;

create index if not exists debts_reconciliation_idx
  on debts (business_id, station_id, business_day)
  where source = 'reconciliation';
