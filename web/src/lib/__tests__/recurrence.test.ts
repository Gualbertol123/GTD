import { describe, expect, it } from "vitest";
import { expandOp, isUpcoming, nextDue, nextOccurrence, parseRule, ruleLabel, visibleBoard } from "../recurrence";
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

  it("reopening takes back the untouched next occurrence", async () => {
    const s = setup(board({ tasks: [rec] }));
    s.send({ type: "moveTask", id: "r1", status: "DONE" });
    expect(s.cell.current!.tasks.map((t) => t.id)).toContain("r1@" + nextDue(rec.recurrence!, rec.dueDate, todayISO()));
    s.send({ type: "moveTask", id: "r1", status: "IN PROGRESS" });
    expect(s.cell.current!.tasks.map((t) => t.id)).toEqual(["r1"]);
    await new Promise((r) => setTimeout(r, 0)); // the writes go out in order, after the optimistic change
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

describe("monthly and yearly keep their day", () => {
  const t = (id: string, due: string, freq: "monthly" | "yearly") =>
    task(id, { status: "NEXT", dueDate: due, recurrence: { freq, every: 1 } });
  // Complete each occurrence on its due date and follow the series.
  const follow = (first: ReturnType<typeof t>, n: number) => {
    const dues: string[] = [];
    let cur = first;
    for (let i = 0; i < n; i++) {
      cur = nextOccurrence(cur, cur.dueDate!, 0);
      dues.push(cur.dueDate!);
    }
    return dues;
  };

  it("every month on the 31st comes back to the 31st after February", () => {
    expect(follow(t("m", "2027-01-31", "monthly"), 4)).toEqual(["2027-02-28", "2027-03-31", "2027-04-30", "2027-05-31"]);
  });

  it("every year on 29 February comes back to the 29th in a leap year", () => {
    expect(follow(t("y", "2028-02-29", "yearly"), 4)).toEqual(["2029-02-28", "2030-02-28", "2031-02-28", "2032-02-29"]);
  });

  it("a due date moved by hand becomes the new day", () => {
    const moved = { ...t("m", "2027-03-15", "monthly"), recurrence: { freq: "monthly" as const, every: 1, anchor: 31 } };
    expect(nextOccurrence(moved, "2027-03-15", 0).dueDate).toBe("2027-04-15");
  });
});

describe("next occurrence shown on its day (owner's rule, 2026-11-27)", () => {
  const rec = task("r1", { recurrence: { freq: "weekly", every: 1 }, dueDate: "2026-11-25", pinned: true, status: "IN PROGRESS" });
  const next = () => {
    const ops = expandOp(board({ tasks: [rec] }), { type: "moveTask", id: "r1", status: "DONE" }, NOW);
    if (ops[1]?.type !== "addTask") throw new Error("no add");
    return ops[1].task;
  };

  it("the ★ copy is off the screens until it is due, then back", () => {
    const n = next(); // due 2026-12-02
    const done = { ...rec, status: "DONE" as const };
    const b = board({ tasks: [done, n] });
    const before = visibleBoard(b, "2026-11-25");
    expect(before.tasks.map((t) => t.id)).toEqual(["r1"]);
    expect(before.upcoming?.map((t) => t.id)).toEqual([n.id]);
    expect(visibleBoard(b, "2026-12-01").tasks).toHaveLength(1);
    expect(visibleBoard(b, "2026-12-02").tasks.map((t) => t.id)).toEqual(["r1", n.id]);
    expect(visibleBoard(b, "2026-12-02").upcoming).toBeUndefined();
  });

  it("a copy someone changed shows at once", () => {
    const n = { ...next(), updatedAt: NOW + 5 };
    expect(isUpcoming(n, "2026-11-25")).toBe(false);
  });

  it("a recurring task made by hand, due later, shows", () => {
    expect(isUpcoming(task("r2", { recurrence: { freq: "weekly", every: 1 }, dueDate: "2026-12-30", createdAt: 10, updatedAt: 5 }), "2026-11-25")).toBe(false);
  });

  it("a board with nothing hidden is handed on unchanged", () => {
    const b = board({ tasks: [rec] });
    expect(visibleBoard(b, "2026-11-25")).toBe(b);
  });
});
