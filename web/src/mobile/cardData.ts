import { createContext, useContext, useMemo } from "react";
import type { Board, Project } from "../lib/types";
import { projectSteps } from "../lib/projects";
import { toISODate } from "../lib/dates";

/**
 * What a phone task card shows beyond its own task, worked out once per board
 * by the shell instead of in every card. A list (TaskList) reads it and hands
 * each card only its own part as props, so the memoised cards re-render when
 * that part changes, not on every change to the board (see TaskCard.tsx).
 */
export interface CardData {
  /** Project by id (the first with that id, as stepOf did). */
  projectById: Map<string, Project>;
  /** Task id → "step n of total", for tasks of sequential projects. */
  steps: Map<string, { n: number; total: number }>;
  /** The board's members: their order sets the avatar colours (ui.tsx avatarColor). */
  members: string[];
  /** Today (YYYY-MM-DD): the due and waiting chips count from it. */
  today: string;
}

const EMPTY: CardData = { projectById: new Map(), steps: new Map(), members: [], today: "" };

export const CardDataCtx = createContext<CardData>(EMPTY);

export function useCardData(): CardData {
  return useContext(CardDataCtx);
}

/** The shell's value for CardDataCtx: changes only with what it carries. */
export function useCardDataValue(board: Board): CardData {
  const { projects, tasks, members } = board;
  // Read on every render of the shell (any board change, a tab refocus, the
  // midnight re-read in useBoard), so the cards' day chips follow the date.
  const today = toISODate(new Date());
  const projectById = useMemo(() => {
    const m = new Map<string, Project>();
    for (const p of projects) if (!m.has(p.id)) m.set(p.id, p);
    return m;
  }, [projects]);
  const steps = useMemo(() => projectSteps(projects, tasks), [projects, tasks]);
  return useMemo(() => ({ projectById, steps, members, today }), [projectById, steps, members, today]);
}
