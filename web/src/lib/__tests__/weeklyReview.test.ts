import { describe, expect, it } from "vitest";
import {
  daysBetween,
  hasNoOwner,
  maybes,
  overdue,
  overdueDays,
  reviewLists,
  stepCounts,
  toClarify,
  waitingDays,
  waitingTooLong,
  weekSummary,
} from "../weeklyReview";
import { board, project, task } from "./fixtures";

const TODAY = "2026-11-27"; // a Friday

describe("weekly review: helpers", () => {
  it("counts calendar days between ISO dates, across a DST change", () => {
    expect(daysBetween("2026-11-20", TODAY)).toBe(7);
    expect(daysBetween(TODAY, TODAY)).toBe(0);
    expect(daysBetween("2026-10-20", "2026-10-27")).toBe(7); // clocks go back on 25 Oct
    expect(daysBetween("2026-11-28", TODAY)).toBe(-1);
  });

  it("no owner means only Unassigned, in owner or assignees", () => {
    expect(hasNoOwner(task("a", { owner: "Unassigned" }))).toBe(true);
    expect(hasNoOwner(task("a", { owner: "Unassigned", assignees: ["Unassigned"] }))).toBe(true);
    expect(hasNoOwner(task("a", { owner: "" }))).toBe(true);
    expect(hasNoOwner(task("a", { owner: "Anna" }))).toBe(false);
    expect(hasNoOwner(task("a", { owner: "Anna", assignees: ["Anna", "Marco"] }))).toBe(false);
  });
});

describe("step 1: da chiarire", () => {
  it("lists open tasks with no due date and/or no owner, and says which", () => {
    const b = board({
      tasks: [
        task("dated-owned", { dueDate: TODAY }),
        task("no-due", {}),
        task("no-owner", { owner: "Unassigned", dueDate: TODAY }),
        task("both", { owner: "Unassigned", priority: "P4" }),
        task("done", { status: "DONE", doneAt: 1 }),
        task("maybe", { status: "MAYBE" }),
        task("waiting", { status: "WAITING", owner: "Unassigned", dueDate: TODAY }),
      ],
    });
    const got = toClarify(b);
    expect(got.map((x) => x.task.id)).toEqual(["both", "no-due", "no-owner", "waiting"]);
    expect(got[0]).toMatchObject({ noDue: true, noOwner: true });
    expect(got.find((x) => x.task.id === "no-due")).toMatchObject({ noDue: true, noOwner: false });
    expect(got.find((x) => x.task.id === "no-owner")).toMatchObject({ noDue: false, noOwner: true });
  });

  it("orders by priority within each group", () => {
    const b = board({ tasks: [task("p3", { priority: "P3" }), task("p1", { priority: "P1" })] });
    expect(toClarify(b).map((x) => x.task.id)).toEqual(["p1", "p3"]);
  });

  it("leaves out tasks kept off the BOARD (later steps of a sequential project)", () => {
    const p = project("p", { boardMode: "sequential", taskOrder: ["s1", "s2"] });
    const b = board({
      projects: [p],
      tasks: [task("s1", { projectId: "p" }), task("s2", { projectId: "p" })],
    });
    expect(toClarify(b).map((x) => x.task.id)).toEqual(["s1"]);
  });
});

describe("step 2: in attesa da più di una settimana", () => {
  it("lists WAITING tasks waiting 7 days or more, longest first", () => {
    const tasks = [
      task("w6", { status: "WAITING", waitingSince: "2026-11-21" }),
      task("w7", { status: "WAITING", waitingSince: "2026-11-20" }),
      task("w30", { status: "WAITING", waitingSince: "2026-10-28" }),
      task("w-none", { status: "WAITING" }),
      task("next-old", { status: "NEXT", waitingSince: "2026-01-01" }),
    ];
    expect(waitingTooLong(tasks, TODAY).map((t) => t.id)).toEqual(["w30", "w7"]);
    expect(waitingDays(tasks[1], TODAY)).toBe(7);
    expect(waitingDays(tasks[3], TODAY)).toBe(0);
  });
});

describe("step 3: scadute", () => {
  it("lists open tasks due before today, most overdue first", () => {
    const tasks = [
      task("today", { dueDate: TODAY }),
      task("yesterday", { dueDate: "2026-11-26" }),
      task("last-month", { dueDate: "2026-10-27", status: "WAITING" }),
      task("done-late", { dueDate: "2026-11-01", status: "DONE", doneAt: 1 }),
      task("maybe-late", { dueDate: "2026-11-02", status: "MAYBE" }),
      task("no-due", {}),
    ];
    expect(overdue(tasks, TODAY).map((t) => t.id)).toEqual(["last-month", "maybe-late", "yesterday"]);
    expect(overdueDays(tasks[1], TODAY)).toBe(1);
    expect(overdueDays(tasks[0], TODAY)).toBe(0);
  });
});

describe("step 4: forse / maybe", () => {
  it("lists MAYBE tasks by priority, less the ones kept in this review", () => {
    const tasks = [task("m4", { status: "MAYBE", priority: "P4" }), task("m1", { status: "MAYBE", priority: "P1" }), task("n", {})];
    expect(maybes(tasks).map((t) => t.id)).toEqual(["m1", "m4"]);
    expect(maybes(tasks, new Set(["m1"])).map((t) => t.id)).toEqual(["m4"]);
  });
});

describe("all steps", () => {
  it("a task that is dealt with leaves its step", () => {
    const before = board({ tasks: [task("x", { owner: "Unassigned", dueDate: "2026-11-01" })] });
    const l0 = reviewLists(before, TODAY);
    expect(stepCounts(l0)).toEqual({ clarify: 1, waiting: 0, overdue: 1, maybe: 0, write: 0 });
    const after = board({ tasks: [task("x", { owner: "Anna", assignees: ["Anna"], dueDate: "2026-12-01" })] });
    expect(stepCounts(reviewLists(after, TODAY))).toEqual({ clarify: 0, waiting: 0, overdue: 0, maybe: 0, write: 0 });
  });
});

describe("step 5: the week's summary", () => {
  it("counts this Monday–Sunday week's done tasks, open, waiting and Weekly items", () => {
    const now = new Date(2026, 10, 27, 12); // Fri 27 Nov 2026
    const at = (y: number, m: number, d: number) => new Date(y, m, d, 10).getTime();
    const b = board({
      tasks: [
        task("mon", { status: "DONE", doneAt: at(2026, 10, 23) }),
        task("fri", { status: "DONE", doneAt: at(2026, 10, 27) }),
        task("last-sun", { status: "DONE", doneAt: at(2026, 10, 22) }),
        task("open", {}),
        task("wait", { status: "WAITING" }),
        task("maybe", { status: "MAYBE" }),
      ],
      weekly: { well: [{ id: "1", text: "a" }], learnings: [], improve: [], blockers: [{ id: "2", text: "b" }], focus: [] },
    });
    expect(weekSummary(b, now)).toEqual({ doneThisWeek: 2, open: 3, waiting: 1, weeklyItems: 2 });
  });
});
