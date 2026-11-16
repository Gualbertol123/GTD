import { describe, expect, it, vi } from "vitest";
import { createSend, type BoardCell } from "../optimisticSend";
import type { Board, Op } from "../types";
import { board, task } from "./fixtures";

function setup(start: Board) {
  const cell: BoardCell = { current: start };
  const published: Board[] = [];
  const writes: { op: Op; before: Board }[] = [];
  const onFail = vi.fn();
  let fail = false;
  const send = createSend({
    cell,
    publish: (b) => published.push(b),
    write: (op, before) => {
      writes.push({ op, before });
      return fail ? Promise.reject(new Error("refused")) : Promise.resolve();
    },
    onFail,
  });
  return { cell, published, writes, onFail, send, failNext: () => (fail = true) };
}

describe("createSend", () => {
  it("keeps both of two sends made in the same tick", () => {
    const s = setup(board({ tasks: [task("a")] }));
    s.send({ type: "addTask", task: task("b") });
    s.send({ type: "addTask", task: task("c") });
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
    await Promise.resolve();
    await Promise.resolve();
    expect(onError).toHaveBeenCalledWith("refused");
    expect(s.onFail).toHaveBeenCalledWith("refused");
  });

  it("does nothing before the board has loaded", () => {
    const s = setup(board());
    s.cell.current = null;
    s.send({ type: "addTask", task: task("b") });
    expect(s.writes).toHaveLength(0);
  });
});
