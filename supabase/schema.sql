-- =========================================================
-- SplitEasy — Supabase schema (schema "billsplit" in OneDB)
-- 1. Run OneDB/platform.sql first (shared profiles + helpers).
-- 2. Run this file in Supabase Dashboard → SQL Editor → New query.
-- 3. Add "billsplit" under Project Settings → Data API → Exposed schemas.
-- Safe to re-run: it drops and recreates functions/policies/triggers,
-- and only creates tables that don't exist yet.
-- =========================================================

create extension if not exists pgcrypto with schema extensions;

create schema if not exists billsplit;
grant usage on schema billsplit to anon, authenticated, service_role;

-- ---------- Tables ----------

-- Profiles live in public.profiles (shared by all OneDB apps). This view lets
-- the app read/update them as "profiles" and embed them in queries;
-- security_invoker keeps public.profiles' row level security in force.
create or replace view billsplit.profiles with (security_invoker = true) as
  select id, display_name, email, avatar_url, created_at from public.profiles;

-- A split = one trip / party / group. "members" are the people expenses are
-- split between (plain names: they don't need an account).
create table if not exists billsplit.splits (
  id              uuid primary key default gen_random_uuid(),
  name            text not null check (char_length(name) between 1 and 80),
  type            text not null default 'Travel',
  currency        text not null default '₹',
  location        text not null default '',
  geo_lat         double precision,
  geo_lng         double precision,
  members         text[] not null default '{}',
  pay_modes       text[] not null default '{Cash,UPI,Card,"Bank transfer"}',
  share_code      text not null unique default encode(extensions.gen_random_bytes(9), 'hex'),
  created_by      uuid references auth.users(id) on delete set null default auth.uid(),
  created_by_name text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  updated_by      text
);
-- Email per person in a split: { "Rahul": { "email": "rahul@gmail.com" } }. Used to share the
-- split with them and to show their real name + photo once they sign in with that email.
alter table billsplit.splits add column if not exists people jsonb not null default '{}'::jsonb;

-- Accounts that can see and edit a split (people it was shared with).
create table if not exists billsplit.split_members (
  split_id  uuid not null references billsplit.splits(id) on delete cascade,
  user_id   uuid not null references public.profiles(id) on delete cascade,
  role      text not null default 'editor' check (role in ('owner', 'editor')),
  joined_at timestamptz not null default now(),
  primary key (split_id, user_id)
);
create index if not exists split_members_user_idx on billsplit.split_members(user_id);

-- Email invites for people who haven't signed up yet; claimed on their first login.
create table if not exists billsplit.split_invites (
  split_id   uuid not null references billsplit.splits(id) on delete cascade,
  email      text not null check (email = lower(email)),
  invited_by uuid references auth.users(id) on delete set null default auth.uid(),
  created_at timestamptz not null default now(),
  primary key (split_id, email)
);

create table if not exists billsplit.entries (
  id            uuid primary key default gen_random_uuid(),
  split_id      uuid not null references billsplit.splits(id) on delete cascade,
  occurred_at   timestamp not null default now(),         -- local wall-clock time as entered
  amount        numeric(12,2) not null check (amount > 0),
  sign          smallint not null default -1 check (sign in (-1, 1)),  -- -1 expense, +1 received
  purpose       text not null check (char_length(purpose) between 1 and 80),
  pay_via       text not null default '',
  paid_by       text not null,
  location      text not null default '',
  geo_lat       double precision,
  geo_lng       double precision,
  note          text not null default '',
  split_among   text[] not null default '{}',
  added_by      text,
  added_by_user uuid references auth.users(id) on delete set null default auth.uid(),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  updated_by    text
);
create index if not exists entries_split_idx on billsplit.entries(split_id);

grant select, insert, update, delete on all tables in schema billsplit to authenticated, service_role;

-- ---------- Helpers ----------

create or replace function billsplit.is_split_member(p_split uuid)
returns boolean language sql stable security definer set search_path = billsplit as $$
  select exists (select 1 from billsplit.split_members where split_id = p_split and user_id = auth.uid());
$$;

create or replace function billsplit.is_split_owner(p_split uuid)
returns boolean language sql stable security definer set search_path = billsplit as $$
  select exists (select 1 from billsplit.split_members where split_id = p_split and user_id = auth.uid() and role = 'owner');
$$;

-- Remove duplicates from a text array, keeping first-seen order.
create or replace function billsplit.dedupe_text(arr text[])
returns text[] language sql immutable as $$
  select coalesce(array_agg(v order by first_pos), '{}')
  from (select v, min(pos) as first_pos from unnest(arr) with ordinality as t(v, pos) group by v) d;
$$;

-- ---------- Triggers ----------
-- (New-user profiles are created by OneDB/platform.sql.)

-- The creator of a split becomes its owner.
create or replace function billsplit.handle_new_split()
returns trigger language plpgsql security definer set search_path = billsplit as $$
begin
  if new.created_by is not null then
    insert into billsplit.split_members (split_id, user_id, role) values (new.id, new.created_by, 'owner')
    on conflict do nothing;
  end if;
  return new;
end $$;
drop trigger if exists on_split_created on billsplit.splits;
create trigger on_split_created after insert on billsplit.splits
  for each row execute function billsplit.handle_new_split();

drop trigger if exists splits_touch on billsplit.splits;
create trigger splits_touch before update on billsplit.splits
  for each row execute function public.touch_updated_at();
drop trigger if exists entries_touch on billsplit.entries;
create trigger entries_touch before update on billsplit.entries
  for each row execute function public.touch_updated_at();

-- Any change to an entry bumps its split, so lists sort by latest activity.
create or replace function billsplit.bump_split()
returns trigger language plpgsql security definer set search_path = billsplit as $$
begin
  update billsplit.splits set updated_at = now() where id = coalesce(new.split_id, old.split_id);
  return null;
end $$;
drop trigger if exists entries_bump_split on billsplit.entries;
create trigger entries_bump_split after insert or update or delete on billsplit.entries
  for each row execute function billsplit.bump_split();

-- ---------- Row level security ----------

alter table billsplit.splits        enable row level security;
alter table billsplit.split_members enable row level security;
alter table billsplit.split_invites enable row level security;
alter table billsplit.entries       enable row level security;

-- Shared profiles: also see the name and photo of anyone you share a split with.
-- (Your own profile is already visible through OneDB/platform.sql.)
create or replace function billsplit.shares_split_with(p_user uuid)
returns boolean language sql stable security definer set search_path = billsplit as $$
  select exists (
    select 1 from billsplit.split_members a join billsplit.split_members b on a.split_id = b.split_id
    where a.user_id = auth.uid() and b.user_id = p_user);
$$;
drop policy if exists profiles_select_billsplit on public.profiles;
create policy profiles_select_billsplit on public.profiles for select to authenticated
  using (billsplit.shares_split_with(id));

-- splits
drop policy if exists splits_select on billsplit.splits;
create policy splits_select on billsplit.splits for select to authenticated
  using (created_by = auth.uid() or billsplit.is_split_member(id));
drop policy if exists splits_insert on billsplit.splits;
create policy splits_insert on billsplit.splits for insert to authenticated
  with check (created_by = auth.uid());
drop policy if exists splits_update on billsplit.splits;
create policy splits_update on billsplit.splits for update to authenticated
  using (billsplit.is_split_member(id)) with check (billsplit.is_split_member(id));
drop policy if exists splits_delete on billsplit.splits;
create policy splits_delete on billsplit.splits for delete to authenticated
  using (billsplit.is_split_owner(id));

-- split_members: visible to fellow members; joining happens via the RPCs below.
-- You can leave a split; the owner can remove others.
drop policy if exists split_members_select on billsplit.split_members;
create policy split_members_select on billsplit.split_members for select to authenticated
  using (billsplit.is_split_member(split_id));
drop policy if exists split_members_delete on billsplit.split_members;
create policy split_members_delete on billsplit.split_members for delete to authenticated
  using ((user_id = auth.uid() and role <> 'owner') or (billsplit.is_split_owner(split_id) and user_id <> auth.uid()));

-- split_invites
drop policy if exists split_invites_select on billsplit.split_invites;
create policy split_invites_select on billsplit.split_invites for select to authenticated
  using (billsplit.is_split_member(split_id));
drop policy if exists split_invites_delete on billsplit.split_invites;
create policy split_invites_delete on billsplit.split_invites for delete to authenticated
  using (billsplit.is_split_member(split_id));

-- entries: any member can read and write
drop policy if exists entries_select on billsplit.entries;
create policy entries_select on billsplit.entries for select to authenticated
  using (billsplit.is_split_member(split_id));
drop policy if exists entries_insert on billsplit.entries;
create policy entries_insert on billsplit.entries for insert to authenticated
  with check (billsplit.is_split_member(split_id));
drop policy if exists entries_update on billsplit.entries;
create policy entries_update on billsplit.entries for update to authenticated
  using (billsplit.is_split_member(split_id)) with check (billsplit.is_split_member(split_id));
drop policy if exists entries_delete on billsplit.entries;
create policy entries_delete on billsplit.entries for delete to authenticated
  using (billsplit.is_split_member(split_id));

-- ---------- RPCs ----------

-- Join a split from a share link.
create or replace function billsplit.join_split(p_code text)
returns uuid language plpgsql security definer set search_path = billsplit as $$
declare v_split uuid;
begin
  if auth.uid() is null then raise exception 'Not signed in'; end if;
  select id into v_split from billsplit.splits where share_code = p_code;
  if v_split is null then raise exception 'Invite link is invalid or was reset'; end if;
  insert into billsplit.split_members (split_id, user_id) values (v_split, auth.uid()) on conflict do nothing;
  return v_split;
end $$;

-- Claim email invites addressed to the signed-in user.
create or replace function billsplit.accept_invites()
returns integer language plpgsql security definer set search_path = billsplit as $$
declare v_email text := lower(auth.jwt() ->> 'email'); v_count integer;
begin
  if auth.uid() is null or v_email is null then return 0; end if;
  insert into billsplit.split_members (split_id, user_id)
    select split_id, auth.uid() from billsplit.split_invites where email = v_email
  on conflict do nothing;
  get diagnostics v_count = row_count;
  delete from billsplit.split_invites where email = v_email;
  return v_count;
end $$;

-- Share with someone by email: added right away if they have an account,
-- otherwise invited and added when they first sign in.
create or replace function billsplit.invite_to_split(p_split uuid, p_email text)
returns text language plpgsql security definer set search_path = billsplit as $$
declare v_email text := lower(trim(p_email)); v_user uuid;
begin
  if not billsplit.is_split_member(p_split) then raise exception 'Not allowed'; end if;
  if v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then raise exception 'Invalid email'; end if;
  select id into v_user from public.profiles where email = v_email;
  if v_user is not null then
    insert into billsplit.split_members (split_id, user_id) values (p_split, v_user) on conflict do nothing;
    return 'added';
  end if;
  insert into billsplit.split_invites (split_id, email) values (p_split, v_email) on conflict do nothing;
  return 'invited';
end $$;

-- New share code; old invite links stop working.
create or replace function billsplit.reset_share_code(p_split uuid)
returns text language plpgsql security definer set search_path = billsplit as $$
declare v_code text := encode(extensions.gen_random_bytes(9), 'hex');
begin
  if not billsplit.is_split_owner(p_split) then raise exception 'Only the owner can reset the link'; end if;
  update billsplit.splits set share_code = v_code where id = p_split;
  return v_code;
end $$;

-- People (names in the split) — done server-side so concurrent edits don't clobber each other.
create or replace function billsplit.add_person(p_split uuid, p_name text)
returns text[] language plpgsql security definer set search_path = billsplit as $$
declare v_members text[];
begin
  if not billsplit.is_split_member(p_split) then raise exception 'Not allowed'; end if;
  update billsplit.splits
     set members = case when exists (select 1 from unnest(members) m where lower(m) = lower(p_name))
                        then members else array_append(members, p_name) end
   where id = p_split
  returning members into v_members;
  return v_members;
end $$;

create or replace function billsplit.rename_person(p_split uuid, p_old text, p_new text)
returns text[] language plpgsql security definer set search_path = billsplit as $$
declare v_members text[];
begin
  if not billsplit.is_split_member(p_split) then raise exception 'Not allowed'; end if;
  update billsplit.entries set paid_by = p_new where split_id = p_split and paid_by = p_old;
  update billsplit.entries set split_among = billsplit.dedupe_text(array_replace(split_among, p_old, p_new))
   where split_id = p_split and p_old = any(split_among);
  update billsplit.splits set members = billsplit.dedupe_text(array_replace(members, p_old, p_new))
   where id = p_split
  returning members into v_members;
  return v_members;
end $$;

create or replace function billsplit.remove_person(p_split uuid, p_name text)
returns text[] language plpgsql security definer set search_path = billsplit as $$
declare v_members text[];
begin
  if not billsplit.is_split_member(p_split) then raise exception 'Not allowed'; end if;
  if exists (select 1 from billsplit.entries where split_id = p_split and paid_by = p_name) then
    raise exception '% paid for some entries; change "Paid by" on those first', p_name;
  end if;
  update billsplit.entries set split_among = array_remove(split_among, p_name)
   where split_id = p_split and p_name = any(split_among);
  update billsplit.splits set members = array_remove(members, p_name) where id = p_split
  returning members into v_members;
  return v_members;
end $$;

-- Look up a OneDB user by exact email (when adding them to a split).
-- Returns only their display name and photo, and only to signed-in users.
create or replace function billsplit.find_user_by_email(p_email text)
returns table(display_name text, avatar_url text)
language sql stable security definer set search_path = billsplit as $$
  select p.display_name, p.avatar_url from public.profiles p
   where auth.uid() is not null and p.email = lower(trim(p_email))
   limit 1;
$$;

-- Functions are callable by signed-in users only (helpers are used inside policies).
revoke execute on all functions in schema billsplit from public, anon;
grant execute on all functions in schema billsplit to authenticated, service_role;

-- ---------- Realtime ----------
-- Broadcast changes so everyone on a split sees updates live (RLS still applies).
do $$
declare t text;
begin
  foreach t in array array['splits', 'entries', 'split_members'] loop
    if not exists (select 1 from pg_publication_tables
                   where pubname = 'supabase_realtime' and schemaname = 'billsplit' and tablename = t) then
      execute format('alter publication supabase_realtime add table billsplit.%I', t);
    end if;
  end loop;
end $$;
