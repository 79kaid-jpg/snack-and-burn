-- Snack & Burn – Supabase schema
-- Run this once in Supabase: SQL Editor → New query → paste → Run.

create extension if not exists pgcrypto with schema extensions;

-- ---------- Profiles ----------
create table if not exists public.profiles (
  id uuid primary key references auth.users on delete cascade,
  display_name text not null default 'Runner',
  sex text not null default 'male' check (sex in ('male','female')),
  age int not null default 30 check (age between 10 and 100),
  height_cm numeric not null default 170 check (height_cm between 100 and 250),
  weight_kg numeric not null default 65 check (weight_kg between 30 and 300),
  activity numeric not null default 1.375 check (activity between 1.2 and 1.9),
  budget_kcal int not null default 2000,
  visibility text not null default 'friends' check (visibility in ('everyone','friends','off')),
  serious_mode boolean not null default false,
  invite_code text unique not null default substr(encode(extensions.gen_random_bytes(6),'hex'),1,8),
  onboarded boolean not null default false,
  lat numeric,           -- rounded to ~100 m, never exact
  lng numeric,
  location_at timestamptz,
  created_at timestamptz not null default now()
);

-- Create a profile automatically on sign-up
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, display_name)
  values (new.id, coalesce(split_part(new.email,'@',1),'Runner'))
  on conflict do nothing;
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
for each row execute function public.handle_new_user();

-- ---------- Meals (Snack) ----------
create table if not exists public.meals (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users on delete cascade default auth.uid(),
  name text not null,
  kcal int not null check (kcal >= 0),
  items jsonb not null default '[]',
  eaten_at timestamptz not null default now()
);
create index if not exists meals_user_time on public.meals (user_id, eaten_at);

-- ---------- Activities (Burn) ----------
create table if not exists public.activities (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users on delete cascade default auth.uid(),
  kind text not null check (kind in ('run','walk','rope','cycle','other')),
  distance_km numeric not null default 0,
  minutes int not null default 0,
  kcal int not null check (kcal >= 0),
  source text not null default 'manual',
  started_at timestamptz not null default now()
);
create index if not exists activities_user_time on public.activities (user_id, started_at);

-- ---------- Friends ----------
create table if not exists public.friendships (
  user_id uuid not null references auth.users on delete cascade,
  friend_id uuid not null references auth.users on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, friend_id),
  check (user_id <> friend_id)
);

create or replace function public.is_friend(a uuid, b uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from friendships where user_id = a and friend_id = b);
$$;

-- ---------- Challenges ----------
create table if not exists public.challenges (
  id uuid primary key default gen_random_uuid(),
  creator uuid not null references auth.users on delete cascade default auth.uid(),
  name text not null,
  metric text not null check (metric in ('km','kcal')),
  starts_at timestamptz not null default now(),
  ends_at timestamptz not null,
  created_at timestamptz not null default now(),
  check (ends_at > starts_at)
);

create table if not exists public.challenge_members (
  challenge_id uuid not null references public.challenges on delete cascade,
  user_id uuid not null references auth.users on delete cascade,
  primary key (challenge_id, user_id)
);

create or replace function public.is_member(cid uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from challenge_members where challenge_id = cid and user_id = auth.uid());
$$;

-- ---------- Row Level Security ----------
alter table public.profiles enable row level security;
alter table public.meals enable row level security;
alter table public.activities enable row level security;
alter table public.friendships enable row level security;
alter table public.challenges enable row level security;
alter table public.challenge_members enable row level security;

drop policy if exists "own profile read" on public.profiles;
create policy "own profile read" on public.profiles for select
  using (id = auth.uid() or public.is_friend(auth.uid(), id));
drop policy if exists "own profile update" on public.profiles;
create policy "own profile update" on public.profiles for update using (id = auth.uid());

drop policy if exists "own meals" on public.meals;
create policy "own meals" on public.meals for all using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists "own activities" on public.activities;
create policy "own activities" on public.activities for all using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists "own friendships" on public.friendships;
create policy "own friendships" on public.friendships for select using (user_id = auth.uid());
drop policy if exists "remove friendship" on public.friendships;
create policy "remove friendship" on public.friendships for delete using (user_id = auth.uid());

drop policy if exists "challenge read" on public.challenges;
create policy "challenge read" on public.challenges for select using (public.is_member(id) or creator = auth.uid());
drop policy if exists "challenge create" on public.challenges;
create policy "challenge create" on public.challenges for insert with check (creator = auth.uid());

drop policy if exists "members read" on public.challenge_members;
create policy "members read" on public.challenge_members for select using (public.is_member(challenge_id));

-- Hide location columns from everyone except the owner (friends read profiles)
revoke select, update, insert, delete on public.profiles from authenticated, anon;
grant select (id, display_name, sex, age, height_cm, weight_kg, activity, budget_kcal,
  visibility, serious_mode, invite_code, onboarded, created_at) on public.profiles to authenticated;
grant update (display_name, sex, age, height_cm, weight_kg, activity, budget_kcal,
  visibility, serious_mode, onboarded) on public.profiles to authenticated;

-- ---------- Functions (RPC) ----------

-- Add a friend by their invite code (creates the friendship both ways)
create or replace function public.add_friend_by_code(code text) returns uuid
language plpgsql security definer set search_path = public as $$
declare fid uuid;
begin
  select id into fid from profiles where invite_code = lower(trim(code));
  if fid is null then raise exception 'Invite code not found'; end if;
  if fid = auth.uid() then raise exception 'That is your own code'; end if;
  insert into friendships values (auth.uid(), fid, now()), (fid, auth.uid(), now()) on conflict do nothing;
  return fid;
