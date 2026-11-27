import { useEffect, useMemo, useRef, useState } from "react";
import type { Board, Op, Status, Task } from "../lib/types";
import { PRIORITY_DOT } from "../lib/constants";
import { localeCode, statusLabel, useT } from "../lib/i18n";
import { toISODate } from "../lib/dates";
import { ownersLabel, ownersPatch, taskOwners } from "../lib/owners";
import { nextDue } from "../lib/recurrence";
import { navigate } from "../lib/history";
import {
  REVIEW_STEPS,
  hasNoOwner,
  overdueDays,
  reviewLists,
  stepCounts,
  tasksLeft,
  waitingDays,
  weekSummary,
  type ReviewLists,
  type ReviewStep,
} from "../lib/weeklyReview";
import { IconChevron } from "../mobile/icons";
import { TaskDetails, showUndo } from "./TaskDetails";

// -----------------------------------------------------------------------------
// SETTIMANA › Revisione: the guided weekly review, one step at a time.
//
//   1 Da chiarire · 2 In attesa da più di una settimana · 3 Scadute ·
//   4 Forse / Maybe · 5 Scrivi il Weekly
//
// Each list is derived from the board (lib/weeklyReview.ts), so a task that is
// dealt with (a date, an owner, another status, deleted) leaves its step by
// itself. Every action writes at once with the app's one Undo toast; nothing
// asks first (owner's rule, 2026-11-25). The step and the Maybe tasks kept in
// this review are remembered for the browser tab (sessionStorage).
// -----------------------------------------------------------------------------

interface Props {
  board: Board;
  send: (op: Op) => void;
  members: string[];
}

const STEP_KEY = "gtd-review-step";
const KEPT_KEY = "gtd-review-kept";
const MOVES: Status[] = ["NEXT", "IN PROGRESS", "WAITING", "DONE", "MAYBE"];

