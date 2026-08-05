-- ============================================================
-- LoveHub — Phase 2, Migration 0002: Couple system foundation
--
-- Secure couple linking (approved design):
--   * Creator creates a couple with the partner's EXACT email and
--     receives a random 8-char invite code.
--   * Partner enters the invite code + their email; the request is
--     only accepted when the email EXACTLY matches (lowercased).
--   * Partner sends a JOIN REQUEST (couple_requests).
--   * Creator must APPROVE. Only then does the couple become
--     'active' and both members become visible to each other.
--   * Both users must have confirmed email addresses.
--
-- No direct client INSERT/UPDATE/DELETE on couple tables: every
-- write goes through the security-definer RPCs below.
-- ============================================================

-- ---------------- tables ----------------

create table if not exists public.couples (
  id uuid primary key default gen_random_uuid(),
  invite_code text unique not null,
  partner_email text not null,          -- lowercased at creation
  status text not null default 'pending' check (status in ('pending','active')),
  created_by uuid not null references public.profiles(id) on delete cascade,
  relationship_started_on date,         -- set when the couple is confirmed
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.couple_members (
  couple_id uuid not null references public.couples(id) on delete cascade,
  profile_id uuid not null references public.profiles(id) on delete cascade,
  role text not null default 'partner' check (role in ('creator','partner')),
  joined_at timestamptz not null default now(),
  primary key (couple_id, profile_id)
);

create table if not exists public.couple_requests (
  id uuid primary key default gen_random_uuid(),
  couple_id uuid not null references public.couples(id) on delete cascade,
  requester_id uuid not null references public.profiles(id) on delete cascade,
  status text not null default 'pending' check (status in ('pending','approved','declined')),
  created_at timestamptz not null default now(),
  responded_at timestamptz,
  unique (couple_id, requester_id)
);

create index if not exists couples_partner_email_idx on public.couples (partner_email);
create index if not exists couple_members_profile_idx on public.couple_members (profile_id);
create index if not exists couple_requests_couple_idx on public.couple_requests (couple_id);
create index if not exists couple_requests_requester_idx on public.couple_requests (requester_id);

-- ---------------- helper functions ----------------

-- Invite-code generator (no 0/O/1/I to avoid confusion when sharing).
create or replace function public.generate_invite_code()
returns text language plpgsql volatile security definer set search_path = public as $$
declare
  chars text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  code text;
  tries int := 0;
begin
  loop
    code := '';
    for i in 1..8 loop
      code := code || substr(chars, floor(random() * length(chars))::int + 1, 1);
    end loop;
    if not exists (select 1 from public.couples where invite_code = code) then
      return code;
    end if;
    tries := tries + 1;
    if tries > 20 then
      raise exception 'Could not generate a unique invite code';
    end if;
  end loop;
end;
$$;

-- Is the account a verified (email-confirmed) Supabase user?
create or replace function public.is_verified_user(uid uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from auth.users u
    where u.id = uid and u.email_confirmed_at is not null
  );
$$;

-- The helper you asked for: membership check used by every RLS policy.
create or replace function public.is_couple_member(uid uuid, cid uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.couple_members cm
    where cm.couple_id = cid and cm.profile_id = uid
  );
$$;

-- Are two users in the SAME ACTIVE couple? Drives profile privacy.
create or replace function public.are_couple_members(uid_a uuid, uid_b uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1
    from public.couple_members cm1
    join public.couple_members cm2 on cm2.couple_id = cm1.couple_id
    join public.couples c on c.id = cm1.couple_id
    where cm1.profile_id = uid_a
      and cm2.profile_id = uid_b
      and c.status = 'active'
  );
$$;

-- ---------------- RLS ----------------

alter table public.couples enable row level security;
alter table public.couple_members enable row level security;
alter table public.couple_requests enable row level security;

-- Couples: only members can read/update. No insert/delete policies —
-- writes happen exclusively through the RPCs below.
create policy "couples_select_members" on public.couples
  for select using (public.is_couple_member(auth.uid(), id));
create policy "couples_update_members" on public.couples
  for update using (public.is_couple_member(auth.uid(), id));

-- Members: only members of that couple can see who is in it.
create policy "couple_members_select_members" on public.couple_members
  for select using (public.is_couple_member(auth.uid(), couple_id));

-- Requests: the requester sees their own; couple members see requests
-- for their couple (only the creator can respond — enforced in the RPC).
create policy "couple_requests_select_own_or_member" on public.couple_requests
  for select using (
    requester_id = auth.uid()
    or public.is_couple_member(auth.uid(), couple_id)
  );

-- ---------------- RPCs (security definer, the only write path) ----------------

-- Creator: start a couple for the partner's exact email.
create or replace function public.create_couple(p_partner_email text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  v_partner text := lower(trim(p_partner_email));
  v_code text;
  v_couple_id uuid;
begin
  if v_uid is null then raise exception 'Not authenticated'; end if;
  if not public.is_verified_user(v_uid) then
    raise exception 'Please confirm your email before creating a couple.';
  end if;
  if v_partner is null or v_partner = '' or position('@' in v_partner) = 0 then
    raise exception 'Please enter a valid partner email.';
  end if;
  if v_partner = (select lower(email) from auth.users where id = v_uid) then
    raise exception 'You cannot pair with yourself.';
  end if;
  if exists (select 1 from public.couple_members where profile_id = v_uid) then
    raise exception 'You already have a couple.';
  end if;

  v_code := public.generate_invite_code();

  insert into public.couples (invite_code, partner_email, status, created_by)
  values (v_code, v_partner, 'pending', v_uid)
  returning id into v_couple_id;

  insert into public.couple_members (couple_id, profile_id, role)
  values (v_couple_id, v_uid, 'creator');

  return jsonb_build_object(
    'id', v_couple_id,
    'invite_code', v_code,
    'partner_email', v_partner,
    'status', 'pending'
  );
end;
$$;

-- Partner: enter code + your email -> creates a pending join request.
-- The error is deliberately generic so codes cannot be probed.
create or replace function public.join_couple(p_invite_code text, p_email text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  v_code text := upper(trim(p_invite_code));
  v_email text := lower(trim(p_email));
  v_couple record;
  v_request_id uuid;
begin
  if v_uid is null then raise exception 'Not authenticated'; end if;
  if not public.is_verified_user(v_uid) then
    raise exception 'Please confirm your email before joining a couple.';
  end if;
  if exists (select 1 from public.couple_members where profile_id = v_uid) then
    raise exception 'You already have a couple.';
  end if;

  select * into v_couple from public.couples
    where invite_code = v_code and status = 'pending'
    limit 1;

  if v_couple.id is null or v_couple.partner_email <> v_email then
    raise exception 'Invalid invite code or email.';
  end if;
  if v_couple.created_by = v_uid then
    raise exception 'This is your own invite code.';
  end if;
  if (select count(*) from public.couple_members where couple_id = v_couple.id) >= 2 then
    raise exception 'This couple is already complete.';
  end if;

  insert into public.couple_requests (couple_id, requester_id, status)
  values (v_couple.id, v_uid, 'pending')
  on conflict (couple_id, requester_id)
  do update set status = 'pending', responded_at = null
  returning id into v_request_id;

  return jsonb_build_object('id', v_request_id, 'couple_id', v_couple.id, 'status', 'pending');
end;
$$;

-- Creator: approve or decline a join request. Approval atomically adds
-- the member and confirms the couple (status -> 'active').
create or replace function public.respond_to_couple_request(p_request_id uuid, p_approve boolean)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  v_req record;
  v_couple record;
begin
  if v_uid is null then raise exception 'Not authenticated'; end if;

  select * into v_req from public.couple_requests where id = p_request_id;
  if v_req.id is null then raise exception 'Request not found.'; end if;

  select * into v_couple from public.couples where id = v_req.couple_id;
  if v_couple.created_by <> v_uid then
    raise exception 'Only the couple creator can respond to requests.';
  end if;
  if v_req.status <> 'pending' then
    raise exception 'This request was already handled.';
  end if;

  if p_approve then
    if not public.is_verified_user(v_req.requester_id) then
      raise exception 'The requester has not confirmed their email.';
    end if;
    if exists (select 1 from public.couple_members where profile_id = v_req.requester_id) then
      raise exception 'The requester already has a couple.';
    end if;
    if (select count(*) from public.couple_members where couple_id = v_couple.id) >= 2 then
      raise exception 'This couple is already complete.';
    end if;

    update public.couple_requests set status = 'approved', responded_at = now()
      where id = p_request_id;
    insert into public.couple_members (couple_id, profile_id, role)
      values (v_couple.id, v_req.requester_id, 'partner');
    update public.couples
      set status = 'active',
          relationship_started_on = coalesce(relationship_started_on, now()::date),
          updated_at = now()
      where id = v_couple.id;
    return jsonb_build_object('approved', true, 'couple_id', v_couple.id);
  else
    update public.couple_requests set status = 'declined', responded_at = now()
      where id = p_request_id;
    return jsonb_build_object('approved', false, 'couple_id', v_couple.id);
  end if;
end;
$$;

-- Creator: cancel a pending couple (before anyone joined).
create or replace function public.cancel_couple(p_couple_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then raise exception 'Not authenticated'; end if;
  if not exists (
    select 1 from public.couples c
    where c.id = p_couple_id and c.created_by = v_uid and c.status = 'pending'
  ) then
    raise exception 'Only the creator can cancel a pending couple.';
  end if;
  delete from public.couples where id = p_couple_id;
end;
$$;

-- Any member can leave; leaving removes the whole couple (both members
-- are free to pair again).
create or replace function public.leave_couple(p_couple_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then raise exception 'Not authenticated'; end if;
  if not public.is_couple_member(v_uid, p_couple_id) then
    raise exception 'You are not a member of this couple.';
  end if;
  delete from public.couples where id = p_couple_id;  -- cascades members + requests
end;
$$;
