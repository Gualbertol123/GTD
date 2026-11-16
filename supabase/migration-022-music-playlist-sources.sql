-- ============================================================================
-- Migration 022 — playlists that remember where they were imported from, and
-- sync with it once a day (plus a "Sincronizza" button)
-- Safe on live data: ADDS five columns to music_playlists (four nullable, one
-- with a default) and one function; no row is changed. Run once in Supabase →
-- SQL Editor, after migrations 018–021 (running it again does nothing new /
-- just replaces the function).
--
-- A playlist imported from Spotify (a playlist or album link, or La mia
-- libreria Spotify: a playlist, an album, the liked songs) or from a YouTube
-- playlist remembers its source:
--   source_kind       'spotify-playlist' | 'spotify-album' | 'spotify-liked' |
--                     'youtube-playlist'; null = an ordinary playlist
--   source_id         the Spotify playlist / album id, the YouTube list id, or
--                     for the liked songs the Spotify user id of whoever
--                     imported them (only their sign-in can read them)
--   source_name       the source's own name, shown in the header
--   source_synced_at  when the source was last checked (ms since 1970,
--                     database clock)
--   source_auto       true: synced automatically once a day. Editing the songs
--                     by hand (add / remove / move) or "Stacca" sets it false:
--                     the source is kept, so "Sincronizza" still works as a
--                     one-off and "Riattiva sync automatica" can turn it on
--                     again. A rename keeps it.
--
-- Once a day a team browser that has the playlists open reads each due source
-- again (the signed-in person's Spotify token, else the server; YouTube for a
-- YouTube list), finds only the NEW songs on YouTube, and calls
-- music_playlist_source_sync: with the new list if it changed, or with
-- p_tracks null to stamp the check only. The function writes only if the row
-- still has a source AND
--   - p_stale_ms > 0 (the daily sync): it is still automatic and its last
--     check is older than p_stale_ms, so two browsers syncing at the same
--     moment can't both write (the second gets no row back and stops);
--   - p_stale_ms <= 0 (the button): always, even when detached.
-- p_expect (optional): the song ids, in order, of the list the sync was
-- planned on; if the row's list differs (a song added, removed or moved by
-- hand while the source was read), nothing is written and the app plans again
-- on the new list (a song added during a sync is never lost).
-- It always stamps source_synced_at with the database clock, and returns the
-- row or nothing, exactly like 021's music_playlist_radio_refresh.
--
-- It runs with the caller's rights (security invoker), so the team-only access
-- rule on public.music_playlists (migrations 012 / 018) still applies. The app
-- works before this runs: an import is saved as an ordinary playlist, the app
-- says the daily sync needs migration 022, and no "Sincronizza" is shown.
-- ============================================================================

alter table public.music_playlists add column if not exists source_kind      text    null;
alter table public.music_playlists add column if not exists source_id        text    null;
alter table public.music_playlists add column if not exists source_name      text    null;
alter table public.music_playlists add column if not exists source_synced_at bigint  null;
alter table public.music_playlists add column if not exists source_auto      boolean not null default true;

-- Syncs an imported playlist if it is due (or always, p_stale_ms <= 0).
-- p_tracks null: the songs did not change, only the check is stamped.
drop function if exists public.music_playlist_source_sync(text, jsonb, bigint);
create or replace function public.music_playlist_source_sync(p_id text, p_tracks jsonb, p_stale_ms bigint, p_expect jsonb default null)
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
         source_synced_at = n.ms,
         updated_at = n.ms
    from (select (extract(epoch from clock_timestamp()) * 1000)::bigint as ms) as n
   where m.id = p_id
     and m.source_kind is not null
     -- The list the sync was planned on (its song ids, in order): changed since, refused.
     and (p_expect is null
          or coalesce((select jsonb_agg(e.v ->> 'id' order by e.o)
                         from jsonb_array_elements(m.tracks) with ordinality as e(v, o)),
                      '[]'::jsonb) = p_expect)
     and (coalesce(p_stale_ms, 0) <= 0
          or (m.source_auto
              and (m.source_synced_at is null or m.source_synced_at < n.ms - p_stale_ms)))
  returning m.*;
$$;

revoke all on function public.music_playlist_source_sync(text, jsonb, bigint, jsonb) from public, anon;
grant execute on function public.music_playlist_source_sync(text, jsonb, bigint, jsonb) to authenticated;
