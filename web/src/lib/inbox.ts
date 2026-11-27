// -----------------------------------------------------------------------------
// The Inbox (GTD "collect"): a task captured with a title only, to be sorted
// later. It is a task status, INBOX, that is not a BOARD column: the desktop
// shows it as a strip above the columns (components/InboxStrip.tsx), the
// phone as a section of Oggi, and the weekly review asks about it first.
// No database change: tasks.status is free text.
// -----------------------------------------------------------------------------

import { UNASSIGNED, genId } from "./constants";
import { ownersPatch } from "./owners";
import type { Status, Task } from "./types";

export const INBOX: Status = "INBOX";

/** Where an Inbox task can be sorted to, in the order the buttons show. */
export const SORT_TARGETS: Status[] = ["BACKLOG", "NEXT", "IN PROGRESS", "WAITING", "MAYBE", "DONE"];

/** The desktop key that opens the capture box (no modifier, not in a field). */
export const CAPTURE_KEY = "i";

export function isInbox(t: Pick<Task, "status">): boolean {
  return t.status === INBOX;
}

/** The Inbox, oldest first (the order to work through it). */
export function inboxTasks(tasks: Task[]): Task[] {
  return tasks
    .filter(isInbox)
    .sort((a, b) => (a.createdAt ?? a.updatedAt ?? 0) - (b.createdAt ?? b.updatedAt ?? 0) || a.title.localeCompare(b.title));
}

/**
 * A captured task: the title and nothing else to decide. It is held by
 * whoever captured it (Unassigned when this device has no name yet), P2 as
 * the new-task bar starts, no date, not highlighted.
 */
export function newInboxTask(title: string, me: string | null | undefined, members: string[], now = Date.now()): Task {
  const who = me && members.includes(me) ? me : UNASSIGNED;
  return {
    id: genId(),
    title: title.trim(),
    desc: "",
    ...ownersPatch([who]),
    priority: "P2",
    status: INBOX,
    notes: "",
    subtasks: [],
    updatedAt: now,
    createdAt: now,
  };
}

/** Days since a task was captured (0 = today), by local calendar day. */
export function capturedDaysAgo(t: Pick<Task, "createdAt" | "updatedAt">, now = new Date()): number {
  const at = t.createdAt ?? t.updatedAt ?? 0;
  if (!at) return 0;
  const a = new Date(at);
  const day = (d: Date) => Date.UTC(d.getFullYear(), d.getMonth(), d.getDate());
  return Math.max(0, Math.round((day(now) - day(a)) / 86400000));
}

/**
 * True when a key press should open the capture box: the capture key with no
 * Ctrl / Cmd / Alt, not held down, and not typed into a field, a select or
 * editable text (where it is a letter).
 */
export function isCaptureKey(e: {
  key: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  repeat?: boolean;
  defaultPrevented?: boolean;
  target?: EventTarget | null;
}): boolean {
  if (e.defaultPrevented || e.repeat || e.ctrlKey || e.metaKey || e.altKey) return false;
  if (e.key.toLowerCase() !== CAPTURE_KEY) return false;
  return !isTypingTarget(e.target ?? null);
}

/** A text field, a select, or anything editable. */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!target || typeof (target as Element).closest !== "function") return false;
  const el = target as HTMLElement;
  if (el.isContentEditable) return true;
  return !!el.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"], [role="textbox"]');
}
