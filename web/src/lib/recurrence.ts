import type { Board, Op, Recurrence, Task } from "./types";
import { toISODate } from "./dates";

// Recurring tasks. A recurring task is an ordinary task with a rule. When an
// occurrence is completed it stays in DONE (so the Done bar, the weekly recap
// and the report count it like any other task) and the next occurrence is
// created beside it, due on the rule's next date. Reopening the completed one
// takes back that next occurrence, as long as nobody has touched it yet.
//
// The next occurrence's id is worked out, never random: `<series>@<due>`.
// Two people completing the same task at once therefore add the same row (the
// second insert is ignored), and Reopen can find the row it has to take back.

const DAY = 86400000;

function parseISO(iso: string): Date {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d);
}

/** 0 = Monday … 6 = Sunday. */
function weekday(d: Date): number {
  return (d.getDay() + 6) % 7;
}

function addDays(d: Date, n: number): Date {
  // Built from the parts, so a clock change never shifts it by an hour.
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
}

/** Months added to `anchor`, kept on its day of the month (31 → 30 → 28 …). */
function addMonths(anchor: Date, n: number): Date {
  const y = anchor.getFullYear();
  const m = anchor.getMonth() + n;
  const last = new Date(y, m + 1, 0).getDate();
  return new Date(y, m, Math.min(anchor.getDate(), last));
}

export function cleanRule(r: Recurrence): Recurrence {
  const every = Math.max(1, Math.min(365, Math.round(Number(r.every) || 1)));
  const days =
    r.freq === "weekly" && Array.isArray(r.days)
      ? [...new Set(r.days.filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))].sort()
      : undefined;
  const out: Recurrence = { freq: r.freq, every };
  if (days && days.length) out.days = days;
  if (r.series) out.series = r.series;
  return out;
}

/** Reads a rule from the database, or undefined when it is not a valid one. */
export function parseRule(v: unknown): Recurrence | undefined {
  if (!v || typeof v !== "object") return undefined;
  const r = v as Partial<Recurrence>;
  if (!["daily", "weekly", "monthly", "yearly"].includes(r.freq as string)) return undefined;
  return cleanRule({
    freq: r.freq as Recurrence["freq"],
    every: Number(r.every) || 1,
    days: Array.isArray(r.days) ? r.days.map(Number) : undefined,
    series: typeof r.series === "string" && r.series ? r.series : undefined,
  });
}

/** The k-th date of the rule after `start` (k = 1 is the first one after it). */
function nth(rule: Recurrence, start: Date, k: number): Date {
  switch (rule.freq) {
    case "daily":
      return addDays(start, rule.every * k);
    case "monthly":
      return addMonths(start, rule.every * k);
    case "yearly":
      return addMonths(start, 12 * rule.every * k);
    case "weekly":
      return addDays(start, 7 * rule.every * k);
  }
}

function mondayOf(d: Date): Date {
  return addDays(d, -weekday(d));
}

/**
 * Weekly with chosen weekdays: the first chosen day after `d`. With "every N
 * weeks" only the weeks N, 2N … after the anchor's week count.
 */
function nextWeekday(rule: Recurrence, d: Date, anchor: Date): Date {
  const days = rule.days!;
  const a = mondayOf(anchor).getTime();
  let cur = addDays(d, 1);
  for (let i = 0; i < 7 * (rule.every + 1); i++) {
    const weeks = Math.round((mondayOf(cur).getTime() - a) / (7 * DAY));
    if (days.includes(weekday(cur)) && weeks % rule.every === 0) return cur;
    cur = addDays(cur, 1);
  }
  return addDays(d, 7 * rule.every); // unreachable with a valid rule
}

/**
 * The next due date after completing an occurrence.
 * `due` is the completed occurrence's due date (if any); `today` the day it
 * was completed. Done early → the date after `due`; done late → the first
 * date after today, skipping the missed ones; no due date → counted from today.
 */
