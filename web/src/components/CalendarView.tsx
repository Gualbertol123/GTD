import { useEffect, useMemo, useRef, useState } from "react";
import type { Board, Op, Priority, Task } from "../lib/types";
import { PRIORITY_DOT } from "../lib/constants";
import { sameDay, toISODate } from "../lib/dates";
import { localeCode, monthName, weekdayNames, useT } from "../lib/i18n";
import { TaskDetails } from "./TaskDetails";
import { IconBack, IconChevron, IconClose } from "../mobile/icons";

interface Props {
  board: Board;
  tasks: Task[]; // filtered
  members: string[];
  send: (op: Op) => void;
}

// The shown month survives tab switches (Board -> Calendar -> Board) for the
// session, without going into the hash route.
let lastMonth: Date | null = null;

// Chips shown per day before the "+n more" button.
const CAP = 3;

// The shared P4 dot is a dashed #E8E6E1 ring that disappears on the chip
// background; the calendar uses a visible hollow ring instead.
const dotClass = (p: Priority) =>
  p === "P4" ? "bg-transparent border border-[#8A8A8A]" : PRIORITY_DOT[p];

const isTextTarget = (el: EventTarget | null) => {
  const n = el as HTMLElement | null;
  if (!n || !n.tagName) return false;
  return (
    n.tagName === "INPUT" ||
    n.tagName === "TEXTAREA" ||
    n.tagName === "SELECT" ||
    n.isContentEditable
  );
};

const currentMonth = () => {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth(), 1);
};

