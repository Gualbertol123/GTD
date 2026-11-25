import type { Board, Op } from "./types";
import { applyOpLocal } from "./localReducer";
import { expandOp } from "./recurrence";
import { withLinkOrder } from "./projects";

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
  /** Called once a write is refused (after it is reported to the caller).
   *  `handled`: the caller passed onError and tells the person itself. */
  onFail: (message: string, handled: boolean) => void;
}

// Optimistic send. Each op is applied to the newest board synchronously, so
// several sends in one tick (an Undo that restores many rows, "turn into
// tasks") all stack up instead of each one starting from the last render.
//
// The writes then go out ONE AT A TIME, in the order sent. They used to go in
// parallel and could land out of order: Undo of a project delete re-linked
// its tasks before the project row was back (refused, links lost), Undo of a
// subtask delete re-ordered before re-adding. And the ops one send expands
// to (a recurring task's completion + its next occurrence) are a group: if
// one is refused, the rest of the group is not sent, so a refused completion
// no longer leaves a second copy of the task behind.
export function createSend(deps: SendDeps) {
  let queue: Promise<void> = Promise.resolve();
  return (op: Op, onError?: (message: string) => void): void => {
    const first = deps.cell.current;
    if (!first) return;
    // A recurring task's completion also adds its next occurrence (lib/recurrence.ts).
    const steps: { op: Op; before: Board }[] = [];
    for (const o of expandOp(first, op).flatMap((x) => withLinkOrder(first, x))) {
      const before = deps.cell.current!;
      deps.cell.current = applyOpLocal(before, o);
      steps.push({ op: o, before });
    }
    deps.publish(deps.cell.current!);
    queue = queue.then(async () => {
      for (let i = 0; i < steps.length; i++) {
        const s = steps[i];
        try {
          await deps.write(s.op, s.before);
        } catch (e: unknown) {
          const message = errMsg(e);
          // Part of a group already went through (a recurring completion
          // whose next occurrence was refused): put the completion back, so
          // the series doesn't silently end. Best effort; the reload that
          // follows shows whatever the server holds.
          const head = steps[0];
          const headOp = head.op;
          if (i > 0 && headOp.type === "moveTask") {
            const was = head.before.tasks.find((t) => t.id === headOp.id);
            if (was) await deps.write({ type: "moveTask", id: was.id, status: was.status }, steps[i].before).catch(() => {});
          }
          // Tell the person right where they acted, when the caller can.
          onError?.(message);
          deps.onFail(message, !!onError);
          return; // the rest of this group stays unsent
        }
      }
    });
  };
}

export function errMsg(e: unknown): string {
  if (e && typeof e === "object" && "message" in e)
    return String((e as { message: unknown }).message);
  return String(e);
}