end $$;

-- Add a friend by id (used from the Nearby list)
create or replace function public.add_friend(fid uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  if fid = auth.uid() then raise exception 'Cannot add yourself'; end if;
  insert into friendships values (auth.uid(), fid, now()), (fid, auth.uid(), now()) on conflict do nothing;
end $$;

-- Save my approximate location (rounded to ~100 m)
create or replace function public.update_location(p_lat numeric, p_lng numeric) returns void
language sql security definer set search_path = public as $$
  update profiles set lat = round(p_lat, 3), lng = round(p_lng, 3), location_at = now() where id = auth.uid();
$$;

-- People within 2 km who chose to be visible to me (everyone, or friends-only and we are friends)
create or replace function public.nearby_users(radius_km numeric default 2)
returns table (id uuid, display_name text, distance_km numeric, is_friend boolean)
language sql stable security definer set search_path = public as $$
  with me as (select lat, lng from profiles where id = auth.uid() and lat is not null)
  select p.id, p.display_name,
    round((6371 * 2 * asin(sqrt(
      power(sin(radians(p.lat - me.lat) / 2), 2) +
      cos(radians(me.lat)) * cos(radians(p.lat)) * power(sin(radians(p.lng - me.lng) / 2), 2)
    )))::numeric, 1) as distance_km,
    public.is_friend(auth.uid(), p.id)
  from profiles p, me
  where p.id <> auth.uid()
    and p.lat is not null
    and p.location_at > now() - interval '7 days'
    and (p.visibility = 'everyone' or (p.visibility = 'friends' and public.is_friend(auth.uid(), p.id)))
    and 6371 * 2 * asin(sqrt(
      power(sin(radians(p.lat - me.lat) / 2), 2) +
      cos(radians(me.lat)) * cos(radians(p.lat)) * power(sin(radians(p.lng - me.lng) / 2), 2)
    )) <= radius_km
  order by distance_km
  limit 50;
$$;

-- My friends with this week's totals
create or replace function public.friends_week()
returns table (id uuid, display_name text, km numeric, kcal bigint)
language sql stable security definer set search_path = public as $$
  select p.id, p.display_name,
    coalesce(sum(a.distance_km) filter (where a.kind = 'run'), 0),
    coalesce(sum(a.kcal), 0)
  from friendships f
  join profiles p on p.id = f.friend_id
  left join activities a on a.user_id = p.id and a.started_at >= date_trunc('week', now())
  where f.user_id = auth.uid()
  group by p.id, p.display_name
  order by 3 desc;
$$;

-- Create a challenge and invite friends in one call
create or replace function public.create_challenge(p_name text, p_metric text, p_starts timestamptz, p_ends timestamptz, p_members uuid[])
returns uuid
language plpgsql security definer set search_path = public as $$
declare cid uuid; m uuid;
begin
  insert into challenges (creator, name, metric, starts_at, ends_at)
  values (auth.uid(), p_name, p_metric, p_starts, p_ends) returning id into cid;
  insert into challenge_members values (cid, auth.uid());
  foreach m in array coalesce(p_members, '{}') loop
    if public.is_friend(auth.uid(), m) then
      insert into challenge_members values (cid, m) on conflict do nothing;
    end if;
  end loop;
  return cid;
end $$;

-- Leaderboard for a challenge I am in
create or replace function public.challenge_leaderboard(cid uuid)
returns table (user_id uuid, display_name text, score numeric)
language sql stable security definer set search_path = public as $$
  select p.id, p.display_name,
    case when c.metric = 'km'
      then coalesce(sum(a.distance_km) filter (where a.kind = 'run'), 0)
      else coalesce(sum(a.kcal), 0) end as score
  from challenges c
  join challenge_members cm on cm.challenge_id = c.id
  join profiles p on p.id = cm.user_id
  left join activities a on a.user_id = p.id and a.started_at between c.starts_at and c.ends_at
  where c.id = cid and public.is_member(cid)
  group by p.id, p.display_name, c.metric
  order by score desc;
$$;

-- Streak: consecutive days (up to today) with at least one meal or activity logged
create or replace function public.my_streak() returns int
language plpgsql stable security definer set search_path = public as $$
declare d date := current_date; n int := 0;
begin
  loop
    exit when not exists (
      select 1 from meals where user_id = auth.uid() and eaten_at::date = d
      union all
      select 1 from activities where user_id = auth.uid() and started_at::date = d);
    n := n + 1; d := d - 1;
  end loop;
  return n;
end $$;

-- Badges earned
create or replace function public.my_badges()
returns table (total_km numeric, challenge_wins int, streak int)
language sql stable security definer set search_path = public as $$
  select
    (select coalesce(sum(distance_km),0) from activities where user_id = auth.uid() and kind = 'run'),
    (select count(*)::int from challenges c where c.ends_at < now() and public.is_member(c.id)
       and (select l.user_id from public.challenge_leaderboard(c.id) l limit 1) = auth.uid()),
    public.my_streak();
$$;

-- Only signed-in users may call the app functions
revoke execute on function public.handle_new_user() from anon, authenticated, public;
do $$
declare f text;
begin
  foreach f in array array['add_friend(uuid)','add_friend_by_code(text)','challenge_leaderboard(uuid)',
    'create_challenge(text,text,timestamptz,timestamptz,uuid[])','friends_week()','is_friend(uuid,uuid)',
    'is_member(uuid)','my_badges()','my_streak()','nearby_users(numeric)','update_location(numeric,numeric)'] loop
    execute format('revoke execute on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
end $$;
