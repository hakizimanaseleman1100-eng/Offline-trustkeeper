-- 0026_staff_storeman_role.sql
-- The client has shipped a STOREMAN / barman role since the role-based access
-- work (permissions.js, Team tab), but staff.role's check constraint was last
-- updated in 0004 and still only allows WAITER/KITCHEN/MANAGER/OWNER — so
-- adding a storeman fails with a constraint violation (23514). Widen it.
--
-- Idempotent: drop-if-exists then re-add, same shape as 0004.

alter table staff drop constraint if exists staff_role_check;
alter table staff add constraint staff_role_check
  check (role in ('WAITER', 'KITCHEN', 'STOREMAN', 'MANAGER', 'OWNER'));
