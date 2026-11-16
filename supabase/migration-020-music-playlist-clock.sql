-- ============================================================================
-- Migration 020 — playlist changes are stamped by the database clock
-- Safe on live data: ADDS one function and one trigger; no row is changed.
-- Run once in Supabase → SQL Editor, after migration 018 (running it again
-- just replaces both).
--
-- Why: the app keeps a playlist's newest version by comparing updated_at.
-- Before this, some writes (creating, undoing a delete, the pre-019 fallback)
-- stamped it with the browser's clock and the 019 functions with the
-- database's, so a teammate whose computer clock was a minute fast could make
-- everyone else's newer edits look "older" and be ignored until a reload.
-- Now every insert and update gets the database's time, whatever the app
-- sends. On an update the stamp is also always above the row's previous one,
-- so even a row stamped by a fast clock before this ran keeps its order.
-- ============================================================================

create or replace function public.music_playlists_stamp()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  now_ms bigint := (extract(epoch from clock_timestamp()) * 1000)::bigint;
begin
  if tg_op = 'UPDATE' then
    new.updated_at := greatest(now_ms, coalesce(old.updated_at, 0) + 1);
  else
    new.updated_at := now_ms;
  end if;
  return new;
end;
$$;

revoke all on function public.music_playlists_stamp() from public, anon;

drop trigger if exists music_playlists_stamp on public.music_playlists;
create trigger music_playlists_stamp
  before insert or update on public.music_playlists
  for each row execute function public.music_playlists_stamp();
