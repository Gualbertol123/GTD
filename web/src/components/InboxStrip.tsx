import { useEffect, useMemo, useRef, useState } from "react";
import type { Board, Op, Status, Task } from "../lib/types";
import { PRIORITY_DOT } from "../lib/constants";
import { localeCode, ownerLabel, statusLabel, useT } from "../lib/i18n";
import { ownersLabel, ownersPatch, taskOwners } from "../lib/owners";
import { INBOX, SORT_TARGETS, capturedDaysAgo } from "../lib/inbox";
import { readInboxOpen, writeInboxOpen } from "../lib/prefs";
import { TaskDetails, showUndo } from "./TaskDetails";
import { openInboxCapture } from "./InboxCapture";
import { claimFocusAfterMove } from "../lib/focusAfterMove";

// -----------------------------------------------------------------------------
// The Inbox strip above the Board's columns (and above the List view): the
// INBOX tasks that pass the board's filters, oldest first, each with quick
// "sort" actions — a column, a due date, a person, delete — written at once
// with Annulla, like the weekly review's rows. The title opens the full task
// editor in place. A card dropped on the strip goes back to the Inbox; an
// Inbox row can be dragged onto a column. Open or collapsed, per device.
// -----------------------------------------------------------------------------

/** Rows shown before «Mostra tutte»: the strip stays a strip. */
const FIRST_ROWS = 5;

interface Props {
  board: Board;
  /** The Inbox after the board's filters, in order (lib/inbox.ts inboxTasks). */
  tasks: Task[];
  /** The whole Inbox, before the filters: "nothing matches" vs "empty". */
  total: number;
  filtersActive: boolean;
  members: string[];
  send: (op: Op) => void;
  showNames: boolean;
  /** A board card is being dragged (the strip is then a drop target). */
  dragging: boolean;
  onDropCard: () => void;
  onDragStart: (id: string, e: React.DragEvent) => void;
  onDragEnd: (id: string, e: React.DragEvent) => void;
  draggable: boolean;
}

function IconInbox() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M22 12h-6l-2 3h-4l-2-3H2" />
      <path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z" />
    </svg>
  );
}

