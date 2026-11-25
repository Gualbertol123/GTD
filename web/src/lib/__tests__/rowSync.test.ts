import { describe, expect, it } from "vitest";
import { applyRowChange, reconcileBoard, sameData } from "../rowSync";
import { applyOpLocal } from "../localReducer";
import { board, project, task } from "./fixtures";

describe("applyRowChange", () => {
  it("replaces a changed task in place", () => {
    const b = board({ tasks: [task("a"), task("b")] });
    const next = applyRowChange(b, { table: "tasks", id: "a", row: task("a", { title: "new" }) });
    expect(next.tasks.map((t) => t.title)).toEqual(["new", "Task b"]);
  });

  it("inserts a new task in createdAt order", () => {
    const b = board({ tasks: [task("a", { createdAt: 10 }), task("c", { createdAt: 30 })] });
    const next = applyRowChange(b, { table: "tasks", id: "b", row: task("b", { createdAt: 20 }) });
    expect(next.tasks.map((t) => t.id)).toEqual(["a", "b", "c"]);
  });

  it("removes a deleted task, and ignores deleting one it does not have", () => {
    const b = board({ tasks: [task("a"), task("b")] });
    expect(applyRowChange(b, { table: "tasks", id: "a", row: null }).tasks.map((t) => t.id)).toEqual(["b"]);
    expect(applyRowChange(b, { table: "tasks", id: "zz", row: null }).tasks).toBe(b.tasks);
  });

  it("updates projects the same way", () => {
    const b = board({ projects: [project("p")] });
    const next = applyRowChange(b, { table: "projects", id: "p", row: project("p", { name: "Renamed" }) });
    expect(next.projects[0].name).toBe("Renamed");
  });

  it("adds, edits and deletes weekly items in their bucket", () => {
    let b = board();
    b = applyRowChange(b, { table: "weekly", id: "w", row: { bucket: "well", item: { id: "w", text: "one" } } });
    b = applyRowChange(b, { table: "weekly", id: "w", row: { bucket: "well", item: { id: "w", text: "two" } } });
    expect(b.weekly.well).toEqual([{ id: "w", text: "two" }]);
    b = applyRowChange(b, { table: "weekly", id: "w", row: null });
    expect(b.weekly.well).toEqual([]);
  });

  it("merges board settings", () => {
    const b = board();
    const next = applyRowChange(b, { table: "board_meta", meta: { boardName: "New", members: ["X"] } });
    expect(next.boardName).toBe("New");
    expect(next.members).toEqual(["X"]);
    expect(next.tasks).toBe(b.tasks);
  });

  it("keeps every other task's object when one task changes", () => {
    const b = board({ tasks: [task("a"), task("b")] });
    const next = applyRowChange(b, { table: "tasks", id: "a", row: task("a", { title: "new" }) });
    expect(next.tasks[1]).toBe(b.tasks[1]);
  });
});

// A deep copy, the way a full reload builds the board from fresh rows.
const copy = <T,>(x: T): T => JSON.parse(JSON.stringify(x));

describe("sameData", () => {
  it("compares plain data deeply", () => {
    expect(sameData({ a: [1, { b: "x" }] }, { a: [1, { b: "x" }] })).toBe(true);
    expect(sameData({ a: [1, { b: "x" }] }, { a: [1, { b: "y" }] })).toBe(false);
    expect(sameData([1, 2], [1, 2, 3])).toBe(false);
    expect(sameData({ a: 1 }, { a: 1, b: 2 })).toBe(false);
    expect(sameData(null, {})).toBe(false);
    expect(sameData([], {})).toBe(false);
  });

  it("treats a key holding undefined as absent", () => {
    expect(sameData({ a: 1, due: undefined }, { a: 1 })).toBe(true);
    expect(sameData({ a: 1 }, { a: 1, due: "2026-01-01" })).toBe(false);
  });

  it("never equates objects that are not plain data", () => {
    expect(sameData(new Date(0), new Date(0))).toBe(false);
    const d = new Date(0);
    expect(sameData(d, d)).toBe(true);
  });
});

