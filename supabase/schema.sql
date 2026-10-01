-- ============================================================
-- BuddyBoard — Supabase database setup
-- Paste this whole file into Supabase → SQL Editor → New query → Run.
-- Safe to run again (e.g. after editing the team emails at the bottom).
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
create table if not exists public.team (email text primary key);

create or replace function public.is_team() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.team
    where lower(email) = lower(coalesce(auth.jwt() ->> 'email', ''))
  );
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

drop policy if exists "team only" on public.records;
create policy "team only" on public.records
  for all to authenticated using (public.is_team()) with check (public.is_team());
drop policy if exists "team only" on public.applied_ops;
create policy "team only" on public.applied_ops
  for all to authenticated using (public.is_team()) with check (public.is_team());
-- (team has no policies: nobody can read or change it from the app.)

-- Table access for signed-in users (needed when "Automatically expose new
-- tables" is off; row-level security above still decides which rows).
grant select, insert, update, delete on public.records to authenticated;
grant select, insert on public.applied_ops to authenticated;
revoke all on public.records, public.applied_ops, public.team from anon;
revoke all on public.team from authenticated;

-- Apply a batch of changes from one device in ONE transaction: either
-- all of them land (e.g. an order + its stock deduction) or none do.
-- Stock changes are increments, so two devices changing the same
-- product's stock add up instead of overwriting each other.
create or replace function public.apply_ops(ops jsonb) returns void
language plpgsql security invoker set search_path = public as $$
declare
  op jsonb;
begin
  if not public.is_team() then
    raise exception 'not on the BuddyBoard team' using errcode = '42501';
  end if;
  for op in select * from jsonb_array_elements(ops) loop
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

-- Live updates to every signed-in device.
do $$
begin
  alter publication supabase_realtime add table public.records;
exception when duplicate_object then null;
end $$;

-- ------------------------------------------------------------
-- TEAM: put your email addresses here (the same ones you use to
-- sign in), then run this file.
-- ------------------------------------------------------------
insert into public.team (email) values
  ('jij@example.com'),
  ('compagnon@example.com')
on conflict do nothing;