function readStep(): number {
  try {
    const n = Number(sessionStorage.getItem(STEP_KEY));
    return Number.isInteger(n) && n >= 0 && n < REVIEW_STEPS.length ? n : 0;
  } catch {
    return 0;
  }
}
function readKept(): Set<string> {
  try {
    const v = JSON.parse(sessionStorage.getItem(KEPT_KEY) ?? "[]");
    return new Set(Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
  } catch {
    return new Set();
  }
}
function save(key: string, value: string) {
  try {
    sessionStorage.setItem(key, value);
  } catch {
    /* private mode: just don't remember it */
  }
}

type Tone = "warn" | "late";
const CHIP: Record<Tone, string> = {
  warn: "bg-[#FEF3C7] text-[#92400E] border-[#FDE68A]",
  late: "bg-[#FEF2F2] text-[#C81E1E] border-[#FECACA]",
};

interface Row {
  task: Task;
  chips: { text: string; tone: Tone }[];
}

export function WeeklyReview({ board, send, members }: Props) {
  const { t, lang } = useT();
  const [step, setStep] = useState(readStep);
  const [kept, setKept] = useState(readKept);
  const [openId, setOpenId] = useState<string | null>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  // The row an action was taken on: when it leaves the list, the focus moves
  // to the row now in its place (or the heading, when the step is empty).
  const afterAction = useRef<{ id: string; i: number; at: number } | null>(null);

  const today = toISODate(new Date());
  const lists = useMemo(() => reviewLists(board, today, kept), [board, today, kept]);
  const counts = stepCounts(lists);
  const current: ReviewStep = REVIEW_STEPS[step];
  const dateFmt = useMemo(
    () => new Intl.DateTimeFormat(localeCode(lang), { day: "numeric", month: "short" }),
    [lang]
  );
  const fmt = (iso: string) => dateFmt.format(new Date(`${iso}T00:00:00`));

  const rows: Row[] = useMemo(() => {
    const due = (tk: Task): Row["chips"] => {
      const d = overdueDays(tk, today);
      return d > 0 ? [{ text: d === 1 ? t("wr.overdue1") : t("wr.overdueDays", { n: d }), tone: "late" }] : [];
    };
    switch (current) {
      case "clarify":
        return lists.clarify.map(({ task, noDue, noOwner }) => ({
          task,
          chips: [
            ...(noDue ? [{ text: t("wr.noDue"), tone: "warn" as Tone }] : []),
            ...(noOwner ? [{ text: t("wr.noOwner"), tone: "warn" as Tone }] : []),
          ],
        }));
      case "waiting":
        return lists.waiting.map((task) => ({
          task,
          chips: [{ text: t("wr.waitingDays", { n: waitingDays(task, today) }), tone: "warn" as Tone }, ...due(task)],
        }));
      case "overdue":
        return lists.overdue.map((task) => ({ task, chips: due(task) }));
      case "maybe":
        return lists.maybe.map((task) => ({ task, chips: due(task) }));
      default:
        return [];
    }
  }, [current, lists, today, t]);

  const goStep = (i: number, viaKeyboard: boolean) => {
    const n = Math.max(0, Math.min(REVIEW_STEPS.length - 1, i));
    setStep(n);
    setOpenId(null);
    save(STEP_KEY, String(n));
    if (viaKeyboard) requestAnimationFrame(() => headingRef.current?.focus());
  };

  // After every render: once the control that was used is gone (its row left
  // the list, or the button itself did), focus that task's title if it is
  // still listed, else the row now in its place, else the heading.
  useEffect(() => {
    const a = afterAction.current;
    if (!a) return;
    if (Date.now() - a.at > 2000) {
      afterAction.current = null;
      return;
    }
    const active = document.activeElement;
    if (active && active !== document.body && active.isConnected) return;
    afterAction.current = null;
    const titles = [...(listRef.current?.querySelectorAll<HTMLButtonElement>("[data-review-title]") ?? [])];
    const target = titles.find((b) => b.dataset.reviewTitle === a.id) ?? titles[Math.min(a.i, titles.length - 1)] ?? headingRef.current;
    target?.focus();
  });

  const setKeptSet = (next: Set<string>) => {
    setKept(next);
    save(KEPT_KEY, JSON.stringify([...next]));
  };

  // ---- Actions (each one writes at once, with Undo) -------------------------

  const move = (tk: Task, status: Status) => {
    const prev = tk.status;
    const prevWaiting = tk.waitingSince;
    send({ type: "moveTask", id: tk.id, status });
    const nextDate = status === "DONE" && tk.recurrence ? nextDue(tk.recurrence, tk.dueDate, today) : "";
    showUndo(
      nextDate
        ? t("rec.nextToast", { title: tk.title, date: fmt(nextDate) })
        : t("wr.moved", { title: tk.title, status: statusLabel(lang, status) }),
      () => {
        send({ type: "moveTask", id: tk.id, status: prev });
        if (prev === "WAITING" && prevWaiting) send({ type: "updateTask", id: tk.id, patch: { waitingSince: prevWaiting } });
      }
    );
  };

  const setDue = (tk: Task, dueDate: string) => {
    const prev = tk.dueDate;
    send({ type: "setDueDate", id: tk.id, dueDate });
    showUndo(t("wr.dueSet", { title: tk.title, date: fmt(dueDate) }), () =>
      send({ type: "setDueDate", id: tk.id, dueDate: prev })
    );
  };

  const assign = (tk: Task, name: string) => {
    const prev = taskOwners(tk);
    send({ type: "updateTask", id: tk.id, patch: ownersPatch([name]) });
    showUndo(t("wr.assigned", { title: tk.title, name }), () =>
      send({ type: "updateTask", id: tk.id, patch: ownersPatch(prev) })
    );
  };

  const nudge = (tk: Task) => {
    const prev = tk.waitingSince;
    send({ type: "updateTask", id: tk.id, patch: { waitingSince: today } });
    showUndo(t("wr.nudged", { title: tk.title }), () =>
      send({ type: "updateTask", id: tk.id, patch: { waitingSince: prev } })
    );
  };

  // Deleted at once, Annulla puts it back whole (as on the board). From the
  // keyboard, focus goes to Annulla, like every other delete.
  const remove = (tk: Task, viaKeyboard: boolean) => {
    const snapshot: Task = { ...tk, subtasks: tk.subtasks.map((s) => ({ ...s })) };
    send({ type: "deleteTask", id: tk.id });
    showUndo(t("ux.board.taskDeleted", { title: snapshot.title }), () => send({ type: "addTask", task: snapshot }), 8000, {
      focus: viaKeyboard,
    });
  };

  const keep = (tk: Task) => setKeptSet(new Set([...kept, tk.id]));

  // ---- Rendering ------------------------------------------------------------

  const stepName = (s: ReviewStep) => t(`wr.step.${s}`);
  const keptHere = current === "maybe" ? board.tasks.filter((tk) => tk.status === "MAYBE" && kept.has(tk.id)).length : 0;

  return (
    <div className="space-y-4 max-w-[1100px]">
      <p className="text-[12px] text-ink-2 max-w-[760px]">{t("wr.intro")}</p>

      <nav aria-label={t("wr.steps")}>
        <ol className="flex flex-wrap gap-2">
          {REVIEW_STEPS.map((s, i) => (
            <li key={s}>
              <button
                type="button"
                aria-current={i === step ? "step" : undefined}
                onClick={(e) => goStep(i, e.detail === 0)}
                className="tab h-9 px-3.5 text-[12px] font-semibold"
              >
                <span>
                  {i + 1}. {stepName(s)}
                </span>
                {s !== "write" && (
                  <>
                    <span className="tab__count" aria-hidden="true">
                      {counts[s]}
                    </span>
                    <span className="sr-only">, {t("wr.countSr", { n: counts[s] })}</span>
                  </>
                )}
              </button>
            </li>
          ))}
        </ol>
      </nav>

      <section aria-labelledby="wr-step-title" className="space-y-3">
        <div>
          <h2 id="wr-step-title" ref={headingRef} tabIndex={-1} className="flex items-baseline flex-wrap gap-x-3 gap-y-1 outline-none">
            <span className="font-trajan text-[11px] uppercase tracking-widest text-ink-2">
              {t("wr.stepOf", { n: step + 1, total: REVIEW_STEPS.length })}
            </span>
            <span className="text-[18px] font-semibold text-[#0A1931]">{stepName(current)}</span>
          </h2>
          <p className="text-[12px] text-ink-2 mt-1 max-w-[760px]">{t(`wr.help.${current}`)}</p>
        </div>

        {current === "write" ? (
          <Summary board={board} lists={lists} counts={counts} goStep={goStep} />
        ) : rows.length === 0 ? (
          <p className="text-[13px] text-ink-2 bg-white rounded-[12px] border border-[#E8E6E1] px-4 py-3">{t("wr.empty")}</p>
        ) : (
          <ul ref={listRef} className="space-y-2">
            {rows.map((r, i) => (
              <ReviewRow
                key={r.task.id}
                row={r}
                step={current}
                members={members}
                board={board}
                send={send}
                open={openId === r.task.id}
                onToggle={() => setOpenId((o) => (o === r.task.id ? null : r.task.id))}
                fmt={fmt}
                onAction={() => {
                  afterAction.current = { id: r.task.id, i, at: Date.now() };
                }}
                actions={{ move, setDue, assign, nudge, remove, keep }}
              />
            ))}
          </ul>
        )}

        {keptHere > 0 && (
          <p className="text-[12px] text-ink-2 flex items-center flex-wrap gap-2">
            {t("wr.kept", { n: keptHere })}
            <button
              type="button"
              onClick={() => setKeptSet(new Set([...kept].filter((id) => !board.tasks.some((tk) => tk.id === id && tk.status === "MAYBE"))))}
              className="h-7 px-3 rounded-full text-[11px] font-semibold bg-white text-[#0A1931] border border-[#E8E6E1]"
            >
              {t("wr.showKept")}
            </button>
          </p>
        )}
      </section>

      <div className="flex items-center gap-2 pt-1">
        <button
          type="button"
          onClick={(e) => goStep(step - 1, e.detail === 0)}
          disabled={step === 0}
          className="h-9 pl-3 pr-4 rounded-full text-[12px] font-semibold bg-white text-[#0A1931] border border-[#E8E6E1] inline-flex items-center gap-1.5 disabled:opacity-45 disabled:cursor-not-allowed"
        >
          <IconChevron size={14} className="rotate-180" />
          {t("wr.back")}
        </button>
        {step < REVIEW_STEPS.length - 1 && (
          <button
            type="button"
            onClick={(e) => goStep(step + 1, e.detail === 0)}
            className="h-9 pl-4 pr-3 rounded-full text-[12px] font-semibold bg-[#0A1931] text-[#C9A96E] inline-flex items-center gap-1.5"
          >
            {t("wr.next")}
            <IconChevron size={14} />
          </button>
        )}
      </div>
    </div>
  );
}

interface Actions {
  move: (tk: Task, s: Status) => void;
  setDue: (tk: Task, iso: string) => void;
  assign: (tk: Task, name: string) => void;
  nudge: (tk: Task) => void;
  remove: (tk: Task, viaKeyboard: boolean) => void;
  keep: (tk: Task) => void;
}

const smallBtn = "h-7 px-3 rounded-full text-[11px] font-semibold bg-white text-[#0A1931] border border-[#E8E6E1]";

function ReviewRow({
  row,
  step,
  members,
  board,
  send,
  open,
  onToggle,
  fmt,
  onAction,
  actions,
}: {
  row: Row;
  step: ReviewStep;
  members: string[];
  board: Board;
  send: (op: Op) => void;
  open: boolean;
  onToggle: () => void;
  fmt: (iso: string) => string;
  onAction: () => void;
  actions: Actions;
}) {
  const { t, lang } = useT();
  const tk = row.task;
  const title = tk.title.trim() || "—";
  const detailsId = `wr-details-${tk.id}`;
  // The date is written when it is complete and the field is left (or Enter):
  // a date typed digit by digit would otherwise move the row away mid-typing.
  const [due, setDueDraft] = useState(tk.dueDate ?? "");
  useEffect(() => setDueDraft(tk.dueDate ?? ""), [tk.dueDate]);
  const commitDue = () => {
    if (due === (tk.dueDate ?? "") || !/^\d{4}-\d{2}-\d{2}$/.test(due) || Number(due.slice(0, 4)) < 2000) return;
    onAction();
    actions.setDue(tk, due);
  };
  const noOwner = hasNoOwner(tk);
  const moves = step === "maybe" ? (["NEXT"] as Status[]) : MOVES.filter((s) => s !== tk.status);
  const act = (fn: () => void) => {
    onAction();
    fn();
  };

  return (
    <li className="bg-white rounded-[12px] border border-[#E8E6E1]">
      <div className="px-3 py-2.5 space-y-2">
        <div className="flex items-start gap-2 min-w-0">
          <span className={`w-2 h-2 mt-[7px] shrink-0 rounded-full ${PRIORITY_DOT[tk.priority]}`} aria-hidden="true" />
          <div className="min-w-0 flex-1">
            <button
              type="button"
              data-review-title={tk.id}
              aria-expanded={open}
              aria-controls={open ? detailsId : undefined}
              onClick={onToggle}
              className="text-left text-[13px] font-semibold text-[#0A1931] break-words [overflow-wrap:anywhere] rounded"
            >
              {title}
            </button>
            <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-ink-2">
              <span>{tk.priority}</span>
              <span aria-hidden="true">·</span>
              <span>{statusLabel(lang, tk.status)}</span>
              <span aria-hidden="true">·</span>
              <span>{ownersLabel(tk, (n) => n)}</span>
              {tk.dueDate && (
                <>
                  <span aria-hidden="true">·</span>
                  <span>
                    {t("task.due")} {fmt(tk.dueDate)}
                  </span>
                </>
              )}
              {row.chips.map((c) => (
                <span key={c.text} className={`px-2 py-0.5 rounded-full border text-[10px] font-semibold ${CHIP[c.tone]}`}>
                  {c.text}
                </span>
              ))}
            </div>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2 pl-4">
          {step === "maybe" && (
            <button type="button" onClick={() => act(() => actions.keep(tk))} aria-label={t("wr.keepFor", { title })} className={smallBtn}>
              {t("wr.keep")}
            </button>
          )}
          <span className="text-[11px] text-ink-2" aria-hidden="true">
            {t("wr.moveLabel")}
          </span>
          <div role="group" aria-label={t("wr.moveTo", { title })} className="seg">
            {moves.map((s) => (
              <button key={s} type="button" onClick={() => act(() => actions.move(tk, s))} className="tab h-7 px-3 text-[11px] font-semibold">
                {statusLabel(lang, s)}
              </button>
            ))}
          </div>
          {step === "waiting" && (
            <button type="button" onClick={() => act(() => actions.nudge(tk))} aria-label={t("wr.nudgeFor", { title })} className={smallBtn}>
              {t("wr.nudge")}
            </button>
          )}
          {step !== "maybe" && (
            <label className="inline-flex items-center gap-1.5 bg-[#F5F3EF] rounded-full px-3 h-7 border border-[#E8E6E1] text-[11px] text-ink-2 field">
              <span aria-hidden="true">{t("task.due")}</span>
              <input
                type="date"
                value={due}
                aria-label={t("wr.dueFor", { title })}
                onChange={(e) => setDueDraft(e.target.value)}
                onBlur={commitDue}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    commitDue();
                  }
                }}
                className="bg-transparent outline-none text-[11px] text-[#0A1931]"
              />
            </label>
          )}
          {step === "clarify" && noOwner && members.length > 0 && (
            <label className="inline-flex items-center bg-[#F5F3EF] rounded-full pl-3 pr-1 h-7 border border-[#E8E6E1] text-[11px] field">
              <select
                value=""
                aria-label={t("wr.assignFor", { title })}
                onChange={(e) => e.target.value && act(() => actions.assign(tk, e.target.value))}
                className="bg-transparent outline-none text-[11px] text-[#0A1931] cursor-pointer max-w-[160px]"
              >
                <option value="">{t("wr.assign")}</option>
                {members.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
            </label>
          )}
          <button
            type="button"
            onClick={(e) => act(() => actions.remove(tk, e.detail === 0))}
            aria-label={t("wr.deleteFor", { title })}
            className="ml-auto h-7 px-3 rounded-full text-[11px] font-semibold text-ink-2 border border-[#E8E6E1]"
          >
            {t("task.delete")}
          </button>
        </div>
      </div>
      {open && (
        <div id={detailsId} className="border-t border-[#E8E6E1] p-3" aria-label={t("wr.details", { title })} role="region">
          <TaskDetails task={tk} members={board.members} send={send} multiAssign={board.assigneesAvailable !== false} />
        </div>
      )}
    </li>
  );
}

