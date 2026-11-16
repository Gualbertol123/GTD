-- ============================================================================
-- Migration 019 — team playlists are changed one step at a time, in the database
-- Safe on live data: ADDS five functions; no table or row is changed. Run once
-- in Supabase → SQL Editor, after migration 018 (running it again just
-- replaces the functions).
--
-- Why: a playlist's songs are one jsonb array. Before this, the app rebuilt
-- the whole array from what the editing browser had in memory and saved all
-- of it, so two people adding or reordering songs in the same playlist within
-- a few seconds could silently lose a song. These functions change only what
-- they are asked about, against the row as it is in the database at that
-- moment, so concurrent edits all survive. Each one stamps updated_at and
-- returns the changed row (no row: the playlist no longer exists).
--
-- They run with the caller's rights (security invoker), so the team-only
-- access rule on public.music_playlists (migrations 012 / 018) still applies
-- to every call. The app works before this runs: it falls back to the old
-- whole-array write. A track is { id, title, channel, thumb }; a song is in a
-- playlist at most once (matched by id).
-- ============================================================================

-- Adds songs at the end; songs already in the playlist are skipped.
create or replace function public.music_playlist_append(p_id text, p_tracks jsonb)
returns setof public.music_playlists
language sql
security invoker
set search_path = ''
as $$
  update public.music_playlists as m
     set tracks = m.tracks || coalesce((
           select jsonb_agg(x.t order by x.ord)
             from jsonb_array_elements(
                    case when jsonb_typeof(p_tracks) = 'array' then p_tracks else '[]'::jsonb end
                  ) with ordinality as x(t, ord)
            where x.t->>'id' is not null
              and not exists (select 1 from jsonb_array_elements(m.tracks) e where e->>'id' = x.t->>'id')
              -- the same song twice in one call: keep the first
              and not exists (
                select 1 from jsonb_array_elements(p_tracks) with ordinality as y(t, ord)
                 where y.t->>'id' = x.t->>'id' and y.ord < x.ord
              )
         ), '[]'::jsonb),
         updated_at = (extract(epoch from clock_timestamp()) * 1000)::bigint
   where m.id = p_id
  returning m.*;
$$;

-- Puts one song at position p_index (0 = first; past the end = last). Used to
-- undo a removal. A song already in the playlist is left where it is.
create or replace function public.music_playlist_insert(p_id text, p_track jsonb, p_index int)
returns setof public.music_playlists
language sql
security invoker
set search_path = ''
as $$
  update public.music_playlists as m
     set tracks = case
           when p_track->>'id' is null
             or exists (select 1 from jsonb_array_elements(m.tracks) e where e->>'id' = p_track->>'id')
           then m.tracks
           else (
             select jsonb_agg(z.e order by z.k)
               from (
                 select x.e, (x.ord - 1)::numeric as k
                   from jsonb_array_elements(m.tracks) with ordinality as x(e, ord)
                 union all
                 -- just before the song now at p_index
                 select p_track,
                        greatest(0, least(coalesce(p_index, jsonb_array_length(m.tracks)),
                                          jsonb_array_length(m.tracks)))::numeric - 0.5
               ) z
           )
         end,
         updated_at = (extract(epoch from clock_timestamp()) * 1000)::bigint
   where m.id = p_id
  returning m.*;
$$;

-- Removes one song. p_index is where the browser saw it: if the song is there
-- more than once (old data), the copy nearest that position goes.
create or replace function public.music_playlist_remove(p_id text, p_track_id text, p_index int)
returns setof public.music_playlists
language sql
security invoker
set search_path = ''
as $$
  update public.music_playlists as m
     set tracks = coalesce((
           select jsonb_agg(x.e order by x.ord)
             from jsonb_array_elements(m.tracks) with ordinality as x(e, ord)
            where x.ord is distinct from (
                    select y.ord from jsonb_array_elements(m.tracks) with ordinality as y(e, ord)
                     where y.e->>'id' = p_track_id
                     order by abs(y.ord - 1 - coalesce(p_index, 0)), y.ord
                     limit 1)
         ), '[]'::jsonb),
         updated_at = (extract(epoch from clock_timestamp()) * 1000)::bigint
   where m.id = p_id
  returning m.*;
$$;

-- Moves one song (by id) to position p_to (0 = first). Songs a teammate added
-- meanwhile keep their order around it. An unknown song changes nothing.
create or replace function public.music_playlist_move(p_id text, p_track_id text, p_to int)
returns setof public.music_playlists
language sql
security invoker
set search_path = ''
as $$
  update public.music_playlists as m
     set tracks = coalesce((
           select jsonb_agg(x.e order by
                    case when x.ord = s.o
                           then greatest(0, least(coalesce(p_to, 0), jsonb_array_length(m.tracks) - 1))::numeric - 0.5
                         when x.ord < s.o then x.ord - 1
                         else x.ord - 2
                    end)
             from jsonb_array_elements(m.tracks) with ordinality as x(e, ord),
                  (select min(y.ord) as o
                     from jsonb_array_elements(m.tracks) with ordinality as y(e, ord)
                    where y.e->>'id' = p_track_id) s
            where s.o is not null
         ), m.tracks),
         updated_at = (extract(epoch from clock_timestamp()) * 1000)::bigint
   where m.id = p_id
  returning m.*;
$$;

create or replace function public.music_playlist_rename(p_id text, p_name text)
returns setof public.music_playlists
language sql
security invoker
set search_path = ''
as $$
  update public.music_playlists as m
     set name = coalesce(p_name, ''),
         updated_at = (extract(epoch from clock_timestamp()) * 1000)::bigint
   where m.id = p_id
  returning m.*;
$$;

revoke all on function public.music_playlist_append(text, jsonb)      from public, anon;
revoke all on function public.music_playlist_insert(text, jsonb, int) from public, anon;
revoke all on function public.music_playlist_remove(text, text, int)  from public, anon;
revoke all on function public.music_playlist_move(text, text, int)    from public, anon;
revoke all on function public.music_playlist_rename(text, text)       from public, anon;
grant execute on function public.music_playlist_append(text, jsonb)      to authenticated;
grant execute on function public.music_playlist_insert(text, jsonb, int) to authenticated;
grant execute on function public.music_playlist_remove(text, text, int)  to authenticated;
grant execute on function public.music_playlist_move(text, text, int)    to authenticated;
grant execute on function public.music_playlist_rename(text, text)       to authenticated;
