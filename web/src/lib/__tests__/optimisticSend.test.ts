import { describe, expect, it, vi } from "vitest";
import { createSend, withPending, type BoardCell } from "../optimisticSend";
import type { Board, Op } from "../types";
import { board, task } from "./fixtures";

function setup(start: Board) {
  const cell: BoardCell = { current: start };
  const published: Board[] = [];
  const writes: { op: Op; before: Board }[] = [];
  const onFail = vi.fn();
  let fail: (op: Op) => boolean = () => false;
  // Each write resolves after a delay that shrinks with every call, so if
  // writes were not queued the later ones would finish first.
  let n = 0;
  const done: string[] = [];
  const send = createSend({
    cell,
    publish: (b) => published.push(b),
    write: (op, before) => {
      writes.push({ op, before });
      const delay = Math.max(0, 30 - 10 * n++);
      return new Promise((res, rej) =>
        setTimeout(() => {
          if (fail(op)) return rej(new Error("refused"));
          done.push(op.type);
          res();
        }, delay)
      );
    },
    onFail,
  });
  return { cell, published, writes, done, onFail, send, failNext: () => (fail = () => true), failWhen: (f: (op: Op) => boolean) => (fail = f) };
}
const flush = () => new Promise((r) => setTimeout(r, 120));

describe("createSend", () => {
  it("keeps both of two sends made in the same tick", async () => {
    const s = setup(board({ tasks: [task("a")] }));
    s.send({ type: "addTask", task: task("b") });
    s.send({ type: "addTask", task: task("c") });
    await flush();
    const ids = (b: Board) => b.tasks.map((t) => t.id);
    expect(ids(s.cell.current!)).toEqual(["a", "b", "c"]);
    // The last published board (what React renders) holds both changes.
    expect(ids(s.published[s.published.length - 1])).toEqual(["a", "b", "c"]);
    // Each write sees the board its own op was applied to.
    expect(ids(s.writes[0].before)).toEqual(["a"]);
    expect(ids(s.writes[1].before)).toEqual(["a", "b"]);
  });

  it("stacks weekly adds sent in one loop", () => {
    const s = setup(board());
    for (const id of ["1", "2", "3"]) s.send({ type: "weeklyAdd", column: "well", item: { id, text: id } });
    expect(s.cell.current!.weekly.well.map((i) => i.id)).toEqual(["1", "2", "3"]);
  });

  it("reports a refused write to the caller and to onFail", async () => {
    const s = setup(board());
    s.failNext();
    const onError = vi.fn();
    s.send({ type: "weeklyAdd", column: "well", item: { id: "x", text: "x" } }, onError);
    await flush();
    expect(onError).toHaveBeenCalledWith("refused");
    expect(s.onFail).toHaveBeenCalledWith("refused", true);
  });

  it("says when nobody else reported a refused write", async () => {
    const s = setup(board());
    s.failNext();
    s.send({ type: "weeklyAdd", column: "well", item: { id: "x", text: "x" } });
    await flush();
    expect(s.onFail).toHaveBeenCalledWith("refused", false);
  });

  it("writes in the order sent, even when a later write would be faster", async () => {
    const s = setup(board({ tasks: [task("a")] }));
    s.send({ type: "addTask", task: task("b") });
    s.send({ type: "updateTask", id: "b", patch: { title: "B" } });
    s.send({ type: "deleteTask", id: "a" });
    await flush();
    expect(s.done).toEqual(["addTask", "updateTask", "deleteTask"]);
  });

  it("does not send the rest of a group after a refused write", async () => {
    // Completing a recurring task expands to [moveTask, addTask(next)].
    const rec = task("r", { status: "NEXT", dueDate: "2026-11-20", recurrence: { freq: "daily", every: 1, series: "r" } } as never);
    const s = setup(board({ tasks: [rec] }));
    s.failWhen((op) => op.type === "moveTask");
    s.send({ type: "moveTask", id: "r", status: "DONE" });
    expect(s.cell.current!.tasks.length).toBe(2); // optimistic: done + next
    await flush();
    expect(s.writes.map((w) => w.op.type)).toEqual(["moveTask"]); // the next one was never inserted
    expect(s.onFail).toHaveBeenCalledTimes(1);
  });

  it("keeps a pending local change on top of a row re-read from the server", async () => {
    const s = setup(board({ tasks: [task("a", { title: "old" })] }));
    s.send({ type: "updateTask", id: "a", patch: { title: "new" } });
    // The server row arrives (an echo of an earlier write) before this write lands.
    const fromServer = board({ tasks: [task("a", { title: "old" })] });
    expect(withPending(fromServer, s.send.pending()).tasks[0].title).toBe("new");
    await flush();
    expect(s.send.pending()).toEqual([]); // confirmed: nothing to re-apply any more
  });

  it("does nothing before the board has loaded", () => {
    const s = setup(board());
    s.cell.current = null;
    s.send({ type: "addTask", task: task("b") });
    expect(s.writes).toHaveLength(0);
  });
});

describe("createSend offline", () => {
  function offlineSetup() {
    const cell: BoardCell = { current: board({ tasks: [task("a")] }) };
    const deps = {
      cell,
      publish: vi.fn(),
      write: vi.fn(() => Promise.resolve()),
      onFail: vi.fn(),
      offline: () => true,
      offlineReason: () => "you are offline",
      onOffline: vi.fn(),
    };
    return { cell, deps, send: createSend(deps) };
  }

  it("refuses an edit up front: nothing on screen, nothing sent", async () => {
    const { cell, deps, send } = offlineSetup();
    const before = cell.current;
    const onError = vi.fn();
    send({ type: "addTask", task: task("b") }, onError);
    // Reported a moment later, after the caller's own "done" toast.
    expect(onError).not.toHaveBeenCalled();
    await Promise.resolve();
    expect(cell.current).toBe(before);
    expect(deps.publish).not.toHaveBeenCalled();
    expect(deps.write).not.toHaveBeenCalled();
    expect(send.pending()).toEqual([]);
    expect(onError).toHaveBeenCalledWith("you are offline");
    expect(deps.onOffline).toHaveBeenCalledWith("you are offline", true);
    expect(deps.onFail).not.toHaveBeenCalled();
  });

  it("says when nobody else reported the offline refusal", async () => {
    const { deps, send } = offlineSetup();
    send({ type: "moveTask", id: "a", status: "DONE" });
    await Promise.resolve();
    expect(deps.onOffline).toHaveBeenCalledWith("you are offline", false);
  });

  it("goes through again once online", async () => {
    let off = true;
    const { cell, deps } = offlineSetup();
    const send = createSend({ ...deps, offline: () => off });
    send({ type: "addTask", task: task("b") });
    off = false;
    send({ type: "addTask", task: task("c") });
    await flush();
    expect(cell.current!.tasks.map((t) => t.id)).toEqual(["a", "c"]);
    expect(deps.write).toHaveBeenCalledTimes(1);
  });
});
