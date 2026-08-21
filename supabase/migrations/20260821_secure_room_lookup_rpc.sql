-- Secure private-room lookup/join behind an authenticated RPC.
-- Applied to the connected production Supabase project as part of the same change.

create or replace function public.join_room_by_code(p_room_code text)
returns table (
  id uuid,
  game_id text,
  status text,
  is_private boolean,
  player_count bigint
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_room public.game_rooms%rowtype;
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception 'Authentication required';
  end if;

  select * into v_room
  from public.game_rooms
  where room_code = upper(trim(p_room_code))
    and status = 'waiting'
    and is_private = true
  limit 1;

  if not found then
    raise exception 'Room not found';
  end if;

  insert into public.room_players(room_id, profile_id)
  values (v_room.id, v_uid)
  on conflict (room_id, profile_id) do nothing;

  return query
  select v_room.id,
         v_room.game_id,
         v_room.status,
         v_room.is_private,
         (select count(*) from public.room_players rp where rp.room_id = v_room.id);
end;
$$;

revoke all on function public.join_room_by_code(text) from public;
grant execute on function public.join_room_by_code(text) to authenticated;