describe("reconcileBoard", () => {
  const sample = () =>
    board({
      tasks: [
        task("a", { subtasks: [{ id: "s", text: "one", done: false }] }),
        task("b", { projectId: "p", recurrence: { freq: "weekly", every: 1, days: [4] } }),
        task("c"),
      ],
      projects: [project("p", { taskOrder: ["b"] })],
      updatedAt: 1,
    });

  it("returns the board on screen when a reload finds nothing new", () => {
    const prev = sample();
    const fresh = { ...copy(prev), updatedAt: 2 }; // reloads stamp the time
    expect(reconcileBoard(prev, fresh)).toBe(prev);
  });

  it("gives back the new board when there is no board yet", () => {
    const b = sample();
    expect(reconcileBoard(null, b)).toBe(b);
  });

  it("only the changed task is a new object", () => {
    const prev = sample();
    const fresh = copy(prev);
    fresh.tasks[1].title = "Renamed elsewhere";
    const next = reconcileBoard(prev, fresh);
    expect(next).not.toBe(prev);
    expect(next.tasks).not.toBe(prev.tasks);
    expect(next.tasks[0]).toBe(prev.tasks[0]);
    expect(next.tasks[1]).toBe(fresh.tasks[1]);
    expect(next.tasks[1].title).toBe("Renamed elsewhere");
    expect(next.tasks[2]).toBe(prev.tasks[2]);
    // Untouched parts of the board keep their objects too.
    expect(next.projects).toBe(prev.projects);
    expect(next.members).toBe(prev.members);
    expect(next.weekly).toBe(prev.weekly);
  });

  it("follows the new list for added, removed and reordered tasks", () => {
    const prev = sample();
    const fresh = copy(prev);
    fresh.tasks = [fresh.tasks[2], fresh.tasks[0], task("d")]; // b gone, d new, c moved up
    const next = reconcileBoard(prev, fresh);
    expect(next.tasks.map((t) => t.id)).toEqual(["c", "a", "d"]);
    expect(next.tasks[0]).toBe(prev.tasks[2]);
    expect(next.tasks[1]).toBe(prev.tasks[0]);
    expect(next.tasks[2]).toBe(fresh.tasks[2]);
  });

  it("sees a change deep inside a task (a subtask ticked)", () => {
    const prev = sample();
    const fresh = copy(prev);
    fresh.tasks[0].subtasks[0].done = true;
    const next = reconcileBoard(prev, fresh);
    expect(next.tasks[0]).toBe(fresh.tasks[0]);
    expect(next.tasks[0].subtasks[0].done).toBe(true);
  });

  it("sees a field that went away (a due date cleared)", () => {
    const prev = board({ tasks: [task("a", { dueDate: "2026-12-01" })] });
    const fresh = copy(prev);
    delete fresh.tasks[0].dueDate;
    const next = reconcileBoard(prev, fresh);
    expect(next).not.toBe(prev);
    expect(next.tasks[0].dueDate).toBeUndefined();
  });

  it("sees a board field that went away", () => {
    const prev = board({ logoUrl: "x.png" });
    const fresh = copy(prev);
    delete fresh.logoUrl;
    const next = reconcileBoard(prev, fresh);
    expect(next).not.toBe(prev);
    expect(next.logoUrl).toBeUndefined();
  });

  it("an optimistic op re-renders only the task it touches", () => {
    // applyOpLocal copies every task; reconciling keeps the untouched ones.
    const prev = sample();
    const next = reconcileBoard(prev, applyOpLocal(prev, { type: "moveTask", id: "c", status: "DONE" }));
    expect(next.tasks[0]).toBe(prev.tasks[0]);
    expect(next.tasks[1]).toBe(prev.tasks[1]);
    expect(next.tasks[2]).not.toBe(prev.tasks[2]);
    expect(next.tasks[2].status).toBe("DONE");
  });

  it("always carries next's values", () => {
    const prev = sample();
    const fresh = copy(prev);
    fresh.boardName = "Renamed";
    fresh.projects[0].name = "New name";
    const next = reconcileBoard(prev, fresh);
    expect(next).toEqual({ ...fresh });
    expect(next.tasks).toBe(prev.tasks);
  });
});
