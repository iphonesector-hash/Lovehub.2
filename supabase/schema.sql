-- ============================================================
-- LoveHub Games — Supabase Database Schema (Phase 1)
-- Run this in: Supabase Dashboard → SQL Editor → New query → Run
-- ============================================================

-- ------------------------------------------------------------
-- 1. PROFILES (extends built-in auth.users)
-- ------------------------------------------------------------
create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  username text unique not null,
  display_name text not null,
  avatar_url text,
  bio text,
  level int not null default 1,
  xp int not null default 0,
  coins int not null default 100,
  language text not null default 'en' check (language in ('en','fa')),
  status text not null default 'offline' check (status in ('online','offline','in_game')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index profiles_username_idx on public.profiles (username);

-- Player stats (1 row per profile)
create table public.player_stats (
  profile_id uuid primary key references public.profiles(id) on delete cascade,
  games_played int not null default 0,
  wins int not null default 0,
  losses int not null default 0,
  draws int not null default 0,
  updated_at timestamptz not null default now()
);

-- ------------------------------------------------------------
-- 2. FRIENDS
-- ------------------------------------------------------------
create table public.friendships (
  id uuid primary key default gen_random_uuid(),
  requester_id uuid not null references public.profiles(id) on delete cascade,
  addressee_id uuid not null references public.profiles(id) on delete cascade,
  status text not null default 'pending' check (status in ('pending','accepted','blocked')),
  created_at timestamptz not null default now(),
  responded_at timestamptz,
  unique (requester_id, addressee_id)
);

create index friendships_requester_idx on public.friendships (requester_id);
create index friendships_addressee_idx on public.friendships (addressee_id);

-- ------------------------------------------------------------
-- 3. GAMES CATALOG (static-ish reference table)
-- ------------------------------------------------------------
create table public.games (
  id text primary key,               -- e.g. 'tic_tac_toe'
  name_en text not null,
  name_fa text not null,
  category text not null,            -- action, board, puzzle, social, casual
  min_players int not null default 2,
  max_players int not null default 2,
  is_active boolean not null default true
);

-- ------------------------------------------------------------
-- 4. ROOMS & MATCHMAKING
-- ------------------------------------------------------------
create table public.game_rooms (
  id uuid primary key default gen_random_uuid(),
  game_id text not null references public.games(id),
  room_code text unique,             -- for private rooms
  status text not null default 'waiting' check (status in ('waiting','active','finished','cancelled')),
  is_private boolean not null default false,
  created_by uuid references public.profiles(id),
  created_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz
);

create table public.room_players (
  room_id uuid not null references public.game_rooms(id) on delete cascade,
  profile_id uuid not null references public.profiles(id) on delete cascade,
  joined_at timestamptz not null default now(),
  is_ready boolean not null default false,
  primary key (room_id, profile_id)
);

-- ------------------------------------------------------------
-- 5. MATCH HISTORY / RESULTS
-- ------------------------------------------------------------
create table public.matches (
  id uuid primary key default gen_random_uuid(),
  room_id uuid references public.game_rooms(id),
  game_id text not null references public.games(id),
  started_at timestamptz not null default now(),
  ended_at timestamptz,
  winner_id uuid references public.profiles(id)
);

create table public.match_players (
  match_id uuid not null references public.matches(id) on delete cascade,
  profile_id uuid not null references public.profiles(id) on delete cascade,
  result text check (result in ('win','loss','draw')),
  score int default 0,
  xp_earned int default 0,
  coins_earned int default 0,
  primary key (match_id, profile_id)
);

-- ------------------------------------------------------------
-- 6. ECONOMY (coin ledger — every earn/spend is a row, auditable)
-- ------------------------------------------------------------
create table public.coin_transactions (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references public.profiles(id) on delete cascade,
  amount int not null,               -- positive = earn, negative = spend
  reason text not null,              -- 'daily_login','match_win','shop_purchase', etc.
  created_at timestamptz not null default now()
);

create table public.shop_items (
  id uuid primary key default gen_random_uuid(),
  name_en text not null,
  name_fa text not null,
  category text not null,            -- avatar_skin, profile_deco, theme, effect
  price int not null,
  asset_url text,
  is_active boolean not null default true
);

create table public.owned_items (
  profile_id uuid not null references public.profiles(id) on delete cascade,
  item_id uuid not null references public.shop_items(id) on delete cascade,
  acquired_at timestamptz not null default now(),
  equipped boolean not null default false,
  primary key (profile_id, item_id)
);

-- ------------------------------------------------------------
-- 7. ACHIEVEMENTS
-- ------------------------------------------------------------
create table public.achievements (
  id text primary key,               -- e.g. 'first_win'
  name_en text not null,
  name_fa text not null,
  description_en text,
  description_fa text,
  icon text
);

create table public.player_achievements (
  profile_id uuid not null references public.profiles(id) on delete cascade,
  achievement_id text not null references public.achievements(id) on delete cascade,
  unlocked_at timestamptz not null default now(),
  primary key (profile_id, achievement_id)
);

-- ------------------------------------------------------------
-- 8. LEADERBOARDS (materialized via view, refreshed by query)
-- ------------------------------------------------------------
create view public.leaderboard_global as
select p.id as profile_id, p.username, p.display_name, p.avatar_url, p.level,
       s.wins, s.games_played,
       rank() over (order by s.wins desc, s.games_played asc) as rank
from public.profiles p
join public.player_stats s on s.profile_id = p.id
order by s.wins desc;

-- ------------------------------------------------------------
-- 9. ROW LEVEL SECURITY
-- ------------------------------------------------------------
alter table public.profiles enable row level security;
alter table public.player_stats enable row level security;
alter table public.friendships enable row level security;
alter table public.game_rooms enable row level security;
alter table public.room_players enable row level security;
alter table public.matches enable row level security;
alter table public.match_players enable row level security;
alter table public.coin_transactions enable row level security;
alter table public.owned_items enable row level security;
alter table public.player_achievements enable row level security;

-- Profiles: everyone can read (needed for leaderboards/friends search), only owner can update
create policy "profiles_select_all" on public.profiles for select using (true);
create policy "profiles_update_own" on public.profiles for update using (auth.uid() = id);
create policy "profiles_insert_own" on public.profiles for insert with check (auth.uid() = id);

-- Stats: readable by all, writable only via server logic (service role) — no direct client writes
create policy "stats_select_all" on public.player_stats for select using (true);

-- Friendships: only involved users can see/manage
create policy "friendships_select_own" on public.friendships
  for select using (auth.uid() = requester_id or auth.uid() = addressee_id);
create policy "friendships_insert_own" on public.friendships
  for insert with check (auth.uid() = requester_id);
create policy "friendships_update_own" on public.friendships
  for update using (auth.uid() = requester_id or auth.uid() = addressee_id);

-- Rooms: readable by all (for public matchmaking lists), players manage their own rows
create policy "rooms_select_all" on public.game_rooms for select using (true);
create policy "rooms_insert_auth" on public.game_rooms for insert with check (auth.uid() = created_by);
create policy "room_players_select_all" on public.room_players for select using (true);
create policy "room_players_insert_own" on public.room_players for insert with check (auth.uid() = profile_id);

-- Matches/history: readable by all (for profile stats pages)
create policy "matches_select_all" on public.matches for select using (true);
create policy "match_players_select_all" on public.match_players for select using (true);

-- Coins & items: only the owner can see their own transactions/items
create policy "coins_select_own" on public.coin_transactions for select using (auth.uid() = profile_id);
create policy "items_select_own" on public.owned_items for select using (auth.uid() = profile_id);

-- Achievements: readable by all
create policy "player_achievements_select_all" on public.player_achievements for select using (true);

-- ------------------------------------------------------------
-- 10. AUTO-CREATE PROFILE + STATS ON SIGNUP
-- ------------------------------------------------------------
create or replace function public.handle_new_user()
returns trigger as $$
begin
  insert into public.profiles (id, username, display_name)
  values (new.id, coalesce(new.raw_user_meta_data->>'username', split_part(new.email,'@',1)),
          coalesce(new.raw_user_meta_data->>'display_name', split_part(new.email,'@',1)));
  insert into public.player_stats (profile_id) values (new.id);
  return new;
end;
$$ language plpgsql security definer;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ------------------------------------------------------------
-- 11. SEED: initial games catalog (bilingual)
-- ------------------------------------------------------------
insert into public.games (id, name_en, name_fa, category, min_players, max_players) values
  ('tic_tac_toe',   'Tic Tac Toe',    'دوز',           'puzzle', 2, 2),
  ('connect_four',  'Connect Four',   'چهار در ردیف',   'board',  2, 2),
  ('chess',         'Chess',          'شطرنج',         'board',  2, 2),
  ('uno',           'UNO',            'اونو',           'social', 2, 4);
