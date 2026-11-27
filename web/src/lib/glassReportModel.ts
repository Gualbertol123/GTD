import type { Board, Priority, Project, Status, Task } from "./types";
import { boardTasks, projectColor, reportProjects, type ProjectStats } from "./projects";
import { periodBounds, type PlannerColumn, type ReportData } from "./reportData";

// -----------------------------------------------------------------------------
// The Liquid Glass weekly report: its content as a flat list of blocks.
//
// The report is laid out as A4 pages in HTML. Content is cut into blocks —
// a section heading, one task card, one project — and
// GlassReport measures every block and packs them onto portrait pages, so
// nothing is ever split across a page break. The planner is different: it is
// always one landscape page, the four columns side by side. Like the Word report, it is
// name-free: no owner is shown anywhere.
// -----------------------------------------------------------------------------

// Apple's light system colours, shared by the pages and the server PDF.
export const PRIORITY_COLOR: Record<Priority, string> = {
  P1: "#FF3B30",
  P2: "#FF9500",
  P3: "#007AFF",
  P4: "#8E8E93",
};
export const STATUS_COLOR: Partial<Record<Status, string>> = {
  INBOX: "#5856D6",
  BACKLOG: "#8E8E93",
  NEXT: "#007AFF",
  "IN PROGRESS": "#AF52DE",
  WAITING: "#FF9500",
};
export const SECTION_COLOR: Record<SectionKey, string> = {
  done: "#34C759",
  next: "#007AFF",
  projects: "#5856D6",
  planner: "#AF52DE",
};

export type SectionKey = "done" | "next" | "projects" | "planner";

export const SECTION_ORDER: SectionKey[] = ["done", "next", "projects", "planner"];

export type Block =
  | { kind: "section"; id: string; key: SectionKey; n: number; count: number }
  | { kind: "task"; id: string; task: Task; mode: "done" | "next"; completedAt: number | null }
  | { kind: "project"; id: string; project: Project; stats: ProjectStats; color: string }
  | { kind: "empty"; id: string; key: SectionKey };

export interface CoverStats {
  done: number;
  subtasks: number;
  inProgress: number;
  next: number;
  waiting: number;
}

export function coverStats(board: Board, data: ReportData): CoverStats {
  // The board as the BOARD tab shows it (project tasks kept off it excluded).
  const shown = boardTasks(board);
  const count = (s: Status) => shown.filter((t) => t.status === s).length;
  return {
    done: data.totalTasks,
    subtasks: data.totalSubtasks,
    inProgress: count("IN PROGRESS"),
    next: count("NEXT"),
    waiting: count("WAITING"),
  };
}

export interface ReportLayoutInput {
  /** Portrait blocks before the planner: Done, Next, Projects. */
  before: Block[];
  /** The planner page's columns and its section number. */
  planner: { n: number; columns: PlannerColumn[] };
  /** Portrait blocks after the planner (none at present: the report ends with the planner). */
  after: Block[];
}

/** Everything after the cover, in reading order. Hidden block ids are left out. */
export function buildBlocks(data: ReportData, hidden: Set<string>): ReportLayoutInput {
  let n = 0;
  const section = (key: SectionKey, body: Block[]): Block[] => {
    n += 1;
    const visible = body.filter((b) => !hidden.has(b.id));
    return [
      { kind: "section", id: `sec.${key}`, key, n, count: visible.length },
      ...(visible.length ? visible : [{ kind: "empty" as const, id: `empty.${key}`, key }]),
    ];
  };

  const before = [
    ...section(
      "done",
      data.done.map((r) => ({
        kind: "task" as const,
        id: `task.${r.task.id}`,
        task: r.task,
        mode: "done" as const,
        completedAt: r.completedAt,
      }))
    ),
    ...section(
      "next",
      data.next.map((r) => ({
        kind: "task" as const,
        id: `next.${r.task.id}`,
        task: r.task,
        mode: "next" as const,
        completedAt: null,
      }))
    ),
    ...section(
      "projects",
      // Projects left out of the report (× on the card) stay out of every report.
      // Ongoing projects, and those completed inside the period.
      reportProjects(data.projects, data.tasks, periodBounds(data.period)).map(({ project, stats }) => ({
        kind: "project" as const,
        id: `proj.${project.id}`,
        project,
        stats,
        color: projectColor(project),
      }))
    ),
  ];
  n += 1;
  const planner = { n, columns: data.planner };
  const after: Block[] = [];
  return { before, planner, after };
}

/** The tasks a report project card lists: open ones first (board order), then done. */
export function reportProjectTasks(block: Extract<Block, { kind: "project" }>): Task[] {
  const ts = block.stats.tasks;
  return [...ts.filter((x) => x.status !== "DONE"), ...ts.filter((x) => x.status === "DONE")];
}

export function reportPdfName(data: ReportData): string {
  return `Weekly_Report_${data.period.from}_${data.period.to}.pdf`;
}

// ---- The cover's «Da sottolineare» list -------------------------------------------
// A few tasks the person wants to point out, picked with «Scegli attività».
// Not the board's ★ band ("In evidenza"), but it starts from it.

export const MAX_HIGHLIGHTS = 8;

export interface HighlightGroup {
  status: Status;
  tasks: Task[];
}

/** Tasks the picker offers, grouped and ordered as it shows them: completed
 *  in the period, then in progress, next and waiting on the board. */
export function highlightCandidates(board: Board, data: ReportData): HighlightGroup[] {
  const doneIds = new Set(data.done.map((r) => r.task.id));
  return [
    { status: "DONE" as Status, tasks: data.done.map((r) => r.task) },
    ...(["IN PROGRESS", "NEXT", "WAITING"] as Status[]).map((status) => ({
      status,
      tasks: boardTasks(board).filter((t) => t.status === status && !doneIds.has(t.id)),
    })),
  ].filter((g) => g.tasks.length > 0);
}

/** The list before anyone picks: the board's ★ tasks among those the picker
 *  offers, in the picker's order, at most MAX_HIGHLIGHTS. */
export function starredHighlights(groups: HighlightGroup[]): string[] {
  return groups
    .flatMap((g) => g.tasks)
    .filter((t) => t.pinned)
    .slice(0, MAX_HIGHLIGHTS)
    .map((t) => t.id);
}
