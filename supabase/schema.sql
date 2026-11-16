-- ============================================================================
-- TEAM GTD — Supabase schema (FRESH INSTALL)
--
-- For a brand-new, empty Supabase project only. An existing project with data
-- is upgraded with the migration-0XX files instead (see README.md §11); this
-- script refuses to run where the board tables already exist.
--
-- Before running this:
--   1. Authentication → Sign In / Providers: turn OFF "Allow new users to
--      sign up".
--   2. Authentication → Users → Add user → Create new user: the shared team
--      e-mail + a strong password, tick "Auto Confirm User".
--   3. Put that e-mail on the LAST line of this file.
-- Then: SQL Editor → New query → paste all of this → Run.
--
-- Result: only the team account can read or write anything; every password
-- is stored as a bcrypt hash and checked on the server.
-- ============================================================================

begin;

do $$
begin
  if to_regclass('public.board_meta') is not null or to_regclass('public.tasks') is not null then
    raise exception 'This project already has the board tables. schema.sql is for an empty project only; upgrade with the migration files (README §11).';
  end if;
end $$;

create extension if not exists pgcrypto with schema extensions;

create schema if not exists private;
revoke all on schema private from public, anon, authenticated;

-- ---- Tables ----------------------------------------------------------------

-- Single-row table holding board name, team members and app settings.
create table public.board_meta (
  id              text primary key,
  board_name      text  not null default 'TEAM GTD FINALE',
  members         text[] not null default '{}',
  subtitle_it     text,
  subtitle_en     text,
  login_days      integer default 7,
  logo_url        text,
  favicon_url     text
);

-- One row per task.
create table public.tasks (
  id             text primary key,
  title          text   not null default '',
  description    text   not null default '',   -- app field "desc"
  owner          text   not null default 'Unassigned',
  priority       text   not null default 'P3', -- P1..P4
  status         text   not null default 'NEXT',
  notes          text   not null default '',
  subtasks       jsonb  not null default '[]'::jsonb,
  due_date       text,                          -- ISO yyyy-mm-dd
  waiting_since  text,                          -- ISO yyyy-mm-dd
  file_dir       text,                          -- shared network file path
  done_at        bigint,                        -- when it entered DONE (archive timer)
  updated_at     bigint not null default 0,
  created_at     bigint not null default 0,     -- ordering within a column
  assignees      text[]                         -- everyone on a shared task
);

-- One row per team member per day — the Daily Reflection.
create table public.reflections (
  id          text primary key,   -- "<date>::<member>"
  member      text not null,
  date        text not null,      -- yyyy-mm-dd
  done        text not null default '',
  well        text not null default '',
  improve     text not null default '',
  learning    text not null default '',
  updated_at  bigint not null default 0,
  created_at  bigint not null default 0
);
create index reflections_date_idx on public.reflections (date);

-- Per-member Reflection password, as a bcrypt hash. Never readable from the
-- browser; checked and changed only through the functions further down.
create table public.reflection_access (
  member          text primary key,
  updated_at      bigint not null default 0,
  password_hash   text not null,
  failed_attempts integer not null default 0,
  locked_until    timestamptz
);

-- One row per project. Its work is the board tasks linked through
-- tasks.project_id; it is "completed" once all of them are DONE (not stored).
-- `items` is the old checklist, kept so nothing is lost; the app offers to
-- turn it into tasks or notes.
create table public.projects (
  id          text primary key,
  name        text  not null default '',
  items       jsonb not null default '[]'::jsonb,
  created_at  bigint not null default 0,
  updated_at  bigint not null default 0,
  report_hidden boolean not null default false, -- left out of the weekly report
  description text   not null default '',
  notes       text   not null default '',
  owners      text[] not null default '{}',
  priority    text   not null default 'P2',     -- P1..P4
  start_date  text,                             -- ISO yyyy-mm-dd
  target_date text,                             -- ISO yyyy-mm-dd
  color       text   not null default '',       -- #rrggbb, '' = automatic
  board_mode  text   not null default 'all'     -- all | sequential | none (migration 016)
              constraint projects_board_mode_check check (board_mode in ('all', 'sequential', 'none')),
  task_order  jsonb  not null default '[]'::jsonb -- task ids in step order
);
create index projects_created_idx on public.projects (created_at);

