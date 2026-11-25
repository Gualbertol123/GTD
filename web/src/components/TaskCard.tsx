import { memo, useEffect, useRef, useState } from "react";
import { claimFocusAfterMove } from "../lib/focusAfterMove";
import type { Op, Project, Task } from "../lib/types";
import { PRIORITY_DOT } from "../lib/constants";
import { ownerLabel, priorityLabel, statusLabel, useT, localeCode } from "../lib/i18n";
import { ownerInitial, ownersLabel, taskOwners } from "../lib/owners";
import { daysSince, daysUntil } from "../lib/dates";
import { TaskDetails, showUndo } from "./TaskDetails";
import { projectColor } from "../lib/projects";
import { nextDue, ruleLabel } from "../lib/recurrence";
import { toISODate } from "../lib/dates";
import { RepeatIcon, StarIcon } from "./RecurrenceControls";

// A board shows hundreds of these, so the card is memoised: it re-renders only
// when its own props change. Its parent keeps them steady: the task objects
// are shared between board versions (lib/rowSync.ts reconcileBoard), the
// handlers take the task id instead of being made per card, and the project
// and step come in as props (computed once per board) instead of every card
// reading all the tasks from context.
interface Props {
  task: Task;
  members: string[];
  send: (op: Op) => void;
  showNames?: boolean; // false hides owner names (screenshot mode)
  multiAssign?: boolean;
  draggable: boolean;
  onDragStart: (id: string, e: React.DragEvent) => void;
  onDragEnd: (id: string, e: React.DragEvent) => void;
  /** Show the status pill (Done / Archived bars). A kanban column already says it. */
  showStatus?: boolean;
  /** Told when the card opens or closes (the board widens that column). */
  onOpenChange?: (task: Task, open: boolean) => void;
  /** The task's project, if it has one. */
  project?: Project;
  /** "Step n of total" for a task of a sequential project (lib/projects.ts projectSteps). */
  stepN?: number;
  stepTotal?: number;
}

// The round "done" check, the same shape as the phone layout's.
function CheckIcon({ done }: { done: boolean }) {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
      {done ? (
        <>
          <circle cx="12" cy="12" r="10" fill="currentColor" />
          <path d="m7.5 12.5 3 3 6-6.5" fill="none" stroke="#fff" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
        </>
      ) : (
        <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeWidth="2" />
      )}
    </svg>
  );
}

export const TaskCard = memo(TaskCardView);

