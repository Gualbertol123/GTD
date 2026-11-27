// -----------------------------------------------------------------------------
// The guided weekly review (SETTIMANA › Revisione, components/WeeklyReview.tsx).
//
// Pure filters, one per step, all derived from the board the screens get (the
// one without upcoming recurring copies, lib/recurrence.ts `visibleBoard`).
// Nothing is stored: a task the user has dealt with simply stops matching its
// step and leaves the list.
//
//   1. clarify   open tasks (not DONE, not MAYBE) with no due date and/or no
//                owner, among the tasks the BOARD shows (a later step of a
//                sequential project, or a project-only task, is parked on
//                purpose and not asked about);
//   2. waiting   WAITING for 7 days or more (waitingSince);
//   3. overdue   open tasks whose due date is before today;
//   4. maybe     MAYBE;
//   5. write     a summary of the week, then the Weekly page.
// -----------------------------------------------------------------------------

import { PRIORITY_ORDER, UNASSIGNED } from "./constants";
import { toISODate } from "./dates";
import { taskOwners } from "./owners";
import { boardTasks } from "./projects";
import { mondayOf, periodBounds, taskCompletedAt } from "./reportData";
import type { Board, Task } from "./types";

export type ReviewStep = "clarify" | "waiting" | "overdue" | "maybe" | "write";
export const REVIEW_STEPS: ReviewStep[] = ["clarify", "waiting", "overdue", "maybe", "write"];

/** A task is "waiting too long" from this many days in WAITING. */
export const WAITING_DAYS = 7;

/** Not done (archived tasks are DONE, so they are out too). */
export function isOpen(t: Task): boolean {
  return t.status !== "DONE";
}

/** Nobody holds it: only "Unassigned" (or nothing) in owner / assignees. */
export function hasNoOwner(t: Pick<Task, "owner" | "assignees">): boolean {
  return taskOwners(t).every((n) => !n.trim() || n === UNASSIGNED);
}

/** Whole days from one ISO date to another (local calendar days, DST-safe). */
export function daysBetween(fromIso: string, toIso: string): number {
  const utc = (iso: string) => {
    const [y, m, d] = iso.split("-").map(Number);
    return Date.UTC(y, (m || 1) - 1, d || 1);
  };
  return Math.round((utc(toIso) - utc(fromIso)) / 86400000);
}

// Most urgent first, then oldest first: the order the board uses.
function byPriority(a: Task, b: Task): number {
  return PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority] || (a.createdAt ?? 0) - (b.createdAt ?? 0);
}

export interface ClarifyItem {
  task: Task;
  noDue: boolean;
  noOwner: boolean;
}

/** Step 1: open, not MAYBE, no due date and/or no owner. Both missing first. */
export function toClarify(board: Pick<Board, "tasks" | "projects">): ClarifyItem[] {
  return boardTasks(board)
    .filter((t) => isOpen(t) && t.status !== "MAYBE")
    .map((task) => ({ task, noDue: !task.dueDate, noOwner: hasNoOwner(task) }))
    .filter((x) => x.noDue || x.noOwner)
    .sort((a, b) => Number(b.noDue && b.noOwner) - Number(a.noDue && a.noOwner) || byPriority(a.task, b.task));
}

/** How long a WAITING task has waited, in days (0 without a start date). */
export function waitingDays(t: Task, today: string): number {
  return t.waitingSince ? Math.max(0, daysBetween(t.waitingSince, today)) : 0;
}

/** Step 2: WAITING for WAITING_DAYS or more. Longest first. */
export function waitingTooLong(tasks: Task[], today: string): Task[] {
  return tasks
    .filter((t) => t.status === "WAITING" && !!t.waitingSince && waitingDays(t, today) >= WAITING_DAYS)
    .sort((a, b) => waitingDays(b, today) - waitingDays(a, today) || byPriority(a, b));
}

/** Days past the due date (0 when not overdue). */
export function overdueDays(t: Task, today: string): number {
  return t.dueDate ? Math.max(0, daysBetween(t.dueDate, today)) : 0;
}

/** Step 3: open with a due date before today. Most overdue first. */
export function overdue(tasks: Task[], today: string): Task[] {
  return tasks
    .filter((t) => isOpen(t) && !!t.dueDate && t.dueDate < today)
    .sort((a, b) => (a.dueDate ?? "").localeCompare(b.dueDate ?? "") || byPriority(a, b));
}

/** Step 4: MAYBE, less any the user chose to keep during this review. */
export function maybes(tasks: Task[], kept: ReadonlySet<string> = new Set()): Task[] {
  return tasks.filter((t) => t.status === "MAYBE" && !kept.has(t.id)).sort(byPriority);
}

export interface ReviewLists {
  clarify: ClarifyItem[];
  waiting: Task[];
  overdue: Task[];
  maybe: Task[];
}

/** Every step's list at once. */
export function reviewLists(
  board: Pick<Board, "tasks" | "projects">,
  today: string = toISODate(new Date()),
  kept: ReadonlySet<string> = new Set()
): ReviewLists {
  return {
    clarify: toClarify(board),
    waiting: waitingTooLong(board.tasks, today),
    overdue: overdue(board.tasks, today),
    maybe: maybes(board.tasks, kept),
  };
}

/** How many tasks each step still lists (step 5 has none). */
export function stepCounts(l: ReviewLists): Record<ReviewStep, number> {
  return { clarify: l.clarify.length, waiting: l.waiting.length, overdue: l.overdue.length, maybe: l.maybe.length, write: 0 };
}

/** How many different tasks steps 1–4 still list (one task can be in several). */
export function tasksLeft(l: ReviewLists): number {
  const ids = new Set<string>();
  for (const x of l.clarify) ids.add(x.task.id);
  for (const t of [...l.waiting, ...l.overdue, ...l.maybe]) ids.add(t.id);
  return ids.size;
}

export interface WeekSummary {
  /** Completed this Monday–Sunday week (the Weekly's Recap). */
  doneThisWeek: number;
  /** Not done, Maybe included. */
  open: number;
  /** In WAITING now. */
  waiting: number;
  /** Items written in the Weekly's five columns. */
  weeklyItems: number;
}

/** Step 5's figures. `now` picks the week (default: this one). */
export function weekSummary(board: Pick<Board, "tasks" | "weekly">, now: Date = new Date()): WeekSummary {
  // The Monday–Sunday week containing `now`, as the Weekly's Recap counts it.
  const mon = mondayOf(now);
  const sun = new Date(mon);
  sun.setDate(sun.getDate() + 6);
  const { start, end } = periodBounds({ from: toISODate(mon), to: toISODate(sun) });
  const w = board.weekly;
  return {
    doneThisWeek: board.tasks.filter((t) => {
      const at = taskCompletedAt(t);
      return t.status === "DONE" && at >= start && at < end;
    }).length,
    open: board.tasks.filter(isOpen).length,
    waiting: board.tasks.filter((t) => t.status === "WAITING").length,
    weeklyItems: w.well.length + w.learnings.length + w.improve.length + w.blockers.length + w.focus.length,
  };
}