-- The project a board task belongs to (deleting the project unlinks it).
alter table public.tasks add column project_id text
  references public.projects (id) on delete set null;
create index tasks_project_idx on public.tasks (project_id);

-- One row per personal note, tagged with the member who wrote it.
create table public.personal_notes (
  id          text primary key,
  member      text   not null default '',
  body        text   not null default '',
  created_at  bigint not null default 0,
  updated_at  bigint not null default 0
);
create index personal_notes_member_idx on public.personal_notes (member, updated_at desc);

-- One row per weekly-review item.
create table public.weekly (
  id          text primary key,
  bucket      text   not null,                  -- well | learnings | improve | blockers | focus
  body        text   not null default '',       -- the item text
  created_at  bigint not null default 0
);

-- The Supabase Auth user id(s) allowed to use the board.
create table private.team_accounts (
  user_id   uuid primary key references auth.users (id) on delete cascade,
  added_at  timestamptz not null default now()
);
revoke all on table private.team_accounts from public, anon, authenticated;

-- ---- Team check ------------------------------------------------------------
-- True when the caller is logged in as a team account with a live session.

create or replace function public.is_team_member()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
      from private.team_accounts t
      join auth.sessions s on s.user_id = t.user_id
     where t.user_id = auth.uid()
       and s.id = nullif(auth.jwt() ->> 'session_id', '')::uuid
  );
$$;
revoke all on function public.is_team_member() from public, anon;
grant execute on function public.is_team_member() to authenticated;

-- ---- Access (Row Level Security) -------------------------------------------
-- Only a logged-in team account can read or write. The public (anon) key that
-- ships in the website gets nothing. private.lock_table() applies the rule;
-- run it for any table you add later.