function TaskCardView({
  task,
  members,
  send,
  showNames = true,
  multiAssign = true,
  draggable,
  onDragStart,
  onDragEnd,
  showStatus = false,
  onOpenChange,
  project,
  stepN,
  stepTotal,
}: Props) {
  const { t, lang } = useT();
  const [open, setOpenState] = useState(false);
  const headRef = useRef<HTMLButtonElement>(null);
  const setOpen = (v: boolean) => {
    setOpenState(v);
    onOpenChange?.(task, v);
  };
  // Unmounting while open (moved, filtered out, deleted) counts as closing.
  const openRef = useRef(open);
  openRef.current = open;
  const openCb = useRef(onOpenChange);
  openCb.current = onOpenChange;
  const taskRef = useRef(task);
  taskRef.current = task;
  useEffect(
    () => () => {
      if (openRef.current) openCb.current?.(taskRef.current, false);
    },
    []
  );
  // Just moved here from its own editor (‹ › or "Sposta in"): it reopens, so
  // the arrows step through the columns without closing the editor each
  // time, and keyboard focus stays on this task.
  useEffect(() => {
    if (!claimFocusAfterMove(task.id)) return;
    setOpen(true);
    headRef.current?.focus({ preventScroll: false });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const isDone = task.status === "DONE";
  const detailsId = `task-details-${task.id}`;

  // One click completes a task (or reopens it), with an undo.
  const toggleDone = () => {
    const prev = task.status;
    const prevWaiting = task.waitingSince;
    const next = isDone ? "NEXT" : "DONE";
    send({ type: "moveTask", id: task.id, status: next });
    // A recurring task says when the next one is due (it was just created).
    const nextDate =
      !isDone && task.recurrence ? nextDue(task.recurrence, task.dueDate, toISODate(new Date())) : "";
    const text = nextDate
      ? t("rec.nextToast", {
          title: task.title,
          date: new Date(`${nextDate}T00:00:00`).toLocaleDateString(localeCode(lang), { day: "numeric", month: "short" }),
        })
      : t(isDone ? "ux.board.reopenToast" : "ux.board.doneToast", { title: task.title });
    showUndo(text, () => {
      send({ type: "moveTask", id: task.id, status: prev });
      if (prev === "WAITING" && prevWaiting) {
        send({ type: "updateTask", id: task.id, patch: { waitingSince: prevWaiting } });
      }
    });
  };

  const done = task.subtasks.filter((s) => s.done).length;
  const total = task.subtasks.length;
  const until = daysUntil(task.dueDate);
  const waiting = task.status === "WAITING" ? daysSince(task.waitingSince) : 0;
  const dueFmt = task.dueDate ? new Date(task.dueDate).toLocaleDateString(localeCode(lang)) : "";
  const owners = taskOwners(task);
  const step = project && stepN !== undefined && stepTotal !== undefined ? { n: stepN, total: stepTotal } : null;

  return (
    <div
      draggable={draggable && !open}
      onDragStart={(e) => onDragStart(task.id, e)}
      onDragEnd={(e) => onDragEnd(task.id, e)}
      // No hover state (docs/interaction-rules.md): the title is the "open"
      // button and the cursor says so.
      className={`task-card bg-white rounded-[12px] border border-[#E8E6E1] ${open ? "is-open" : ""} ${
        task.pinned && !isDone ? "is-pinned" : ""
      }`}
    >
      <div className="p-3 flex items-start gap-2">
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            toggleDone();
          }}
          aria-label={t(isDone ? "ux.board.reopen" : "ux.board.markDone")}
          title={t(isDone ? "ux.board.reopen" : "ux.board.markDone")}
          className={`shrink-0 -m-0.5 p-0.5 rounded-full outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--ctl-focus)] transition-colors ${
            isDone ? "text-[#065F46]" : "text-ink-3"
          }`}
        >
          <CheckIcon done={isDone} />
        </button>
        <button
          ref={headRef}
          type="button"
          onClick={() => setOpen(!open)}
          aria-expanded={open}
          aria-controls={open ? detailsId : undefined}
          className="card-head flex-1 min-w-0 text-left flex items-start gap-2 rounded-md outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--ctl-focus)]"
        >
          <span aria-hidden="true" className={`w-2.5 h-2.5 rounded-full shrink-0 mt-1 ${PRIORITY_DOT[task.priority]}`} />
          <span className="sr-only">{t("ux.board.priority", { p: priorityLabel(t, task.priority) })}:</span>
          {open ? (
            <span className="flex-1 min-w-0 text-[10px] font-semibold uppercase tracking-widest text-ink-3 mt-0.5">
              <span aria-hidden="true">▾ </span>
              {t("task.collapse")}
            </span>
          ) : (
            <span className="flex-1 min-w-0 font-semibold text-[13px] text-[#0A1931] leading-snug break-words hyphens-auto [hyphenate-limit-chars:10_4_4]">
              {task.title}
            </span>
          )}
          {task.pinned && !open && (
            <span className="shrink-0 mt-0.5 text-[#C9A96E]" title={t("pin.on")}>
              <StarIcon on size={13} />
              <span className="sr-only">{t("pin.on")}</span>
            </span>
          )}
          {showStatus && (
            <span className="shrink-0 text-[10px] font-semibold tracking-wide uppercase px-2 py-0.5 rounded-full bg-[#F5F3EF] text-ink-2 border border-transparent">
              {statusLabel(lang, task.status)}
            </span>
          )}
        </button>
      </div>

      {!open && (
        <div className="px-3 pb-3 -mt-1 flex flex-wrap items-center gap-1.5">
          {showNames && (
            <span className="inline-flex items-center gap-1 text-[11px] text-ink-2">
              <span className="flex -space-x-1">
                {owners.slice(0, 3).map((name, i) => (
                  <span
                    key={`${name}-${i}`}
                    className="w-4 h-4 rounded-full bg-[#0A1931] text-white text-[8px] font-bold flex items-center justify-center ring-1 ring-white"
                  >
                    {ownerInitial(name)}
                  </span>
                ))}
              </span>
              {ownersLabel(task, (name) => ownerLabel(t, name))}
            </span>
          )}
          {task.dueDate && (
            <span
              className={`text-[10px] px-2 py-0.5 rounded-full border ${
                until !== null && until < 0
                  ? "bg-[#FEF2F2] text-[#C81E1E] border-[#FECACA]"
                  : until !== null && until <= 2
                  ? "bg-[#FEF3C7] text-[#92400E] border-[#FDE68A]"
                  : "bg-[#F5F3EF] text-ink-2 border-transparent"
              }`}
            >
              {dueFmt}
            </span>
          )}
          {task.status === "WAITING" && task.waitingSince && (
            <span className="text-[10px] px-2 py-0.5 rounded-full bg-[#F5F3EF] text-ink-2 border border-transparent">
              {waiting} {t("task.days")}
            </span>
          )}
          {task.recurrence && (
            <span
              className="inline-flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full bg-[#EEF2FA] text-[#1E3A6E] border border-[#D5DEEE]"
              title={t("rec.chip", { rule: ruleLabel(task.recurrence, lang) })}
            >
              <RepeatIcon size={10} />
              {ruleLabel(task.recurrence, lang)}
            </span>
          )}
          {total > 0 && (
            <span className="text-[10px] px-2 py-0.5 rounded-full bg-[#F5F3EF] text-ink-2 border border-transparent">
              ☑ {done}/{total}
            </span>
          )}
          {project && (
            <span
              className="tint inline-flex items-center gap-1 text-[10px] font-semibold px-2 py-0.5 rounded-full max-w-full truncate"
              style={{ "--tint": projectColor(project) } as React.CSSProperties}
              title={project.name}
            >
              ◆ <span className="truncate">{project.name}</span>
              {step && <span className="shrink-0">· {t("projects.step.of", { n: step.n, total: step.total })}</span>}
            </span>
          )}
        </div>
      )}

      {open && (
        <div
          id={detailsId}
          className="px-3 pb-3"
          onKeyDown={(e) => {
            // Escape closes the card, unless a field inside already used it
            // (subtask/title revert, the delete confirm, the assignee picker).
            if (e.key !== "Escape" || e.defaultPrevented) return;
            e.preventDefault();
            // Blur first so the field being edited saves (its onBlur commits).
            const a = document.activeElement;
            if (a instanceof HTMLElement && e.currentTarget.contains(a)) a.blur();
            setOpen(false);
            headRef.current?.focus();
          }}
        >
          <TaskDetails
            task={task}
            members={members}
            send={send}
            showNames={showNames}
            multiAssign={multiAssign}
          />
        </div>
      )}
    </div>
  );
}
// The name React DevTools and scripts/ux/perf-rerender.mjs report.
TaskCardView.displayName = "TaskCard";
