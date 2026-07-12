-- 0022_portal_accounts.sql
-- Makes the table/room QR portal fully self-serve from a guest's OWN phone:
--  1. businesses.app_url — the public app link the QR codes should point to
--     (so codes generated on localhost still open on a phone).
--  2. anon-safe customer account RPCs, so a guest with no venue login can
--     register / sign in / reset their password. Passwords are salted SHA-256
--     hashes computed client-side; these functions only ever see the hash.
-- All three RPCs are SECURITY DEFINER (to read/write customers past per-tenant
-- RLS) but only act on the business_id passed in, which the QR already carries.
--
-- Auto-applied by the migrations workflow.

alter table businesses add column if not exists app_url text;

-- Register a customer (unique active username per venue).
create or replace function register_customer(
  p_business_id text,
  p_username    text,
  p_pw_hash     text,
  p_phone       text default null,
  p_email       text default null,
  p_tin         text default null
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  if coalesce(trim(p_username), '') = '' or coalesce(p_pw_hash, '') = '' then
    return jsonb_build_object('error', 'Username and password are required');
  end if;
  if exists (
    select 1 from customers
    where business_id = p_business_id and lower(username) = lower(trim(p_username)) and active
  ) then
    return jsonb_build_object('error', 'That username is taken');
  end if;
  insert into customers (business_id, username, pw_hash, phone, email, tin, active)
  values (
    p_business_id, trim(p_username), p_pw_hash,
    nullif(trim(coalesce(p_phone, '')), ''),
    nullif(trim(coalesce(p_email, '')), ''),
    nullif(trim(coalesce(p_tin,   '')), ''),
    true
  )
  returning id into v_id;
  return jsonb_build_object('id', v_id, 'username', trim(p_username));
exception when unique_violation then
  return jsonb_build_object('error', 'That username is taken');
end $$;
grant execute on function register_customer(text, text, text, text, text, text) to anon, authenticated;

-- Verify a login. Returns {id, username} on success, else {error}.
create or replace function signin_customer(p_business_id text, p_username text, p_pw_hash text)
returns jsonb
language sql security definer set search_path = public as $$
  select coalesce(
    (select jsonb_build_object('id', id, 'username', username)
       from customers
      where business_id = p_business_id
        and lower(username) = lower(trim(p_username))
        and pw_hash = p_pw_hash
        and active
      limit 1),
    jsonb_build_object('error', 'Wrong username or password')
  );
$$;
grant execute on function signin_customer(text, text, text) to anon, authenticated;

-- Reset a password using the venue master password. Returns {id, username}.
create or replace function reset_customer_password(
  p_business_id  text,
  p_username     text,
  p_master_hash  text,
  p_new_pw_hash  text
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_master text; v_id uuid; v_uname text;
begin
  select customer_master_hash into v_master from businesses where id = p_business_id;
  if v_master is null or v_master <> p_master_hash then
    return jsonb_build_object('error', 'Master password is incorrect — ask staff');
  end if;
  select id, username into v_id, v_uname from customers
   where business_id = p_business_id and lower(username) = lower(trim(p_username)) and active
   limit 1;
  if v_id is null then
    return jsonb_build_object('error', 'No such customer');
  end if;
  update customers set pw_hash = p_new_pw_hash where id = v_id;
  return jsonb_build_object('id', v_id, 'username', v_uname);
end $$;
grant execute on function reset_customer_password(text, text, text, text) to anon, authenticated;