create or replace function private.lock_table(p_table text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  p record;
begin
  if to_regclass('public.' || quote_ident(p_table)) is null then
    return;
  end if;
  execute format('alter table public.%I enable row level security', p_table);
  for p in select policyname from pg_policies where schemaname = 'public' and tablename = p_table loop
    execute format('drop policy %I on public.%I', p.policyname, p_table);
  end loop;
  execute format('revoke all on table public.%I from anon', p_table);
  -- TRUNCATE ignores row-level security; nobody from the browser needs it.
  execute format('revoke truncate, references, trigger on table public.%I from authenticated', p_table);

  if p_table = 'reflection_access' then
    execute format('revoke all on table public.%I from authenticated', p_table);
    if exists (select 1 from pg_publication_tables
                where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = p_table) then
      execute format('alter publication supabase_realtime drop table public.%I', p_table);
    end if;
    return;
  end if;

  execute format('grant select, insert, update, delete on table public.%I to authenticated', p_table);
  execute format(
    'create policy %I on public.%I for all to authenticated '
    'using ((select public.is_team_member())) with check ((select public.is_team_member()))',
    'team only ' || p_table, p_table);
end;
$$;
revoke all on function private.lock_table(text) from public, anon, authenticated;

select private.lock_table(t) from unnest(array[
  'board_meta', 'tasks', 'weekly', 'reflections', 'projects',
  'personal_notes', 'reflection_access'
]) as t;

alter default privileges for role postgres in schema public revoke all on tables    from anon;
alter default privileges for role postgres in schema public revoke all on sequences from anon;
alter default privileges for role postgres in schema public revoke all on functions from anon;
revoke all on all sequences in schema public from anon;

-- ---- Password checks the website calls ------------------------------------
-- Team accounts only; 5 wrong guesses in a row lock that password for 5
-- minutes. Results: 'ok' | 'wrong' | 'locked' | 'unknown' | 'invalid' | 'forbidden'.

create or replace function public.reflection_login(p_member text, p_password text)
returns text
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  r public.reflection_access%rowtype;
begin
  if not public.is_team_member() then
    return 'forbidden';
  end if;
  -- Only names that are on the board's member list.
  if p_member is null or not exists (
    select 1 from public.board_meta where id = 'main' and p_member = any (members)
  ) then
    return 'unknown';
  end if;

  select * into r from public.reflection_access where member = p_member for update;
  if not found then
    -- A member who never had a row still has the initial password 'password'.
    insert into public.reflection_access (member, password_hash, updated_at)
    values (p_member,
            extensions.crypt('password', extensions.gen_salt('bf', 10)),
            (extract(epoch from now()) * 1000)::bigint)
    on conflict (member) do nothing;
    select * into r from public.reflection_access where member = p_member for update;
  end if;

  if r.locked_until is not null and r.locked_until > now() then
    return 'locked';
  end if;

  if r.password_hash is not null
     and r.password_hash = extensions.crypt(coalesce(p_password, ''), r.password_hash) then
    update public.reflection_access
       set failed_attempts = 0, locked_until = null
     where member = p_member;
    return 'ok';
  end if;

  update public.reflection_access
     set failed_attempts = case when r.failed_attempts + 1 >= 5 then 0 else r.failed_attempts + 1 end,
         locked_until    = case when r.failed_attempts + 1 >= 5 then now() + interval '5 minutes' else null end
   where member = p_member;
  return 'wrong';
end;
$$;

create or replace function public.reflection_change_password(
  p_member text, p_current text, p_new text
)
returns text
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  res text;
begin
  if p_new is null or length(p_new) < 6 or octet_length(p_new) > 72 then
    return 'invalid';
  end if;
  -- Changing needs the current password, checked (and throttled) the same way
  -- as a login, so one teammate cannot change another's.
  res := public.reflection_login(p_member, p_current);
  if res <> 'ok' then
    return res;
  end if;
  update public.reflection_access
     set password_hash = extensions.crypt(p_new, extensions.gen_salt('bf', 10)),
         updated_at    = (extract(epoch from now()) * 1000)::bigint
   where member = p_member;
  return 'ok';
end;
$$;


revoke all on function public.reflection_login(text, text)                   from public, anon;
revoke all on function public.reflection_change_password(text, text, text)   from public, anon;
grant execute on function public.reflection_login(text, text)                 to authenticated;
grant execute on function public.reflection_change_password(text, text, text) to authenticated;

-- ---- Admin tools: run these from the Supabase SQL Editor only -------------

create or replace function private.admin_add_team_account(p_email text)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  uid uuid;
begin
  select id into uid from auth.users where lower(email) = lower(trim(p_email));
  if uid is null then
    raise exception 'No user with e-mail % in Authentication → Users. Create it there first (Add user → Create new user, tick "Auto Confirm User").', p_email;
  end if;
  insert into private.team_accounts (user_id) values (uid) on conflict do nothing;
  return 'Team account enabled: ' || p_email;
end;
$$;

create or replace function private.admin_remove_team_account(p_email text)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  uid uuid;
begin
  select t.user_id into uid
    from private.team_accounts t join auth.users u on u.id = t.user_id
   where lower(u.email) = lower(trim(p_email));
  if uid is null then
    raise exception 'No team account with e-mail %.', p_email;
  end if;
  if (select count(*) from private.team_accounts) = 1 then
    raise exception 'That is the last team account: removing it would lock everyone out. Add another one first.';
  end if;
  delete from private.team_accounts where user_id = uid;
  delete from auth.sessions where user_id = uid;
  return 'Team account disabled: ' || p_email;
end;
$$;

create or replace function private.admin_set_team_password(
  p_new text, p_sign_out_everyone boolean default true, p_email text default null
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  uid uuid;
begin
  if p_new is null or length(p_new) < 12 or octet_length(p_new) > 72 then
    raise exception 'Use 12 to 72 characters.';
  end if;
  if p_email is null then
    if (select count(*) from private.team_accounts) > 1 then
      raise exception 'There are several team accounts; name one: select private.admin_set_team_password(''new password'', true, ''e-mail'');';
    end if;
    select user_id into uid from private.team_accounts;
  else
    select t.user_id into uid
      from private.team_accounts t join auth.users u on u.id = t.user_id
     where lower(u.email) = lower(trim(p_email));
  end if;
  if uid is null then
    raise exception 'No such team account. See: select u.email from private.team_accounts t join auth.users u on u.id = t.user_id;';
  end if;
  update auth.users
     set encrypted_password = extensions.crypt(p_new, extensions.gen_salt('bf', 10)),
         updated_at         = now()
   where id = uid;
  if p_sign_out_everyone then
    delete from auth.refresh_tokens where user_id = uid::text;
    delete from auth.sessions where user_id = uid;
  end if;
  return 'Team password changed'
         || case when p_sign_out_everyone then '; every device must log in again.' else '.' end;
end;
$$;

create or replace function private.admin_set_reflection_password(p_member text, p_new text)
returns text
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_new is null or length(p_new) < 1 or octet_length(p_new) > 72 then
    raise exception 'Give a password of up to 72 characters.';
  end if;
  insert into public.reflection_access (member, password_hash, failed_attempts, locked_until, updated_at)
  values (p_member, extensions.crypt(p_new, extensions.gen_salt('bf', 10)), 0, null,
          (extract(epoch from now()) * 1000)::bigint)
  on conflict (member) do update
     set password_hash   = excluded.password_hash,
         failed_attempts = 0,
         locked_until    = null,
         updated_at      = excluded.updated_at;
  return 'Reflection password set for ' || p_member;
end;
$$;


revoke all on function private.admin_add_team_account(text)                  from public, anon, authenticated;
revoke all on function private.admin_remove_team_account(text)               from public, anon, authenticated;
revoke all on function private.admin_set_team_password(text, boolean, text)  from public, anon, authenticated;
revoke all on function private.admin_set_reflection_password(text, text)     from public, anon, authenticated;

-- ---- Subtasks, one change at a time (migration 017) -------------------------
-- The app changes a task's subtasks through these, so two people editing the
-- same task's subtasks at once do not undo each other. They run with the
-- caller's rights, so the team-only rule on public.tasks still applies.

create or replace function public.subtask_add(p_task text, p_subtask jsonb)
returns void
language sql
security invoker
set search_path = ''
as $$
  update public.tasks
     set subtasks = coalesce(subtasks, '[]'::jsonb) || jsonb_build_array(p_subtask),
         updated_at = (extract(epoch from clock_timestamp()) * 1000)::bigint
   where id = p_task
     -- Adding the same subtask twice (a retried request) changes nothing.
     and not exists (
       select 1 from jsonb_array_elements(coalesce(subtasks, '[]'::jsonb)) e
        where e->>'id' = p_subtask->>'id'
     );
$$;

-- p_patch holds only the fields to change; a field set to null is removed
-- (e.g. doneAt when a subtask is unticked).
create or replace function public.subtask_update(p_task text, p_id text, p_patch jsonb)
returns void
language sql
security invoker
set search_path = ''
as $$
  update public.tasks
     set subtasks = coalesce((
           select jsonb_agg(
                    case when e->>'id' = p_id then jsonb_strip_nulls(e || p_patch) else e end
                    order by ord)
             from jsonb_array_elements(coalesce(subtasks, '[]'::jsonb)) with ordinality as x(e, ord)
         ), '[]'::jsonb),
         updated_at = (extract(epoch from clock_timestamp()) * 1000)::bigint
   where id = p_task;
$$;

create or replace function public.subtask_delete(p_task text, p_id text)
returns void
language sql
security invoker
set search_path = ''
as $$
  update public.tasks
     set subtasks = coalesce((
           select jsonb_agg(e order by ord)
             from jsonb_array_elements(coalesce(subtasks, '[]'::jsonb)) with ordinality as x(e, ord)
            where e->>'id' is distinct from p_id
         ), '[]'::jsonb),
         updated_at = (extract(epoch from clock_timestamp()) * 1000)::bigint
   where id = p_task;
$$;

-- p_ids is the new order (a jsonb array of subtask ids). Subtasks it does not
-- list — e.g. one a teammate added a moment ago — keep their place at the end.
create or replace function public.subtask_reorder(p_task text, p_ids jsonb)
returns void
language sql
security invoker
set search_path = ''
as $$
  update public.tasks
     set subtasks = coalesce((
           select jsonb_agg(e order by coalesce(o.pos, 1000000 + x.ord))
             from jsonb_array_elements(coalesce(subtasks, '[]'::jsonb)) with ordinality as x(e, ord)
             left join jsonb_array_elements_text(p_ids) with ordinality as o(id, pos)
               on o.id = e->>'id'
         ), '[]'::jsonb),
         updated_at = (extract(epoch from clock_timestamp()) * 1000)::bigint
   where id = p_task;
$$;

revoke all on function public.subtask_add(text, jsonb)          from public, anon;
revoke all on function public.subtask_update(text, text, jsonb) from public, anon;
revoke all on function public.subtask_delete(text, text)        from public, anon;
revoke all on function public.subtask_reorder(text, jsonb)      from public, anon;
grant execute on function public.subtask_add(text, jsonb)          to authenticated;
grant execute on function public.subtask_update(text, text, jsonb) to authenticated;
grant execute on function public.subtask_delete(text, text)        to authenticated;
grant execute on function public.subtask_reorder(text, jsonb)      to authenticated;

-- ---- Music playlists (migration 018) ----------------------------------------
create table if not exists public.music_playlists (
  id          text   primary key,
  name        text   not null default '',
  owner       text   not null default '',
  tracks      jsonb  not null default '[]'::jsonb,
  created_at  bigint not null default (extract(epoch from now()) * 1000)::bigint,
  updated_at  bigint not null default (extract(epoch from now()) * 1000)::bigint
);
select private.lock_table('music_playlists');

-- ---- Music playlists, one change at a time (migration 019) ----------------
-- The app changes a playlist's songs and name through these, so two people
-- editing the same playlist at once do not lose each other's songs. They run
-- with the caller's rights, so the team-only rule on music_playlists applies.

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

-- ---- Music playlists, stamped by the database clock (migration 020) -------
-- Every insert and update gets the database's time in updated_at (never below
-- the row's previous stamp), so the app's "newest version wins" never depends
-- on a browser's clock.
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

-- ---- Radio playlists, updated daily (migration 021) ------------------------
-- "Salva radio come playlist": a song's radio saved as a team playlist that a
-- team browser refreshes once a day. radio_seed null = an ordinary playlist
-- (or a radio whose songs were edited by hand, which stops the updates).
alter table public.music_playlists add column if not exists radio_seed         text   null;
alter table public.music_playlists add column if not exists radio_title        text   null;
alter table public.music_playlists add column if not exists radio_refreshed_at bigint null;

-- Refreshes a radio playlist only if it is still a radio and was last checked
-- more than p_stale_ms ago (database clock), so two browsers can't both do
-- it. p_tracks null: songs unchanged, only the check is stamped. Returns the
-- row, or nothing when not due. Runs with the caller's rights.
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

-- ---- Imported playlists that sync daily (migration 022) -------------------
-- A playlist imported from Spotify (playlist / album link, La mia libreria:
-- playlist, album, liked songs) or from a YouTube playlist remembers its
-- source; a team browser re-reads it once a day and the "Sincronizza" button
-- on demand. source_kind null = an ordinary playlist. source_auto false =
-- detached (songs edited by hand, or "Stacca"): no daily sync, but the button
-- still works as a one-off. source_id is, for the liked songs, the Spotify
-- user id of whoever imported them.
alter table public.music_playlists add column if not exists source_kind      text    null;
alter table public.music_playlists add column if not exists source_id        text    null;
alter table public.music_playlists add column if not exists source_name      text    null;
alter table public.music_playlists add column if not exists source_synced_at bigint  null;
alter table public.music_playlists add column if not exists source_auto      boolean not null default true;

-- Syncs an imported playlist only if it still has a source and either
-- p_stale_ms <= 0 (the button: always) or it is automatic and was last checked
-- more than p_stale_ms ago (database clock), so two browsers can't both do the
-- daily sync. p_tracks null: songs unchanged, only the check is stamped.
-- p_expect: the song ids the sync was planned on; the list changed since, refused.
-- Returns the row, or nothing when not due. Runs with the caller's rights.
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

-- ---- Realtime --------------------------------------------------------------
-- Change events for the board tables (they respect the policies above).
-- reflection_access is deliberately NOT published.

alter publication supabase_realtime add table
  public.board_meta, public.tasks, public.weekly, public.reflections,
  public.projects, public.personal_notes, public.music_playlists;

-- ---- The team account -------------------------------------------------------
-- >>> Replace the e-mail below with the team user you created. <<<
select private.admin_add_team_account('team@example.com');

commit;