export function CalendarView({ board, tasks, members, send }: Props) {
  const { t, lang } = useT();
  const loc = localeCode(lang);
  const [month, setMonthState] = useState<Date>(() => lastMonth ?? currentMonth());
  const setMonth = (d: Date) => {
    lastMonth = d;
    setMonthState(d);
  };
  const [dragId, setDragId] = useState<string | null>(null);
  const [overKey, setOverKey] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedDay, setSelectedDay] = useState<string | null>(null);
  const [toast, setToast] = useState<{ msg: string; undo: () => void } | null>(null);
  const [toastHold, setToastHold] = useState(false);

  const detailsRef = useRef<HTMLDivElement>(null);
  const focusDetails = useRef(false);
  const openerRef = useRef<HTMLElement | null>(null);

  const weekdays = weekdayNames(lang);
  const withoutDue = tasks.filter((tk) => !tk.dueDate && tk.status !== "DONE");
  const selected = board.tasks.find((tk) => tk.id === selectedId) ?? null;

  // One pass over the tasks per render; ISO strings are compared directly so a
  // "yyyy-mm-dd" due date never shifts by a day in negative-UTC time zones.
  const byDay = useMemo(() => {
    const m = new Map<string, Task[]>();
    for (const tk of tasks) {
      if (!tk.dueDate) continue;
      const k = tk.dueDate.slice(0, 10);
      const list = m.get(k);
      if (list) list.push(tk);
      else m.set(k, [tk]);
    }
    return m;
  }, [tasks]);

  const first = new Date(month.getFullYear(), month.getMonth(), 1);
  const startOffset = (first.getDay() + 6) % 7; // Monday-first
  const daysInMonth = new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate();
  const cells: (Date | null)[] = [];
  for (let i = 0; i < startOffset; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(new Date(month.getFullYear(), month.getMonth(), d));
  while (cells.length % 7 !== 0) cells.push(null);

  const today = new Date();
  const todayIso = toISODate(today);
  const thisMonth = currentMonth();
  const showingThisMonth =
    month.getFullYear() === thisMonth.getFullYear() && month.getMonth() === thisMonth.getMonth();

  const longDate = (iso: string) =>
    new Date(iso + "T00:00:00").toLocaleDateString(loc, { weekday: "long", day: "numeric", month: "long" });
  const shortDate = (iso: string) =>
    new Date(iso + "T00:00:00").toLocaleDateString(loc, { day: "numeric", month: "short" });

  // Toast auto-dismiss (paused while hovered or focused).
  useEffect(() => {
    if (!toast || toastHold) return;
    const id = window.setTimeout(() => setToast(null), 7000);
    return () => window.clearTimeout(id);
  }, [toast, toastHold]);

  // After a keyboard selection, move focus to the details panel.
  useEffect(() => {
    if (selectedId && focusDetails.current) {
      focusDetails.current = false;
      detailsRef.current?.focus();
    }
  }, [selectedId]);

  const select = (id: string, e: React.MouseEvent<HTMLElement>) => {
    openerRef.current = e.currentTarget;
    // detail === 0: activated with the keyboard (Enter / Space).
    focusDetails.current = e.detail === 0;
    setSelectedId(id);
  };

  const restoreFocus = () => {
    const el = openerRef.current;
    openerRef.current = null;
    if (el && el.isConnected) el.focus();
  };

  const closeDetails = () => {
    setSelectedId(null);
    restoreFocus();
  };

  const setDue = (id: string, dueDate: string | undefined) => {
    const prev = board.tasks.find((tk) => tk.id === id)?.dueDate;
    const prevKey = prev ? prev.slice(0, 10) : undefined;
    if (prevKey === dueDate) return; // dropped on the same date: nothing to do
    send({ type: "setDueDate", id, dueDate });
    setToast({
      msg: dueDate ? t("cal.moved", { date: shortDate(dueDate) }) : t("cal.dueRemoved"),
      undo: () => send({ type: "setDueDate", id, dueDate: prev }),
    });
  };

  const dragStart = (id: string) => (e: React.DragEvent) => {
    // Firefox only starts a drag when data is set.
    e.dataTransfer.setData("text/plain", id);
    e.dataTransfer.effectAllowed = "move";
    setDragId(id);
  };
  const dragEnd = () => {
    setDragId(null);
    setOverKey(null);
  };
  const droppedId = (e: React.DragEvent) => dragId ?? (e.dataTransfer.getData("text/plain") || null);

  const onRootKeyDown = (e: React.KeyboardEvent) => {
    if (e.key !== "Escape" || e.defaultPrevented || isTextTarget(e.target)) return;
    if ((e.target as HTMLElement).closest?.('[role="dialog"]')) return;
    if (selectedId) {
      e.stopPropagation();
      closeDetails();
    } else if (selectedDay) {
      e.stopPropagation();
      setSelectedDay(null);
    }
  };

  const onGridKeyDown = (e: React.KeyboardEvent) => {
    if (isTextTarget(e.target)) return;
    if (e.key === "PageUp" || e.key === "PageDown") {
      e.preventDefault();
      const delta = e.key === "PageUp" ? -1 : 1;
      setMonth(new Date(month.getFullYear(), month.getMonth() + delta, 1));
    }
  };

  const chipLabel = (tk: Task, iso: string) => {
    const parts = [tk.title, longDate(iso), tk.priority];
    if (tk.status === "DONE") parts.push(t("cal.done"));
    else if (iso < todayIso) parts.push(t("cal.overdue"));
    return parts.join(", ");
  };

  const rowClass = (tk: Task) =>
    `w-full text-left flex items-center gap-2 bg-[#F5F3EF] rounded-lg border px-2 py-1.5 cursor-pointer hover:border-[#C9A96E] ${
      selectedId === tk.id ? "border-[#C9A96E]" : "border-[#E8E6E1]"
    }`;

  const dayList = selectedDay ? byDay.get(selectedDay) ?? [] : [];
  const draggingDated = !!dragId && !!board.tasks.find((tk) => tk.id === dragId)?.dueDate;

  return (
    <div className="space-y-4" onKeyDown={onRootKeyDown}>
      <div className="text-[12px] text-[#6B6B6B]">{t("cal.help")}</div>

      <div className="grid grid-cols-1 lg:grid-cols-[260px_1fr] xl:grid-cols-[320px_1fr] gap-4 items-start">
        {/* Left panel: selected task details, day list, unscheduled list.
            Sticky on desktop so a click low in the month still shows the details. */}
        <div className="space-y-4 lg:sticky lg:top-4 lg:self-start lg:max-h-[calc(100vh-2rem)] lg:overflow-y-auto lg:p-1 lg:-m-1">
          <div
            ref={detailsRef}
            tabIndex={-1}
            aria-labelledby="cal-details-title"
            className="bg-white rounded-[14px] border border-[#E8E6E1] p-3 outline-none focus-visible:ring-2 focus-visible:ring-[#C9A96E]"
          >
            <div className="flex items-center justify-between gap-2 mb-3">
              <div id="cal-details-title" className="font-trajan text-[11px] uppercase text-[#8A8A8A]">
                {t("cal.details")}
              </div>
              {selected && (
                <button
                  type="button"
                  onClick={closeDetails}
                  aria-label={t("cal.closeDetails")}
                  title={t("cal.closeDetails")}
                  className="h-7 w-7 -my-1 inline-flex items-center justify-center rounded-full text-[#8A8A8A] hover:text-[#0A1931] border border-transparent hover:border-[#E8E6E1]"
                >
                  <IconClose size={16} />
                </button>
              )}
            </div>
            {selected ? (
              <TaskDetails
                task={selected}
                members={members}
                send={send}
                multiAssign={board.assigneesAvailable !== false}
                onDeleted={() => setSelectedId(null)}
              />
            ) : (
              <div className="text-[12px] text-[#A8A29E] py-4">{t("cal.selectHint")}</div>
            )}
          </div>

          {selectedDay && (
            <div className="bg-white rounded-[14px] border border-[#E8E6E1] p-3">
              <div className="flex items-center justify-between gap-2 mb-2">
                <div className="font-trajan text-[11px] uppercase text-[#8A8A8A]">
                  {t("cal.dayTasks", { date: longDate(selectedDay) })}
                </div>
                <button
                  type="button"
                  onClick={() => setSelectedDay(null)}
                  aria-label={t("cal.closeDay")}
                  title={t("cal.closeDay")}
                  className="h-7 w-7 -my-1 inline-flex items-center justify-center rounded-full text-[#8A8A8A] hover:text-[#0A1931] border border-transparent hover:border-[#E8E6E1]"
                >
                  <IconClose size={16} />
                </button>
              </div>
              <div className="space-y-1.5">
                {dayList.map((tk) => (
                  <button
                    type="button"
                    key={tk.id}
                    draggable
                    onDragStart={dragStart(tk.id)}
                    onDragEnd={dragEnd}
                    onClick={(e) => select(tk.id, e)}
                    aria-label={chipLabel(tk, selectedDay)}
                    className={`${rowClass(tk)} ${
                      tk.status !== "DONE" && selectedDay < todayIso ? "border-l-2 border-l-[#DC2626]" : ""
                    }`}
                  >
                    <span title={tk.priority} className={`w-2 h-2 rounded-full shrink-0 ${dotClass(tk.priority)}`} />
                    <span
                      className={`text-[12px] text-[#0A1931] truncate ${
                        tk.status === "DONE" ? "line-through opacity-60" : ""
                      }`}
                    >
                      {tk.title}
                    </span>
                  </button>
                ))}
              </div>
            </div>
          )}

          <div
            onDragOver={(e) => {
              if (!draggingDated) return;
              e.preventDefault();
              e.dataTransfer.dropEffect = "move";
              setOverKey("nodue");
            }}
            onDragLeave={() => setOverKey((k) => (k === "nodue" ? null : k))}
            onDrop={(e) => {
              e.preventDefault();
              const id = droppedId(e);
              if (id) setDue(id, undefined);
              dragEnd();
            }}
            className={`bg-white rounded-[14px] border p-3 ${
              overKey === "nodue" ? "border-[#C9A96E]" : "border-[#E8E6E1]"
            }`}
          >
            <div className="font-trajan text-[11px] uppercase text-[#8A8A8A] mb-2">{t("cal.noDue")}</div>
            {draggingDated && (
              <div className="text-[11px] text-[#8B6F3E] mb-2">{t("cal.dropNoDue")}</div>
            )}
            {withoutDue.length === 0 ? (
              <div className="text-[11px] text-[#A8A29E]">{t("cal.allHaveDate")}</div>
            ) : (
              <div className="space-y-1.5">
                {withoutDue.map((tk) => (
                  <button
                    type="button"
                    key={tk.id}
                    draggable
                    onDragStart={dragStart(tk.id)}
                    onDragEnd={dragEnd}
                    onClick={(e) => select(tk.id, e)}
                    aria-label={`${tk.title}, ${tk.priority}`}
                    className={rowClass(tk)}
                  >
                    <span title={tk.priority} className={`w-2 h-2 rounded-full shrink-0 ${dotClass(tk.priority)}`} />
                    <span className="text-[12px] text-[#0A1931] truncate">{tk.title}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Calendar grid */}
        <div className="bg-white rounded-[14px] border border-[#E8E6E1] p-4" onKeyDown={onGridKeyDown}>
          <div className="flex items-center justify-between gap-2 mb-4">
            <button
              type="button"
              onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() - 1, 1))}
              aria-label={t("cal.prevMonth")}
              title={t("cal.prevMonth")}
              className="h-8 w-8 inline-flex items-center justify-center rounded-full border border-[#E8E6E1] hover:border-[#C9A96E] text-[#0A1931]"
            >
              <IconBack size={16} />
            </button>
            <div className="flex items-center gap-3 min-w-0">
              <div
                aria-live="polite"
                className="font-trajan text-[14px] uppercase tracking-widest text-[#0A1931] truncate"
              >
                {monthName(lang, month.getMonth())} {month.getFullYear()}
              </div>
              <button
                type="button"
                onClick={() => setMonth(currentMonth())}
                aria-pressed={showingThisMonth}
                className={`h-8 px-3 rounded-full text-[12px] font-semibold border shrink-0 ${
                  showingThisMonth
                    ? "bg-white text-[#8A8A8A] border-[#E8E6E1] cursor-default"
                    : "bg-white text-[#0A1931] border-[#E8E6E1] hover:border-[#C9A96E]"
                }`}
              >
                {t("cal.today")}
              </button>
            </div>
            <button
              type="button"
              onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() + 1, 1))}
              aria-label={t("cal.nextMonth")}
              title={t("cal.nextMonth")}
              className="h-8 w-8 inline-flex items-center justify-center rounded-full border border-[#E8E6E1] hover:border-[#C9A96E] text-[#0A1931]"
            >
              <IconChevron size={16} />
            </button>
          </div>

          <div className="grid grid-cols-7 gap-1 mb-1">
            {weekdays.map((w) => (
              <div key={w} className="text-[10px] uppercase text-[#8A8A8A] text-center font-semibold">{w}</div>
            ))}
          </div>

          <div className="grid grid-cols-7 gap-1">
            {cells.map((date, i) => {
              if (!date) return <div key={i} />;
              const key = toISODate(date);
              const dayTasks = byDay.get(key) ?? [];
              const isToday = sameDay(date, today);
              const isPast = key < todayIso;
              let visible = dayTasks;
              if (dayTasks.length > CAP + 1) {
                visible = dayTasks.slice(0, CAP);
                const sel = dayTasks.find((tk) => tk.id === selectedId);
                if (sel && !visible.includes(sel)) visible = [...dayTasks.slice(0, CAP - 1), sel];
              }
              const hidden = dayTasks.length - visible.length;
              return (
                <div
                  key={key}
                  aria-current={isToday ? "date" : undefined}
                  onDragOver={(e) => {
                    e.preventDefault();
                    e.dataTransfer.dropEffect = "move";
                    setOverKey(key);
                  }}
                  onDragLeave={() => setOverKey((k) => (k === key ? null : k))}
                  onDrop={(e) => {
                    e.preventDefault();
                    const id = droppedId(e);
                    if (id) setDue(id, key);
                    dragEnd();
                  }}
                  className={`min-h-[80px] min-w-0 rounded-lg border p-1 ${
                    overKey === key ? "border-[#C9A96E] bg-[#FAF9F6]" : "border-[#E8E6E1]"
                  } ${isToday ? "bg-[#F5F3EF]" : ""}`}
                >
                  <div
                    className={`text-[11px] text-right px-1 ${
                      isToday ? "font-bold text-[#8B6F3E]" : isPast ? "text-[#8A8A8A] opacity-60" : "text-[#8A8A8A]"
                    }`}
                  >
                    {date.getDate()}
                  </div>
                  <div className="space-y-0.5 mt-0.5">
                    {visible.map((tk) => {
                      const isSel = selectedId === tk.id;
                      const done = tk.status === "DONE";
                      const overdue = !done && isPast;
                      return (
                        <button
                          type="button"
                          key={tk.id}
                          draggable
                          onDragStart={dragStart(tk.id)}
                          onDragEnd={dragEnd}
                          onClick={(e) => select(tk.id, e)}
                          title={tk.title}
                          aria-label={chipLabel(tk, key)}
                          className={`w-full flex items-center gap-1 rounded px-1 py-0.5 cursor-pointer text-left ${
                            isSel ? "bg-[#0A1931]" : "bg-[#F5F3EF] hover:bg-[#EFECE6]"
                          } ${overdue ? "border-l-2 border-[#DC2626]" : ""}`}
                        >
                          <span title={tk.priority} className={`w-1.5 h-1.5 rounded-full shrink-0 ${dotClass(tk.priority)}`} />
                          <span
                            className={`text-[11px] leading-tight line-clamp-2 break-words min-w-0 ${
                              isSel ? "text-white" : "text-[#0A1931]"
                            } ${done ? `line-through ${isSel ? "" : "opacity-60"}` : ""}`}
                          >
                            {tk.title}
                          </span>
                        </button>
                      );
                    })}
                    {hidden > 0 && (
                      <button
                        type="button"
                        onClick={() => setSelectedDay(key)}
                        aria-label={`${t("cal.more", { n: hidden })}, ${longDate(key)}`}
                        className={`w-full text-left rounded px-1 py-0.5 text-[11px] font-semibold hover:bg-[#EFECE6] ${
                          selectedDay === key ? "text-[#0A1931] underline" : "text-[#8B6F3E]"
                        }`}
                      >
                        {t("cal.more", { n: hidden })}
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {/* The wrapper holds the position: the glass skin makes every .bg-white
          panel position:relative, which would undo "fixed" on the bar itself. */}
      {toast && (
        <div className="fixed bottom-6 inset-x-0 z-50 flex justify-center px-4 pointer-events-none">
          <div
            role="status"
            aria-live="polite"
            onMouseEnter={() => setToastHold(true)}
            onMouseLeave={() => setToastHold(false)}
            onFocus={() => setToastHold(true)}
            onBlur={(e) => {
              if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setToastHold(false);
            }}
            className="pointer-events-auto flex items-center gap-3 rounded-full bg-white border border-[#E8E6E1] shadow-lg pl-4 pr-1.5 py-1.5 text-[13px] text-[#0A1931] max-w-full"
          >
            <span className="min-w-0 truncate">{toast.msg}</span>
            <button
              type="button"
              onClick={() => {
                toast.undo();
                setToast(null);
                setToastHold(false);
              }}
              className="h-8 px-4 rounded-full bg-[#0A1931] text-[#C9A96E] text-[12px] font-semibold shrink-0"
            >
              {t("cal.undo")}
            </button>
            <button
              type="button"
              onClick={() => {
                setToast(null);
                setToastHold(false);
              }}
              aria-label={t("cal.dismiss")}
              title={t("cal.dismiss")}
              className="h-8 w-8 inline-flex items-center justify-center rounded-full text-[#8A8A8A] hover:text-[#0A1931] shrink-0"
            >
              <IconClose size={16} />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
