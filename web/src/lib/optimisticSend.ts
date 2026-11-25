import type { Board, Op } from "./types";
import { applyOpLocal } from "./localReducer";
import { expandOp } from "./recurrence";

export interface BoardCell {
  /** The newest board, ahead of React's render: every change lands here first. */
  current: Board | null;
}

export interface SendDeps {
  cell: BoardCell;
  /** Publishes the new board to React state (cell.current is already set). */
  publish: (board: Board) => void;
  /** Persists the op; `before` is the board the op was applied to. */
  write: (op: Op, before: Board) => Promise<void>;
  /** Called once a write is refused (after it is reported to the caller). */
  onFail: (message: string) => void;
}

// Optimistic send. Each op is applied to the newest board synchronously, so
// several sends in one tick (an Undo that restores many rows, "turn into
// tasks") all stack up instead of each one starting from the last render.
export function createSend(deps: SendDeps) {
  const one = (op: Op, onError?: (message: string) => void): void => {
    const before = deps.cell.current;
    if (!before) return;
    const next = applyOpLocal(before, op);
    deps.cell.current = next;
    deps.publish(next);
    deps.write(op, before).catch((e: unknown) => {
      const message = errMsg(e);
      // The banner at the top of the page is easy to miss, so let the caller
      // tell the person right where they acted that it did not save.
      onError?.(message);
      deps.onFail(message);
    });
  };
  return (op: Op, onError?: (message: string) => void): void => {
    const before = deps.cell.current;
    if (!before) return;
    // A recurring task's completion also adds its next occurrence (lib/recurrence.ts).
    for (const o of expandOp(before, op)) one(o, onError);
  };
}

export function errMsg(e: unknown): string {
  if (e && typeof e === "object" && "message" in e)
    return String((e as { message: unknown }).message);
  return String(e);
}
