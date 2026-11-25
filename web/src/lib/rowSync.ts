import type { Board, PersonalNote, Project, Reflection, Task, Weekly, WeeklyItem } from "./types";

// One authoritative change, ready to fold into the board in memory. Built by
// useBoard from a realtime event: a deleted row arrives as null, a changed or
// new row is re-read on its own (never the whole board).
export type RowChange =
  | { table: "tasks"; id: string; row: Task | null }
  | { table: "weekly"; id: string; row: { bucket: keyof Weekly; item: WeeklyItem } | null }
  | { table: "projects"; id: string; row: Project | null }
  | { table: "reflections"; list: Reflection[] }
  | { table: "personal_notes"; list: PersonalNote[]; error?: string }
  | { table: "board_meta"; meta: Partial<Board> };

const WEEKLY_KEYS: (keyof Weekly)[] = ["well", "learnings", "improve", "blockers", "focus"];

/** Replace, insert (in createdAt order) or remove one item by id. */
function upsertById<T extends { id: string; createdAt?: number }>(list: T[], id: string, row: T | null): T[] {
  const i = list.findIndex((x) => x.id === id);
  if (!row) return i < 0 ? list : list.filter((x) => x.id !== id);
  if (i >= 0) {
    const next = list.slice();
    next[i] = row;
    return next;
  }
  // New: keep the oldest-first order the full fetch uses.
  const at = row.createdAt ?? Infinity;
  const j = list.findIndex((x) => (x.createdAt ?? 0) > at);
  return j < 0 ? [...list, row] : [...list.slice(0, j), row, ...list.slice(j)];
}

export function applyRowChange(board: Board, ch: RowChange): Board {
  switch (ch.table) {
    case "tasks":
      return { ...board, tasks: upsertById(board.tasks, ch.id, ch.row) };
    case "projects":
      return { ...board, projects: upsertById(board.projects, ch.id, ch.row) };
    case "weekly": {
      const weekly = { ...board.weekly };
      for (const k of WEEKLY_KEYS) {
        const list = weekly[k];
        const i = list.findIndex((x) => x.id === ch.id);
        if (ch.row && ch.row.bucket === k) {
          weekly[k] = i >= 0 ? list.map((x) => (x.id === ch.id ? ch.row!.item : x)) : [...list, ch.row.item];
        } else if (i >= 0) {
          weekly[k] = list.filter((x) => x.id !== ch.id);
        }
      }
      return { ...board, weekly };
    }
    case "reflections":
      return { ...board, reflections: ch.list };
    case "personal_notes":
      return { ...board, personalNotes: ch.list, personalNotesError: ch.error };
    case "board_meta":
      return { ...board, ...ch.meta };
  }
}

// ---- Structural sharing -----------------------------------------------------
// A full reload (the 30 s poll, a tab refocus) builds every task anew, and so
// does an optimistic op (applyOpLocal copies the board). Equal rows used to
// arrive as new objects, so every task card re-rendered for nothing. Before a
// board is shown it goes through reconcileBoard: whatever equals what is on
// screen keeps its old object, so only what really changed is new.

/** Deep equality for plain data (board rows). A key holding undefined counts as absent. */
export function sameData(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!sameData(a[i], b[i])) return false;
    return true;
  }
  // Only plain objects compare by their fields (a Date or a Map never equals a copy).
  if (!isPlain(a) || !isPlain(b)) return false;
  const ra = a as Record<string, unknown>;
  const rb = b as Record<string, unknown>;
  const ka = Object.keys(ra).filter((k) => ra[k] !== undefined);
  const kb = Object.keys(rb).filter((k) => rb[k] !== undefined);
  if (ka.length !== kb.length) return false;
  for (const k of ka) if (!sameData(ra[k], rb[k])) return false;
  return true;
}

function isPlain(o: object): boolean {
  const p = Object.getPrototypeOf(o);
  return p === Object.prototype || p === null;
}

/** `next`, with each item equal to the one of the same id in `prev` replaced
 *  by prev's object, and `prev` itself when nothing changed at all. */
export function reuseById<T extends { id: string }>(prev: T[] | undefined, next: T[]): T[] {
  if (!prev || prev === next) return next;
  const byId = new Map(prev.map((x) => [x.id, x]));
  let same = prev.length === next.length;
  const out = next.map((x, i) => {
    const old = byId.get(x.id);
    const keep = old !== undefined && sameData(old, x) ? old : x;
    if (keep !== prev[i]) same = false;
    return keep;
  });
  return same ? prev : out;
}

// Fields that are lists of rows: matched item by item, by id.
const BY_ID = new Set<string>(["tasks", "projects", "reflections", "personalNotes"]);
// Stamped with the time of every reload or op; nothing reads it.
const IGNORED = new Set<string>(["updatedAt"]);

/** `next`, sharing every part that equals `prev` (see above). The values are always next's. */
export function reconcileBoard(prev: Board | null, next: Board): Board {
  if (!prev || prev === next) return next;
  const p = prev as unknown as Record<string, unknown>;
  const n = next as unknown as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  let same = true;
  for (const k of Object.keys(n)) {
    const nv = n[k];
    const pv = p[k];
    const v =
      BY_ID.has(k) && Array.isArray(nv) && Array.isArray(pv)
        ? reuseById(pv as { id: string }[], nv as { id: string }[])
        : sameData(pv, nv)
        ? pv
        : nv;
    out[k] = v;
    if (v !== pv && !IGNORED.has(k)) same = false;
  }
  // A field prev had and next lacks.
  for (const k of Object.keys(p)) {
    if (!(k in n) && p[k] !== undefined && !IGNORED.has(k)) same = false;
  }
  return same ? prev : (out as unknown as Board);
}
