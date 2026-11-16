-- ============================================================================
-- Migration 021 — radio playlists that update themselves once a day
-- Safe on live data: ADDS three nullable columns to music_playlists and one
-- function; no row is changed. Run once in Supabase → SQL Editor, after
-- migrations 018–020 (running it again does nothing new / just replaces the
-- function).
--
-- "Salva radio come playlist" (song menu) saves a song's radio (the longest
-- one YouTube gives) as a team playlist and remembers where it came from:
--   radio_seed          the seed song's YouTube video id (null = an ordinary
--                       playlist, or a radio playlist whose songs someone
--                       edited by hand, which stops the auto-update)
--   radio_title         the seed song's title, shown in the playlist header
--   radio_refreshed_at  when the radio was last checked (ms since 1970,
--                       database clock)
--
-- Once a day a team browser that has the playlists open asks YouTube for the
-- radio again and calls music_playlist_radio_refresh: with the new songs if
-- they changed, or with p_tracks null to stamp the check only. The function
-- updates the row only if it is still a radio playlist AND its last check is
-- older than p_stale_ms, so two browsers refreshing at the same moment can't
-- both write: the second gets no row back and stops.
--
-- It runs with the caller's rights (security invoker), so the team-only access
-- rule on public.music_playlists (migrations 012 / 018) still applies. The
-- app works before this runs: a radio is saved as an ordinary playlist and the
-- app says that the daily update needs migration 021.
-- ============================================================================

alter table public.music_playlists add column if not exists radio_seed         text   null;
alter table public.music_playlists add column if not exists radio_title        text   null;
alter table public.music_playlists add column if not exists radio_refreshed_at bigint null;

-- Refreshes a radio playlist if it is due. p_tracks null: the songs did not
-- change, only the check is stamped. Returns the row, or nothing when the
-- playlist is gone, is no longer a radio, or was refreshed less than
-- p_stale_ms ago (by another browser).
create or replace function public.music_playlist_radio_refresh(p_id text, p_tracks jsonb, p_stale_ms bigint)
returns setof public.music_playlists
language sql
security invoker
set search_path = ''
as $$
  update public.music_playlists as m
     set tracks = case
           when p_tracks is not null and jsonb_typeof(p_tracks) = 'array' then p_tracks
           else m.tracks
         end,
         radio_refreshed_at = (extract(epoch from clock_timestamp()) * 1000)::bigint,
         updated_at = (extract(epoch from clock_timestamp()) * 1000)::bigint
   where m.id = p_id
     and m.radio_seed is not null
     and (m.radio_refreshed_at is null
          or m.radio_refreshed_at < (extract(epoch from clock_timestamp()) * 1000)::bigint - coalesce(p_stale_ms, 0))
  returning m.*;
$$;

revoke all on function public.music_playlist_radio_refresh(text, jsonb, bigint) from public, anon;
grant execute on function public.music_playlist_radio_refresh(text, jsonb, bigint) to authenticated;
