-- ============================================================
-- BuddyBoard 2.4.0 — upgrade an EXISTING Supabase project: admin/member roles
-- 1. Change the email at the very bottom to your compagnon's email.
-- 2. Supabase → SQL Editor → New query → paste this whole file → Run.
-- Everyone already on the team stays admin until set to 'member' below.
-- Safe to run more than once. (New projects: use schema.sql instead.)
-- ============================================================

-- Every BuddyBoard item (product, customer, order, purchase, setting) is
-- one row: which list it belongs to ("store"), its id ("key") and its
-- contents as JSON. Deleted items stay as a "deleted" marker so devices
-- that were offline also learn about the delete.
create table if not exists public.records (
  store      text        not null,
  key        text        not null,
  data       jsonb,
  deleted    boolean     not null default false,
  updated_at timestamptz not null default clock_timestamp(),
  primary key (store, key)
);
create index if not exists records_updated_at on public.records (updated_at);

-- The server stamps every change, so devices can ask "what changed since…".
create or replace function public.records_touch() returns trigger
language plpgsql as $$
begin
  new.updated_at := clock_timestamp();
  return new;
end $$;
drop trigger if exists records_touch on public.records;
create trigger records_touch before insert or update on public.records
  for each row execute function public.records_touch();

-- Who may use this BuddyBoard: the email addresses listed in "team".
-- role 'admin' may change everything; 'member' may do the daily work
-- (orders, customers, products, stock, expenses) but not the profit split,
-- payouts, bank balance, receipt footer or paying back expenses.
create table if not exists public.team (email text primary key);
alter table public.team add column if not exists role text not null default 'admin';
do $$
begin
  alter table public.team add constraint team_role_check check (role in ('admin', 'member'));
exception when duplicate_object then null;
end $$;

create or replace function public.is_team() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.team
    where lower(email) = lower(coalesce(auth.jwt() ->> 'email', ''))
  );
$$;

create or replace function public.my_role() returns text
language sql stable security definer set search_path = public as $$
  select role from public.team
  where lower(email) = lower(coalesce(auth.jwt() ->> 'email', ''))
  limit 1;
$$;

create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce(public.my_role() = 'admin', false);
$$;

-- Changes already applied (a phone that lost its connection mid-upload
-- re-sends them; they must not be applied twice).
create table if not exists public.applied_ops (
  op_id      uuid primary key,
  applied_at timestamptz not null default now()
);

alter table public.records     enable row level security;
alter table public.team        enable row level security;
alter table public.applied_ops enable row level security;

-- The team can READ everything. All WRITES go through apply_ops below,
-- which checks who may change what — there is no other way in.
drop policy if exists "team only" on public.records;
drop policy if exists "team can read" on public.records;
create policy "team can read" on public.records
  for select to authenticated using (public.is_team());
drop policy if exists "team only" on public.applied_ops;
-- (team and applied_ops have no policies: not reachable from the app.)

revoke all on public.records, public.applied_ops, public.team from anon, authenticated;
grant select on public.records to authenticated;

-- Settings only an admin may change.
create or replace function public.admin_setting(k text) returns boolean
language sql immutable as $$
  select k in ('erp_split_cfg', 'erp_receipt_footer', 'erp_bank');
$$;

-- Apply a batch of changes from one device in ONE transaction: either
-- all of them land (e.g. an order + its stock deduction) or none do.
-- Stock changes are increments, so two devices changing the same
-- product's stock add up instead of overwriting each other.
create or replace function public.apply_ops(ops jsonb) returns void
language plpgsql security definer set search_path = public as $$
declare
  op jsonb;
  admin boolean := public.is_admin();
  cur jsonb;
begin
  if not public.is_team() then
    raise exception 'not on the BuddyBoard team' using errcode = '42501';
  end if;
  for op in select * from jsonb_array_elements(ops) loop
    if not admin then
      if op ->> 'store' = 'payouts'
         or (op ->> 'store' = 'settings' and public.admin_setting(op ->> 'key')) then
        raise exception 'admin only: %', coalesce(op ->> 'key', op ->> 'store') using errcode = '42501';
      end if;
      -- Members may not mark an expense as paid back.
      if op ->> 'store' = 'purchases' and op ->> 't' = 'upsert'
         and coalesce((op -> 'data' ->> 'reimbursed')::boolean, false) then
        select data into cur from records where store = 'purchases' and key = op ->> 'key' and not deleted;
        if not coalesce((cur ->> 'reimbursed')::boolean, false) then
          raise exception 'admin only: pay back' using errcode = '42501';
        end if;
      end if;
    end if;

    insert into applied_ops (op_id) values ((op ->> 'opId')::uuid) on conflict do nothing;
    if not found then continue; end if;  -- already applied earlier

    if op ->> 't' = 'upsert' then
      insert into records (store, key, data, deleted)
        values (op ->> 'store', op ->> 'key', op -> 'data', false)
        on conflict (store, key) do update set data = excluded.data, deleted = false;
    elsif op ->> 't' = 'delete' then
      insert into records (store, key, data, deleted)
        values (op ->> 'store', op ->> 'key', null, true)
        on conflict (store, key) do update set data = null, deleted = true;
    elsif op ->> 't' = 'stock' then
      update records
        set data = jsonb_set(data, '{stock}',
          to_jsonb(coalesce((data ->> 'stock')::numeric, 0) + (op ->> 'delta')::numeric))
        where store = 'products' and key = op ->> 'key' and not deleted;
    else
      raise exception 'unknown op %', op ->> 't';
    end if;
  end loop;
end $$;

revoke all on function public.apply_ops(jsonb) from public, anon;
grant execute on function public.apply_ops(jsonb) to authenticated;
revoke all on function public.is_team() from public, anon;
grant execute on function public.is_team() to authenticated;
revoke all on function public.my_role() from public, anon;
grant execute on function public.my_role() to authenticated;
revoke all on function public.is_admin() from public, anon;
grant execute on function public.is_admin() to authenticated;

-- Live updates to every signed-in device.
do $$
begin
  alter publication supabase_realtime add table public.records;
exception when duplicate_object then null;
end $$;

-- ------------------------------------------------------------
-- Who is a member (daily work only)? Put your compagnon's email here.
-- ------------------------------------------------------------
update public.team set role = 'member' where lower(email) = lower('compagnon@example.com');

-- Check the result (shows each email with its role):
select email, role from public.team order by role, email;