function Summary({
  board,
  lists,
  counts,
  goStep,
}: {
  board: Board;
  lists: ReviewLists;
  counts: Record<ReviewStep, number>;
  goStep: (i: number, viaKeyboard: boolean) => void;
}) {
  const { t } = useT();
  const s = weekSummary(board);
  const left = tasksLeft(lists);
  const figures: [string, number][] = [
    [t("wr.sum.done"), s.doneThisWeek],
    [t("wr.sum.open"), s.open],
    [t("wr.sum.waiting"), s.waiting],
    [t("wr.sum.items"), s.weeklyItems],
  ];
  return (
    <div className="space-y-3">
      <h3 className="sr-only">{t("wr.sum.title")}</h3>
      <dl className="grid grid-cols-2 lg:grid-cols-4 gap-2 max-w-[760px]">
        {figures.map(([label, n]) => (
          <div key={label} className="bg-white rounded-[12px] border border-[#E8E6E1] px-3 py-2.5">
            <dt className="text-[11px] text-ink-2">{label}</dt>
            <dd className="text-[22px] font-semibold text-[#0A1931] tabular-nums">{n}</dd>
          </div>
        ))}
      </dl>
      <div className="text-[12px] text-ink-2 flex items-center flex-wrap gap-2">
        {left > 0 ? t("wr.sum.left", { n: left }) : t("wr.sum.clear")}
        {REVIEW_STEPS.slice(0, 4).map((st, i) =>
          counts[st] > 0 ? (
            <button
              key={st}
              type="button"
              onClick={(e) => goStep(i, e.detail === 0)}
              className={smallBtn}
            >
              {i + 1}. {t(`wr.step.${st}`)} · {counts[st]}
            </button>
          ) : null
        )}
      </div>
      <a
        href="#/weekly"
        onClick={(e) => {
          e.preventDefault();
          navigate({ tab: "weekly" });
        }}
        className="inline-flex items-center gap-1.5 h-10 pl-5 pr-4 rounded-full text-[13px] font-semibold bg-[#0A1931] text-[#C9A96E]"
      >
        {t("wr.openWeekly")}
        <IconChevron size={14} />
      </a>
    </div>
  );
}
