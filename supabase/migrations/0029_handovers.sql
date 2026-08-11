-- 0029_handovers.sql
-- The online half of the waiter → barman round handover.
--
-- The QR was built for the case where two phones share no network. When there
-- IS one, making the barman scan is pointless friction — the round should
-- simply appear at the counter. But two delivery paths for the same order is
-- exactly how a bar ends up serving (and charging) the same crate twice: the
-- round arrives by itself, the barman scans the code anyway out of habit, and
-- the tab doubles. That is a real loss and a real dispute with a customer.
--
-- So the two paths are not two orders. This table stores the SAME payload the
-- QR carries, under the SAME handover id, and the client applies a round keyed
-- on that id (received_rounds in Dexie). Whichever transport arrives first
-- wins; the other one is recognised and ignored. The QR stops being a parallel
-- truth and becomes what it should be — the fallback.
--
-- `received_at` is claimed atomically by the counter that takes the round, so a
-- venue running two tills cannot both pick it up.

create table if not exists handovers (
  id            uuid primary key,          -- the handover id, minted on the waiter's phone
  business_id   text not null,
  tab_uid       uuid not null,             -- the tab's identity across devices
  tab_name      text,
  round         integer not null,
  waiter_id     text,
  waiter_name   text,
  payload       jsonb not null,            -- exactly what the QR encodes
  created_at    timestamptz not null default now(),
  received_at   timestamptz,               -- claimed by the counter that applied it
  received_by   text
);

create index if not exists handovers_business_pending_idx
  on handovers (business_id, created_at) where received_at is null;

-- Tenant isolation, same pattern as 0013/0023. Staff-only, never anon.
alter table handovers enable row level security;
grant all on handovers to authenticated;
drop policy if exists "tenant isolation" on handovers;
create policy "tenant isolation" on handovers
  for all to authenticated
  using (business_id = auth_business_id()) with check (business_id = auth_business_id());

-- Realtime: the counter subscribes so a round lands without a poll. Adding a
-- table to a publication twice errors, so guard it (same shape as 0004).
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and tablename = 'handovers'
  ) then
    alter publication supabase_realtime add table handovers;
  end if;
end $$;
