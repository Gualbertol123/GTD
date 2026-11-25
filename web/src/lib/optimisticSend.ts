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
  /** Offline right now? Then a send is refused up front (default: never). */
  offline?: () => boolean;
  /** The reason handed to onError for an offline refusal, in the UI language. */
  offlineReason?: () => string;
  /** A send refused because the device is offline: nothing was applied or
   *  sent. `handled`: the caller passed onError and tells the person itself. */
  onOffline?: (message: string, handled: boolean) => void;
}

/** The browser says there is no network (navigator.onLine is false). */
export function isOffline(): boolean {
  return typeof navigator !== "undefined" && navigator.onLine === false;
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
//
// Offline, a send is refused UP FRONT: nothing changes on screen, nothing is
// sent, queued or stored, and the caller's onError (or the shared "not saved"
// toast) says the change was not made. It used to look saved, then vanish on
// reconnect. The report comes a moment later (a microtask), after whatever
// the caller does next (a "Done · Undo" toast), so it is the message left.
// onError gets the readable message and the error itself (its `code` tells a
// missing column, PGRST204 / 42703, from a refusal); onSaved runs once every
// write of the op has been accepted, for a screen that says "done" only then.
export type SendError = (message: string, error: unknown) => void;
export type Send = ((op: Op, onError?: SendError, onSaved?: () => void) => void) & {
  /** Ops sent but not yet confirmed by the server, oldest first. */
  pending: () => Op[];
};

export function createSend(deps: SendDeps): Send {
  let queue: Promise<void> = Promise.resolve();
  const unconfirmed: Op[] = [];
  const settle = (op: Op) => {
    const i = unconfirmed.indexOf(op);
    if (i >= 0) unconfirmed.splice(i, 1);
  };
  const send = (op: Op, onError?: SendError, onSaved?: () => void): void => {
    const first = deps.cell.current;
    if (!first) return;
    if (deps.offline?.()) {
      const message = deps.offlineReason?.() ?? "offline";
      queueMicrotask(() => {
        onError?.(message, { code: "offline" });
        deps.onOffline?.(message, !!onError);
      });
      return;
    }
    // A recurring task's completion also adds its next occurrence (lib/recurrence.ts).
    const steps: { op: Op; before: Board }[] = [];
    for (const o of expandOp(first, op).flatMap((x) => withLinkOrder(first, x))) {
      const before = deps.cell.current!;
      deps.cell.current = applyOpLocal(before, o);
      steps.push({ op: o, before });
    }
    deps.publish(deps.cell.current!);
    unconfirmed.push(...steps.map((s) => s.op));
    queue = queue.then(async () => {
      for (let i = 0; i < steps.length; i++) {
        const s = steps[i];
        try {
          await deps.write(s.op, s.before);
          settle(s.op);
        } catch (e: unknown) {
          for (const r of steps.slice(i)) settle(r.op); // refused, and the rest of the group is dropped
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
          onError?.(message, e);
          deps.onFail(message, !!onError);
          return; // the rest of this group stays unsent
        }
      }
      onSaved?.();
    });
  };
  send.pending = () => unconfirmed.slice();
  return send;
}

// Ops that set values, so applying one again on top of a row re-read from
// the server is harmless: used to keep a pending local change on screen when
// the echo of an earlier write (or a poll) brings back the row without it.
const REAPPLY = new Set<Op["type"]>(["updateTask", "moveTask", "setDueDate", "updateSubtask", "reorderSubtasks", "deleteSubtask", "deleteTask", "weeklyUpdate", "weeklyDelete", "projectUpdate", "noteUpdate", "noteDelete"]);

/** `board` (fresh from the server) with the still-unconfirmed local ops on top. */
export function withPending(board: Board, ops: Op[]): Board {
  return ops.reduce((b, op) => (REAPPLY.has(op.type) ? applyOpLocal(b, op) : b), board);
}

/** The request never reached the server (offline, DNS, a dropped connection):
 *  the browser's own wording, which means nothing to the person reading it. */
export function isNetworkError(message: string): boolean {
  return /failed to fetch|fetch failed|networkerror|network request failed|load failed|internet_disconnected|err_network/i.test(message);
}

export function errMsg(e: unknown): string {
  if (e && typeof e === "object" && "message" in e)
    return String((e as { message: unknown }).message);
  return String(e);
}
