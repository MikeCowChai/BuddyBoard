-- ============================================================
-- BuddyBoard 2.7.0 — upgrade an EXISTING Supabase project
-- (needs the 2.4.0 roles upgrade to have been run before)
-- Supabase → SQL Editor → New query → paste this whole file → Run.
-- Safe to run more than once.
--  * members can no longer read the real bank balance
--  * only the admin may change the member start date
--  * members' balance starts at ฿0 on 30 Sep 2026 (Thailand time) unless
--    a start date was already set — the admin can change it in the app
-- ============================================================

create or replace function public.admin_setting(k text) returns boolean
language sql immutable as $$
  select k in ('erp_split_cfg', 'erp_receipt_footer', 'erp_bank', 'erp_member_zero');
$$;

drop policy if exists "team can read" on public.records;
create policy "team can read" on public.records
  for select to authenticated using (
    public.is_team()
    and (public.is_admin() or not (store = 'settings' and key = 'erp_bank'))
  );

insert into public.records (store, key, data, deleted)
values ('settings', 'erp_member_zero',
        to_jsonb(((extract(epoch from timestamptz '2026-09-30 00:00:00+07') * 1000)::bigint)::text), false)
on conflict (store, key) do nothing;

-- Check: the start date as a readable date (Thailand time)
select to_timestamp((data #>> '{}')::bigint / 1000) at time zone 'Asia/Bangkok' as member_balance_starts
from public.records where store = 'settings' and key = 'erp_member_zero';