export function InboxStrip({
  board,
  tasks,
  total,
  filtersActive,
  members,
  send,
  showNames,
  dragging,
  onDropCard,
  onDragStart,
  onDragEnd,
  draggable,
}: Props) {
  const { t, lang } = useT();
  const [open, setOpen] = useState(readInboxOpen);
  const [over, setOver] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const [all, setAll] = useState(false);
  const rows = all ? tasks : tasks.slice(0, FIRST_ROWS);
  const headRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  // The row an action was taken on: once it leaves, the focus goes to the
  // row now in its place (or the strip's header when it was the last).
  const afterAction = useRef<{ id: string; i: number; at: number } | null>(null);
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
    const titles = [...(listRef.current?.querySelectorAll<HTMLButtonElement>("[data-inbox-title]") ?? [])];
    const target = titles.find((b) => b.dataset.inboxTitle === a.id) ?? titles[Math.min(a.i, titles.length - 1)] ?? headRef.current;
    target?.focus();
  });

  const dateFmt = useMemo(() => new Intl.DateTimeFormat(localeCode(lang), { day: "numeric", month: "short" }), [lang]);
  const fmt = (iso: string) => dateFmt.format(new Date(`${iso}T00:00:00`));
  const when = (tk: Task) => {
    const d = capturedDaysAgo(tk);
    return d === 0 ? t("inbox.today") : d === 1 ? t("inbox.yesterday") : t("inbox.daysAgo", { n: d });
  };

  // ---- Actions (each one writes at once, with Annulla) ----------------------
  const sortTo = (tk: Task, status: Status) => {
    send({ type: "moveTask", id: tk.id, status });
    showUndo(t("wr.moved", { title: tk.title, status: statusLabel(lang, status) }), () =>
      send({ type: "moveTask", id: tk.id, status: INBOX })
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
  const remove = (tk: Task, viaKeyboard: boolean) => {
    const snapshot: Task = { ...tk, subtasks: tk.subtasks.map((s) => ({ ...s })) };
    send({ type: "deleteTask", id: tk.id });
    showUndo(t("ux.board.taskDeleted", { title: snapshot.title }), () => send({ type: "addTask", task: snapshot }), 8000, {
      focus: viaKeyboard,
    });
  };

  const toggle = () =>
    setOpen((o) => {
      writeInboxOpen(!o);
      return !o;
    });

  const count = "text-[11px] font-semibold text-ink-2 bg-white rounded-full px-2 py-0.5 border border-[#E8E6E1]";

  return (
    <section
      aria-label={t("inbox.title")}
      data-inbox-strip=""
      onDragEnter={(e) => {
        if (dragging) {
          e.preventDefault();
          setOver(true);
        }
      }}
      onDragOver={(e) => {
        if (!dragging) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        if (!over) setOver(true);
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node)) setOver(false);
      }}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        onDropCard();
      }}
      className={`rounded-[14px] p-3 transition-colors ${over ? "drop-target" : "bg-[#EFECE6]"}`}
    >
      <div className="flex items-center gap-2 flex-wrap">
        <button
          ref={headRef}
          type="button"
          aria-expanded={open}
          aria-controls={open ? "board-inbox-panel" : undefined}
          onClick={toggle}
          className="flex items-center gap-2 text-left min-w-0"
        >
          <span aria-hidden="true" className={`text-ink-2 text-[11px] transition-transform ${open ? "rotate-90" : ""}`}>▶</span>
          <span className="text-ink-2">
            <IconInbox />
          </span>
          <span className="font-trajan text-[12px] uppercase tracking-widest text-ink-2">{t("inbox.title")}</span>
          <span className={count} aria-hidden="true">
            {tasks.length}
          </span>
          <span className="sr-only">, {t("inbox.countSr", { n: tasks.length })}</span>
        </button>
        <span className="text-[10px] text-ink-2 ml-1 hidden md:inline truncate min-w-0 flex-1">
          {over ? t("inbox.drop") : t("inbox.hint")}
        </span>
        <button
          type="button"
          onClick={() => openInboxCapture()}
          title={t("inbox.captureTip")}
          aria-keyshortcuts="I"
          className="ml-auto h-8 pl-3 pr-3.5 rounded-full text-[12px] font-semibold bg-[#0A1931] text-[#C9A96E] inline-flex items-center gap-1.5"
        >
          <span aria-hidden="true">+</span>
          {t("inbox.capture")}
          <kbd aria-hidden="true" className="ml-0.5 px-1 rounded border border-current text-[10px] leading-[14px] font-semibold font-sans">I</kbd>
        </button>
      </div>

      {open && (
        <div id="board-inbox-panel">
          {tasks.length === 0 ? (
            <p className="mt-2 px-0.5 text-[12px] text-ink-2">
              {over ? t("inbox.drop") : filtersActive && total > 0 ? t("inbox.filtered") : t("inbox.empty")}
            </p>
          ) : (
            <ul ref={listRef} className="mt-2 space-y-1.5">
              {rows.map((tk, i) => (
                <InboxRow
                  key={tk.id}
                  task={tk}
                  board={board}
                  members={members}
                  send={send}
                  showNames={showNames}
                  when={when(tk)}
                  open={openId === tk.id}
                  onToggle={() => setOpenId((o) => (o === tk.id ? null : tk.id))}
                  onAction={() => {
                    afterAction.current = { id: tk.id, i, at: Date.now() };
                  }}
                  actions={{ sortTo, setDue, assign, remove }}
                  draggable={draggable}
                  onDragStart={onDragStart}
                  onDragEnd={onDragEnd}
                />
              ))}
            </ul>
          )}
          {tasks.length > FIRST_ROWS && (
            <button
              type="button"
              aria-expanded={all}
              onClick={() => setAll((v) => !v)}
              className="mt-2 h-7 px-3 rounded-full text-[11px] font-semibold bg-white text-[#0A1931] border border-[#E8E6E1]"
            >
              {all ? t("inbox.showLess") : t("inbox.showAll", { n: tasks.length })}
            </button>
          )}
        </div>
      )}
    </section>
  );
}

interface Actions {
  sortTo: (tk: Task, s: Status) => void;
  setDue: (tk: Task, iso: string) => void;
  assign: (tk: Task, name: string) => void;
  remove: (tk: Task, viaKeyboard: boolean) => void;
}