export function nextDue(rule: Recurrence, due: string | undefined, today: string): string {
  const r = cleanRule(rule);
  const t = parseISO(today);
  const base = due ? parseISO(due) : t;
  if (r.freq === "weekly" && r.days?.length) {
    let d = nextWeekday(r, base, base);
    for (let i = 0; i < 2000 && d.getTime() <= t.getTime(); i++) d = nextWeekday(r, d, base);
    return toISODate(d);
  }
  let k = 1;
  let d = nth(r, base, k);
  // Jump close to today in one step, then walk (keeps months anchored).
  if (d.getTime() <= t.getTime() && r.freq === "daily") {
    k = Math.max(1, Math.floor((t.getTime() - base.getTime()) / (DAY * r.every)));
    d = nth(r, base, k);
  }
  for (let i = 0; i < 5000 && d.getTime() <= t.getTime(); i++) d = nth(r, base, ++k);
  return toISODate(d);
}

export function seriesOf(task: Task): string {
  return task.recurrence?.series || task.id;
}

/** The next occurrence of a recurring task completed on `today`. */
export function nextOccurrence(task: Task, today: string, now: number): Task {
  const rule = task.recurrence!;
  const series = seriesOf(task);
  const due = nextDue(rule, task.dueDate, today);
  return {
    ...task,
    id: `${series}@${due}`,
    status: "NEXT",
    dueDate: due,
    waitingSince: undefined,
    doneAt: undefined,
    subtasks: task.subtasks.map((s) => ({ id: s.id, text: s.text, done: false })),
    recurrence: { ...cleanRule(rule), series },
    // Edited before it was created = never edited: any change stamps
    // updatedAt with the clock, which is never earlier than createdAt.
    // Reopen only takes back an occurrence still in that state.
    createdAt: now,
    updatedAt: now - 1,
  };
}

function dayOf(ms: number | undefined): string {
  return toISODate(ms ? new Date(ms) : new Date());
}

/**
 * One op as the UI sent it, plus what a recurring task adds to it:
 * completing it also adds the next occurrence, and reopening it takes that
 * occurrence back while it is still untouched.
 */
export function expandOp(board: Board, op: Op, now = Date.now()): Op[] {
  if (op.type !== "moveTask") return [op];
  const task = board.tasks.find((t) => t.id === op.id);
  if (!task?.recurrence) return [op];

  const wasDone = task.status === "DONE";
  if (op.status === "DONE" && !wasDone) {
    const next = nextOccurrence(task, dayOf(now), now);
    if (board.tasks.some((t) => t.id === next.id)) return [op];
    return [op, { type: "addTask", task: next }];
  }
  if (wasDone && op.status !== "DONE") {
    const id = `${seriesOf(task)}@${nextDue(task.recurrence, task.dueDate, dayOf(task.doneAt))}`;
    const next = board.tasks.find((t) => t.id === id);
    const untouched = next && next.status !== "DONE" && next.updatedAt < (next.createdAt ?? 0);
    return untouched ? [op, { type: "deleteTask", id }] : [op];
  }
  return [op];
}

// ---- Labels -----------------------------------------------------------------

const DAY_SHORT = {
  it: ["lun", "mar", "mer", "gio", "ven", "sab", "dom"],
  en: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"],
} as const;

export function weekdayShort(lang: "it" | "en", d: number): string {
  return DAY_SHORT[lang][d];
}

/** "Ogni settimana · lun, gio", "Every 2 months". */
export function ruleLabel(rule: Recurrence, lang: "it" | "en"): string {
  const r = cleanRule(rule);
  const one = {
    it: { daily: "Ogni giorno", weekly: "Ogni settimana", monthly: "Ogni mese", yearly: "Ogni anno" },
    en: { daily: "Every day", weekly: "Every week", monthly: "Every month", yearly: "Every year" },
  }[lang];
  const many = {
    it: { daily: "giorni", weekly: "settimane", monthly: "mesi", yearly: "anni" },
    en: { daily: "days", weekly: "weeks", monthly: "months", yearly: "years" },
  }[lang];
  let s = r.every === 1 ? one[r.freq] : `${lang === "it" ? "Ogni" : "Every"} ${r.every} ${many[r.freq]}`;
  if (r.freq === "weekly" && r.days?.length) {
    const weekdays = r.days.length === 5 && r.days.every((d, i) => d === i);
    s += ` · ${weekdays ? (lang === "it" ? "feriali" : "weekdays") : r.days.map((d) => DAY_SHORT[lang][d]).join(", ")}`;
  }
  return s;
}
