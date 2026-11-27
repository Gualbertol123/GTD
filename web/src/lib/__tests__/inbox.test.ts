import { describe, expect, it } from "vitest";
import { ALL_STATUSES, STATUS_HELP, STATUS_LABEL, STATUS_ORDER } from "../constants";
import { statusLabel } from "../i18n";
import {
  INBOX,
  SORT_TARGETS,
  capturedDaysAgo,
  inboxTasks,
  isCaptureKey,
  isInbox,
  newInboxTask,
} from "../inbox";
import { applyOpLocal } from "../localReducer";
import { TASK_STATUS_COLOR, boardTasks, currentStep, projectStats } from "../projects";
import { reviewLists, toClarify, weekSummary } from "../weeklyReview";
import { coverStats } from "../glassReportModel";
import { collectReport } from "../reportData";
import { board, project, task } from "./fixtures";

describe("Inbox: the status", () => {
  it("is a status but not a BOARD column", () => {
    expect(STATUS_ORDER).not.toContain(INBOX);
    expect(STATUS_ORDER).toEqual(["BACKLOG", "NEXT", "IN PROGRESS", "WAITING", "DONE", "MAYBE"]);
    expect(ALL_STATUSES).toEqual(["INBOX", ...STATUS_ORDER]);
  });

  it("has a label and a colour everywhere a status is looked up", () => {
    expect(statusLabel("it", "INBOX")).toBe("Inbox");
    expect(statusLabel("en", "INBOX")).toBe("Inbox");
    for (const s of ALL_STATUSES) {
      expect(STATUS_LABEL[s]).toBeTruthy();
      expect(STATUS_HELP[s]).toBeTruthy();
      expect(TASK_STATUS_COLOR[s]).toMatch(/^#[0-9A-F]{6}$/i);
    }
  });

  it("sorts to every column, Done included, and never to itself", () => {
    expect(SORT_TARGETS).toEqual(["BACKLOG", "NEXT", "IN PROGRESS", "WAITING", "MAYBE", "DONE"]);
    expect(SORT_TARGETS).not.toContain(INBOX);
    expect([...SORT_TARGETS].sort()).toEqual([...STATUS_ORDER].sort());
  });
});

describe("Inbox: capture", () => {
  it("a captured task: title only, mine, P2, no date, not highlighted", () => {
    const tk = newInboxTask("  Call the bank  ", "Marco", ["Anna", "Marco"], 1000);
    expect(tk).toMatchObject({
      title: "Call the bank",
      status: "INBOX",
      owner: "Marco",
      assignees: ["Marco"],
      priority: "P2",
      desc: "",
      notes: "",
      subtasks: [],
      createdAt: 1000,
      updatedAt: 1000,
    });
    expect(tk.dueDate).toBeUndefined();
    expect(tk.pinned).toBeUndefined();
    expect(tk.recurrence).toBeUndefined();
    expect(tk.id).toBeTruthy();
  });

  it("is Unassigned when this device has no (known) name", () => {
    expect(newInboxTask("x", null, ["Anna"]).owner).toBe("Unassigned");
    expect(newInboxTask("x", "Ghost", ["Anna"]).owner).toBe("Unassigned");
  });

  it("the I key opens it, unless typed in a field or with Ctrl / Cmd / Alt", () => {
    const at = (tag: string, editable = false) =>
      ({ isContentEditable: editable, closest: (sel: string) => (sel.split(",").some((s) => s.trim() === tag) ? {} : null) }) as unknown as EventTarget;
    expect(isCaptureKey({ key: "i", target: at("div") })).toBe(true);
    expect(isCaptureKey({ key: "I", target: at("button") })).toBe(true);
    expect(isCaptureKey({ key: "i", target: null })).toBe(true);
    expect(isCaptureKey({ key: "j", target: at("div") })).toBe(false);
    expect(isCaptureKey({ key: "i", ctrlKey: true })).toBe(false);
    expect(isCaptureKey({ key: "i", metaKey: true })).toBe(false);
    expect(isCaptureKey({ key: "i", altKey: true })).toBe(false);
    expect(isCaptureKey({ key: "i", repeat: true })).toBe(false);
    expect(isCaptureKey({ key: "i", defaultPrevented: true })).toBe(false);
    expect(isCaptureKey({ key: "i", target: at("input") })).toBe(false);
    expect(isCaptureKey({ key: "i", target: at("textarea") })).toBe(false);
    expect(isCaptureKey({ key: "i", target: at("select") })).toBe(false);
    expect(isCaptureKey({ key: "i", target: at("div", true) })).toBe(false);
  });
});

describe("Inbox: the list", () => {
  it("only INBOX tasks, oldest first", () => {
    const list = inboxTasks([
      task("b", { status: "INBOX", createdAt: 20 }),
      task("n", { status: "NEXT", createdAt: 1 }),
      task("a", { status: "INBOX", createdAt: 10 }),
    ]);
    expect(list.map((t) => t.id)).toEqual(["a", "b"]);
    expect(isInbox(list[0])).toBe(true);
  });

  it("says how long ago it was captured, in calendar days", () => {
    const now = new Date(2026, 10, 27, 9, 0);
    expect(capturedDaysAgo({ createdAt: new Date(2026, 10, 27, 8).getTime(), updatedAt: 0 }, now)).toBe(0);
    expect(capturedDaysAgo({ createdAt: new Date(2026, 10, 26, 23).getTime(), updatedAt: 0 }, now)).toBe(1);
    expect(capturedDaysAgo({ createdAt: new Date(2026, 10, 20, 12).getTime(), updatedAt: 0 }, now)).toBe(7);
  });

  it("moving out of the Inbox and back keeps the reducer's rules (WAITING date, DONE time)", () => {
    const b = board({ tasks: [task("t", { status: "INBOX" })] });
    const w = applyOpLocal(b, { type: "moveTask", id: "t", status: "WAITING" });
    expect(w.tasks[0].status).toBe("WAITING");
    expect(w.tasks[0].waitingSince).toBeTruthy();
    const back = applyOpLocal(w, { type: "moveTask", id: "t", status: "INBOX" });
    expect(back.tasks[0].status).toBe("INBOX");
    expect(back.tasks[0].waitingSince).toBeUndefined();
    const done = applyOpLocal(b, { type: "moveTask", id: "t", status: "DONE" });
    expect(done.tasks[0].doneAt).toBeGreaterThan(0);
  });
});

describe("Inbox: projects treat it like Backlog", () => {
  it("counts it per status, as open, and it can be the current step", () => {
    const p = project("p", { boardMode: "sequential", taskOrder: ["i", "d"] });
    const tasks = [task("i", { projectId: "p", status: "INBOX" }), task("d", { projectId: "p", status: "DONE", doneAt: 5 })];
    const s = projectStats(p, tasks);
    expect(s.byStatus.INBOX).toBe(1);
    expect(s.byStatus.DONE).toBe(1);
    expect(Object.values(s.byStatus).every((n) => Number.isFinite(n))).toBe(true);
    expect(s.total).toBe(2);
    expect(s.done).toBe(1);
    expect(s.status).toBe("ongoing");
    expect(currentStep(s.tasks)?.id).toBe("i");
    // It is the step on the board, so the strip shows it.
    expect(boardTasks(board({ projects: [p], tasks })).map((t) => t.id)).toContain("i");
  });

  it("a status this version does not know is not counted per column", () => {
    const s = projectStats(project("p"), [task("x", { projectId: "p", status: "LATER" as never })]);
    expect(Object.values(s.byStatus).every((n) => Number.isFinite(n))).toBe(true);
    expect(s.total).toBe(1);
  });
});

describe("Inbox: the weekly review asks about it first", () => {
  it("step 1 lists the Inbox first, oldest first, then what has no date / no owner", () => {
    const b = board({
      tasks: [
        task("no-due", { priority: "P1" }),
        task("in-2", { status: "INBOX", createdAt: 20, dueDate: "2026-12-01" }),
        task("in-1", { status: "INBOX", createdAt: 10 }),
        task("ok", { dueDate: "2026-12-01" }),
      ],
    });
    const got = toClarify(b);
    expect(got.map((x) => x.task.id)).toEqual(["in-1", "in-2", "no-due"]);
    expect(got[0]).toMatchObject({ inbox: true, noDue: true });
    // A dated Inbox task is still asked about (it needs a status), once.
    expect(got[1]).toMatchObject({ inbox: true, noDue: false });
    expect(got[2]).toMatchObject({ inbox: false });
  });

  it("a sorted task leaves the Inbox group", () => {
    const b = board({ tasks: [task("in", { status: "INBOX", dueDate: "2026-12-01" })] });
    expect(reviewLists(b, "2026-11-27").clarify).toHaveLength(1);
    const sorted = applyOpLocal(b, { type: "moveTask", id: "in", status: "NEXT" });
    expect(reviewLists(sorted, "2026-11-27").clarify).toHaveLength(0);
  });

  it("counts as open, never as done", () => {
    const b = board({ tasks: [task("in", { status: "INBOX" }), task("d", { status: "DONE", doneAt: Date.now() })] });
    const s = weekSummary(b);
    expect(s.open).toBe(1);
    expect(s.doneThisWeek).toBe(1);
  });
});

describe("Inbox: the report leaves it out of its columns", () => {
  it("no Inbox task in Done, Next or the planner; no count broken", () => {
    const b = board({ tasks: [task("in", { status: "INBOX" }), task("n", { status: "NEXT" })] });
    const data = collectReport(b, { from: "2026-11-23", to: "2026-11-29" });
    expect(data.done).toHaveLength(0);
    expect(data.next.map((r) => r.task.id)).toEqual(["n"]);
    expect(data.planner.flatMap((c) => c.tasks.map((t) => t.id))).toEqual(["n"]);
    expect(coverStats(b, data)).toMatchObject({ next: 1, inProgress: 0, waiting: 0 });
  });
});
