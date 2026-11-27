import type { Priority, Status, Task } from "./types";

// A DONE task becomes "archived" once it has been done for this long.
export const ARCHIVE_DAYS = 7;
export function isArchived(t: Task, now = Date.now()): boolean {
  if (t.status !== "DONE") return false;
  const at = t.doneAt ?? t.updatedAt ?? 0;
  return at > 0 && now - at >= ARCHIVE_DAYS * 86400000;
}

// Column order and display labels — recovered from the original artifact.
export const STATUS_ORDER: Status[] = [
  "BACKLOG",
  "NEXT",
  "IN PROGRESS",
  "WAITING",
  "DONE",
  "MAYBE",
];

export const STATUS_LABEL: Record<Status, string> = {
  BACKLOG: "Backlog",
  NEXT: "Next",
  "IN PROGRESS": "In Progress",
  WAITING: "Waiting",
  DONE: "Done",
  MAYBE: "Maybe",
};

export const STATUS_HELP: Record<Status, string> = {
  BACKLOG: "Idee non prioritarie",
  NEXT: "Da fare a breve",
  "IN PROGRESS": "In lavorazione ora",
  WAITING: "In attesa esterna, conta gg",
  DONE: "Completata • alimenta weekly auto",
  MAYBE: "Forse più avanti",
};

export const PRIORITY_ORDER: Record<Priority, number> = {
  P1: 1,
  P2: 2,
  P3: 3,
  P4: 4,
};

export const PRIORITY_LABEL: Record<Priority, string> = {
  P1: "P1 • Urgente",
  P2: "P2 • Alta",
  P3: "P3 • Media",
  P4: "P4 • Bassa",
};

// Dot / pill colours per priority — from the original artifact.
export const PRIORITY_DOT: Record<Priority, string> = {
  P1: "bg-[#DC2626]",
  P2: "bg-[#C9A96E]",
  P3: "bg-[#C9C5BE]",
  P4: "bg-[#8BA1C2]",
};

export const UNASSIGNED = "Unassigned";

// How long a device stays logged in when Settings has no value yet. (No
// password lives in the code: they are all checked by Supabase — lib/auth.ts.)
export const DEFAULT_LOGIN_DAYS = 7;

// Weekly-review columns config (key, label, colour classes).
export const WEEKLY_COLUMNS: {
  key: "well" | "learnings" | "improve" | "blockers" | "focus";
  label: string;
  /** The dot before the column's name (the name itself is plain text). */
  dot: string;
}[] = [
  { key: "well", label: "WINS", dot: "#16A34A" },
  { key: "learnings", label: "LEARNINGS", dot: "#3A5A8A" },
  { key: "improve", label: "TO IMPROVE", dot: "#D97706" },
  { key: "blockers", label: "BLOCKERS", dot: "#DC2626" },
  { key: "focus", label: "FOCUS NEXT WEEK", dot: "#0A1931" },
];

export type TabId =
  | "board"
  | "projects"
  | "weekly"
  | "report"
  | "mail"
  | "products"
  | "calendario"
  | "reflection"
  | "music"
  | "settings";

export const TABS: { id: TabId; label: string }[] = [
  { id: "board", label: "BOARD" },
  { id: "projects", label: "PROGETTI" },
  { id: "weekly", label: "WEEKLY" },
  { id: "report", label: "REPORT" },
  { id: "mail", label: "MAIL" },
  { id: "products", label: "PRODOTTI" },
  { id: "calendario", label: "CALENDARIO" },
  { id: "reflection", label: "RIFLESSIONE" },
  { id: "music", label: "MUSICA" },
  { id: "settings", label: "IMPOSTAZIONI" },
];

// Small helper: unique-ish id (used only for optimistic new items;
// the server keeps whatever id the client sends).
export const genId = () => Math.random().toString(36).slice(2, 9);
