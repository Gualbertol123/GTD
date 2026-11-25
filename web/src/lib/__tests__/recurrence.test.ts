import { describe, expect, it } from "vitest";
import { expandOp, nextDue, parseRule, ruleLabel } from "../recurrence";
import { createSend, type BoardCell } from "../optimisticSend";
import type { Board, Op } from "../types";
import { board, task } from "./fixtures";

describe("nextDue", () => {
  it("daily: the day after the due date when done on time", () => {
    expect(nextDue({ freq: "daily", every: 1 }, "2026-11-25", "2026-11-25")).toBe("2026-11-26");
  });
  it("daily: done late, skips the missed days", () => {
    expect(nextDue({ freq: "daily", every: 1 }, "2026-11-20", "2026-11-25")).toBe("2026-11-26");
    expect(nextDue({ freq: "daily", every: 3 }, "2026-11-20", "2026-11-25")).toBe("2026-11-26");
  });
  it("no due date: counted from the day it is done", () => {
    expect(nextDue({ freq: "weekly", every: 1 }, undefined, "2026-11-25")).toBe("2026-12-02");
  });
  it("weekly: done early keeps the schedule", () => {
    expect(nextDue({ freq: "weekly", every: 1 }, "2026-11-30", "2026-11-25")).toBe("2026-12-07");
  });
  it("weekly on chosen days (Mon, Thu)", () => {
    // 2026-11-23 is a Monday.
    expect(nextDue({ freq: "weekly", every: 1, days: [0, 3] }, "2026-11-23", "2026-11-23")).toBe("2026-11-26");
    expect(nextDue({ freq: "weekly", every: 1, days: [0, 3] }, "2026-11-26", "2026-11-26")).toBe("2026-11-30");
  });
  it("weekdays skip the weekend", () => {
    // 2026-11-27 is a Friday.
    expect(nextDue({ freq: "weekly", every: 1, days: [0, 1, 2, 3, 4] }, "2026-11-27", "2026-11-27")).toBe("2026-11-30");
  });
  it("every 2 weeks on Monday", () => {
    expect(nextDue({ freq: "weekly", every: 2, days: [0] }, "2026-11-23", "2026-11-23")).toBe("2026-12-07");
  });
  it("monthly keeps its day, clamped at month end", () => {
    expect(nextDue({ freq: "monthly", every: 1 }, "2026-01-31", "2026-01-31")).toBe("2026-02-28");
    // The anchor stays the 31st, not the clamped 28th.
    expect(nextDue({ freq: "monthly", every: 1 }, "2026-01-31", "2026-03-01")).toBe("2026-03-31");
  });
  it("yearly", () => {
    expect(nextDue({ freq: "yearly", every: 1 }, "2026-03-10", "2026-03-10")).toBe("2027-03-10");
  });
});

describe("parseRule", () => {
  it("rejects junk and cleans values", () => {
    expect(parseRule(null)).toBeUndefined();
    expect(parseRule({ freq: "hourly" })).toBeUndefined();
    expect(parseRule({ freq: "weekly", every: 0, days: [3, 3, 9, 1] })).toEqual({ freq: "weekly", every: 1, days: [1, 3] });
  });
});

describe("ruleLabel", () => {
  it("reads naturally", () => {
    expect(ruleLabel({ freq: "weekly", every: 1, days: [0, 3] }, "it")).toBe("Ogni settimana · lun, gio");
    expect(ruleLabel({ freq: "monthly", every: 2 }, "en")).toBe("Every 2 months");
    expect(ruleLabel({ freq: "weekly", every: 1, days: [0, 1, 2, 3, 4] }, "en")).toBe("Every week · weekdays");
  });
});

const NOW = new Date(2026, 10, 25, 10).getTime(); // 25 Nov 2026

describe("expandOp", () => {
  const rec = task("r1", { recurrence: { freq: "weekly", every: 1 }, dueDate: "2026-11-25", pinned: true, status: "IN PROGRESS" });

  it("leaves ordinary tasks alone", () => {
    const op: Op = { type: "moveTask", id: "a", status: "DONE" };
    expect(expandOp(board({ tasks: [task("a")] }), op, NOW)).toEqual([op]);
  });

  it("completing a recurring task adds the next occurrence", () => {
    const ops = expandOp(board({ tasks: [rec] }), { type: "moveTask", id: "r1", status: "DONE" }, NOW);
    expect(ops).toHaveLength(2);
    const add = ops[1];
    expect(add.type).toBe("addTask");
    if (add.type !== "addTask") return;
    expect(add.task.id).toBe("r1@2026-12-02");
    expect(add.task.status).toBe("NEXT");
    expect(add.task.dueDate).toBe("2026-12-02");
    expect(add.task.pinned).toBe(true);
    expect(add.task.recurrence?.series).toBe("r1");
    expect(add.task.updatedAt).toBeLessThan(add.task.createdAt!);
  });

  it("does not add it twice", () => {
    const b = board({ tasks: [rec, task("r1@2026-12-02")] });
    expect(expandOp(b, { type: "moveTask", id: "r1", status: "DONE" }, NOW)).toHaveLength(1);
  });

  it("subtasks start unticked", () => {
    const t = { ...rec, subtasks: [{ id: "s", text: "x", done: true, doneAt: 5 }] };
    const ops = expandOp(board({ tasks: [t] }), { type: "moveTask", id: "r1", status: "DONE" }, NOW);
    const add = ops[1];
    if (add.type !== "addTask") throw new Error("no add");
    expect(add.task.subtasks).toEqual([{ id: "s", text: "x", done: false }]);
  });

  function setup(start: Board) {
    const cell: BoardCell = { current: start };
    const writes: Op[] = [];
    const send = createSend({
      cell,
      publish: () => {},
      write: (op) => {
        writes.push(op);
        return Promise.resolve();
      },
      onFail: () => {},
    });
    return { cell, writes, send };
  }

  it("reopening takes back the untouched next occurrence", () => {
    const s = setup(board({ tasks: [rec] }));
    s.send({ type: "moveTask", id: "r1", status: "DONE" });
    expect(s.cell.current!.tasks.map((t) => t.id)).toContain("r1@" + nextDue(rec.recurrence!, rec.dueDate, todayISO()));
    s.send({ type: "moveTask", id: "r1", status: "IN PROGRESS" });
    expect(s.cell.current!.tasks.map((t) => t.id)).toEqual(["r1"]);
    expect(s.writes.map((w) => w.type)).toEqual(["moveTask", "addTask", "moveTask", "deleteTask"]);
  });

  it("reopening keeps a next occurrence someone already changed", () => {
    const s = setup(board({ tasks: [rec] }));
    s.send({ type: "moveTask", id: "r1", status: "DONE" });
    const nextId = s.cell.current!.tasks.find((t) => t.id !== "r1")!.id;
    s.send({ type: "updateTask", id: nextId, patch: { notes: "started" } });
    s.send({ type: "moveTask", id: "r1", status: "NEXT" });
    expect(s.cell.current!.tasks.map((t) => t.id)).toEqual(["r1", nextId]);
  });
});

function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