function InboxRow({
  task: tk,
  board,
  members,
  send,
  showNames,
  when,
  open,
  onToggle,
  onAction,
  actions,
  draggable,
  onDragStart,
  onDragEnd,
}: {
  task: Task;
  board: Board;
  members: string[];
  send: (op: Op) => void;
  showNames: boolean;
  when: string;
  open: boolean;
  onToggle: () => void;
  onAction: () => void;
  actions: Actions;
  draggable: boolean;
  onDragStart: (id: string, e: React.DragEvent) => void;
  onDragEnd: (id: string, e: React.DragEvent) => void;
}) {
  const { t, lang } = useT();
  const title = tk.title.trim() || "—";
  const detailsId = `inbox-details-${tk.id}`;
  // The date is written once complete and the field is left (or on Enter),
  // as in the weekly review.
  const [due, setDueDraft] = useState(tk.dueDate ?? "");
  useEffect(() => setDueDraft(tk.dueDate ?? ""), [tk.dueDate]);
  const commitDue = (v = due) => {
    if (v === (tk.dueDate ?? "") || !/^\d{4}-\d{2}-\d{2}$/.test(v) || Number(v.slice(0, 4)) < 2000) return;
    onAction();
    actions.setDue(tk, v);
  };
  // Typed digit by digit: saved on Enter or on leaving the field. Picked in the
  // calendar (no key pressed just before): saved at once (as in Revisione).
  const typedAt = useRef(0);
  const act = (fn: () => void) => {
    onAction();
    fn();
  };
  const who = showNames ? ownersLabel(tk, (n) => ownerLabel(t, n)) : "—";
  // Sent back to the Inbox from its editor's section picker: the focus
  // follows it here (lib/focusAfterMove.ts), as it does between columns.
  const titleRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (claimFocusAfterMove(tk.id)) titleRef.current?.focus();
  }, [tk.id]);

  return (
    <li
      data-inbox-item={tk.id}
      draggable={draggable && !open}
      onDragStart={(e) => onDragStart(tk.id, e)}
      onDragEnd={(e) => onDragEnd(tk.id, e)}
      className="bg-white rounded-[12px] border border-[#E8E6E1]"
    >
      <div className="px-3 py-2 flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <div className="flex items-center gap-2 min-w-0 flex-1 basis-[220px]">
          <span className={`w-2 h-2 shrink-0 rounded-full ${PRIORITY_DOT[tk.priority]}`} aria-hidden="true" />
          <div className="min-w-0">
            <button
              type="button"
              ref={titleRef}
              data-inbox-title={tk.id}
              aria-expanded={open}
              aria-controls={open ? detailsId : undefined}
              onClick={onToggle}
              className="text-left text-[13px] font-semibold text-[#0A1931] break-words [overflow-wrap:anywhere] rounded"
            >
              {title}
            </button>
            <div className="text-[11px] text-ink-2">{t("inbox.whoWhen", { who, when })}</div>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[11px] text-ink-2" aria-hidden="true">
            {t("inbox.sortLabel")}
          </span>
          <div role="group" aria-label={t("inbox.sortTo", { title })} className="seg">
            {SORT_TARGETS.map((s) => (
              <button key={s} type="button" onClick={() => act(() => actions.sortTo(tk, s))} className="tab h-7 px-2.5 text-[11px] font-semibold">
                {statusLabel(lang, s)}
              </button>
            ))}
          </div>
          <label className="inline-flex items-center gap-1.5 bg-[#F5F3EF] rounded-full px-3 h-7 border border-[#E8E6E1] text-[11px] text-ink-2 field">
            <span aria-hidden="true">{t("task.due")}</span>
            <input
              type="date"
              value={due}
              aria-label={t("wr.dueFor", { title })}
              onChange={(e) => {
                setDueDraft(e.target.value);
                if (Date.now() - typedAt.current > 1000) commitDue(e.target.value);
              }}
              onBlur={() => commitDue()}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  commitDue();
                } else typedAt.current = Date.now();
              }}
              className="bg-transparent outline-none text-[11px] text-[#0A1931]"
            />
          </label>
          {members.length > 0 && (
            <label className="inline-flex items-center bg-[#F5F3EF] rounded-full pl-3 pr-1 h-7 border border-[#E8E6E1] text-[11px] field">
              <select
                value=""
                aria-label={t("wr.assignFor", { title })}
                onChange={(e) => e.target.value && act(() => actions.assign(tk, e.target.value))}
                className="bg-transparent outline-none text-[11px] text-[#0A1931] cursor-pointer max-w-[140px]"
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
            className="h-7 px-3 rounded-full text-[11px] font-semibold text-ink-2 border border-[#E8E6E1]"
          >
            {t("task.delete")}
          </button>
        </div>
      </div>
      {open && (
        <div id={detailsId} className="border-t border-[#E8E6E1] p-3" aria-label={t("wr.details", { title })} role="region">
          <TaskDetails task={tk} members={board.members} send={send} showNames={showNames} multiAssign={board.assigneesAvailable !== false} />
        </div>
      )}
    </li>
  );
}
