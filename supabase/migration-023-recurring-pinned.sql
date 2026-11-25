-- ============================================================================
-- Migration 023 — recurring tasks and the "In evidenza" band
-- Safe on live data: ADDS two columns to tasks; run once in Supabase →
-- SQL Editor (running it again does nothing).
--
-- tasks gains:
--   pinned      true = the task is also shown in the BOARD's "In evidenza"
--               band, above the columns (and stands out in its column).
--   recurrence  null for an ordinary task. For a recurring one, its rule:
--               {"freq": "daily" | "weekly" | "monthly" | "yearly",
--                "every": 1,            -- every N days / weeks / months / years
--                "days": [0, 3],        -- weekly only, 0 = Monday … 6 = Sunday
--                "series": "<id>"}      -- shared by all its occurrences
--               Completing an occurrence makes the app add the next one, with
--               the id "<series>@<next due date>".
--
-- Before this migration the app works as before; the repeat and "In evidenza"
-- controls say that this migration is needed.
-- ============================================================================

alter table public.tasks add column if not exists pinned     boolean not null default false;
alter table public.tasks add column if not exists recurrence jsonb;

create index if not exists tasks_pinned_idx on public.tasks (pinned) where pinned;
