import { describe, expect, it } from "vitest";
import { MAX_HIGHLIGHTS, highlightCandidates, starredHighlights } from "../glassReportModel";
import { collectReport } from "../reportData";
import type { Board } from "../types";
import { board, task } from "./fixtures";

// The cover's «Da sottolineare» list starts from the board's ★ tasks.
const PERIOD = { from: "2026-11-23", to: "2026-11-29" };
const inPeriod = new Date(2026, 10, 25, 12).getTime();
const before = new Date(2026, 10, 10, 12).getTime();

function starred(b: Board): string[] {
  return starredHighlights(highlightCandidates(b, collectReport(b, PERIOD)));
}

describe("«Da sottolineare» before anyone picks", () => {
  it("is the ★ tasks the picker offers, in the picker's order", () => {
    const b = board({
      tasks: [
        task("next", { status: "NEXT", pinned: true }),
        task("waiting", { status: "WAITING", pinned: true }),
        task("prog", { status: "IN PROGRESS", pinned: true }),
        task("done", { status: "DONE", doneAt: inPeriod, pinned: true }),
        task("plain", { status: "NEXT" }),
      ],
    });
    // Completed, in progress, next, waiting — as the picker groups them.
    expect(starred(b)).toEqual(["done", "prog", "next", "waiting"]);
  });

  it("leaves out ★ tasks the picker does not offer", () => {
    const b = board({
      tasks: [
        task("backlog", { status: "BACKLOG", pinned: true }),
        task("maybe", { status: "MAYBE", pinned: true }),
        task("oldDone", { status: "DONE", doneAt: before, pinned: true }),
        task("next", { status: "NEXT", pinned: true }),
      ],
    });
    expect(starred(b)).toEqual(["next"]);
  });

  it("keeps at most the picker's maximum", () => {
    const tasks = Array.from({ length: 11 }, (_, i) => task(`t${i}`, { status: "NEXT", pinned: true }));
    const got = starred(board({ tasks }));
    expect(got).toHaveLength(MAX_HIGHLIGHTS);
    // The first ones, as the picker lists them.
    const offered = highlightCandidates(board({ tasks }), collectReport(board({ tasks }), PERIOD)).flatMap((g) => g.tasks.map((t) => t.id));
    expect(got).toEqual(offered.slice(0, MAX_HIGHLIGHTS));
  });

  it("is empty when nothing is starred", () => {
    expect(starred(board({ tasks: [task("a"), task("b", { status: "DONE", doneAt: inPeriod })] }))).toEqual([]);
  });
});
