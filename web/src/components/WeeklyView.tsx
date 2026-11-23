import { useEffect, useMemo, useRef, useState } from "react";
import type { Board, Op, Task, Weekly, WeeklyItem } from "../lib/types";
import { WEEKLY_COLUMNS, genId } from "../lib/constants";
import { ownersLabel, taskOwners } from "../lib/owners";
import { localeCode, useT } from "../lib/i18n";
import { periodBounds, taskCompletedAt, weekPeriod } from "../lib/reportData";
import { useSyncedField } from "../lib/useSyncedField";
import { IconCheck, IconChevron, IconClose } from "../mobile/icons";
import { AutoTextarea } from "./AutoTextarea";

interface Props {
  board: Board;
  send: (op: Op) => void;
}

type ColKey = keyof Weekly;
type Removed = { column: ColKey; item: WeeklyItem };
type Undo = { id: number; msg: string; items: Removed[]; focus: boolean };
type Grouping = "day" | "owner";

const UNDO_MS = 6000;
const ARCHIVE_CAP = 20;
const GROUP_KEY = "gtd-weekly-recap-group";

function readGrouping(): Grouping {
  try {
    return localStorage.getItem(GROUP_KEY) === "owner" ? "owner" : "day";
  } catch {
    return "day";
  }
}
function writeGrouping(g: Grouping) {
  try {
    localStorage.setItem(GROUP_KEY, g);
  } catch {
    /* private mode: just don't remember it */
  }
}

/** "10–16 nov" or "28 ott – 3 nov", in the UI language. */
function rangeLabel(loc: string, start: number, end: number): string {
  const a = new Date(start);
  const b = new Date(end - 1);
  const dm = new Intl.DateTimeFormat(loc, { day: "numeric", month: "short" });
  if (a.getMonth() === b.getMonth() && a.getFullYear() === b.getFullYear()) {
    return `${a.getDate()}–${dm.format(b)}`;
  }
  return `${dm.format(a)} – ${dm.format(b)}`;
}

const chevBtn =
  "h-7 w-7 rounded-full flex items-center justify-center bg-white border border-[#A7F3D0] text-[#065F46] hover:border-[#065F46] disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:border-[#A7F3D0]";

export function WeeklyView({ board, send }: Props) {
  const { t, lang } = useT();
  const loc = localeCode(lang);
  const [offset, setOffset] = useState(0);
  const [grouping, setGrouping] = useState<Grouping>(readGrouping);
  const [confirmClear, setConfirmClear] = useState(false);
  const [archOpen, setArchOpen] = useState(false);
  const [archAll, setArchAll] = useState(false);
  const [undo, setUndo] = useState<Undo | null>(null);
  const [undoHold, setUndoHold] = useState(false);
  const clearBtnRef = useRef<HTMLButtonElement>(null);
  const refocusClear = useRef(false);
  const undoBtnRef = useRef<HTMLButtonElement>(null);

  // The Recap follows the Monday–Sunday week, like the Report tab. Everything
  // done before the week shown sits in Archiviate, so nothing falls in between.
  const { start, end } = periodBounds(weekPeriod(offset));
  const allDone = board.tasks.filter((tk) => tk.status === "DONE");
  const recap = allDone
    .filter((tk) => {
      const at = taskCompletedAt(tk);
      return at >= start && at < end;
    })
    .sort((a, b) => taskCompletedAt(b) - taskCompletedAt(a));
  const archivedDone = allDone
    .filter((tk) => taskCompletedAt(tk) < start)
    .sort((a, b) => taskCompletedAt(b) - taskCompletedAt(a));
  const archShown = archAll ? archivedDone : archivedDone.slice(0, ARCHIVE_CAP);

  const dayFmt = useMemo(
    () => new Intl.DateTimeFormat(loc, { weekday: "short", day: "numeric" }),
    [loc],
  );
  const dayOf = (tk: Task) => {
    const at = taskCompletedAt(tk);
    return at > 0 ? dayFmt.format(new Date(at)) : "";
  };

  const groups: { owner: string; tasks: Task[] }[] = [];
  if (grouping === "owner") {
    const byOwner = new Map<string, Task[]>();
    for (const tk of recap) {
      for (const o of taskOwners(tk)) {
        if (!byOwner.has(o)) byOwner.set(o, []);
        byOwner.get(o)!.push(tk);
      }
    }
    for (const [owner, tasks] of [...byOwner.entries()].sort((a, b) =>
      a[0].localeCompare(b[0]),
    )) {
      groups.push({ owner, tasks });
    }
  }

  const itemCount = WEEKLY_COLUMNS.reduce(
    (n, c) => n + board.weekly[c.key].length,
    0,
  );

  // Undo bar: disappears after 6 s, but not while the pointer or focus is on it.
  useEffect(() => {
    if (!undo || undoHold) return;
    const h = window.setTimeout(() => setUndo(null), UNDO_MS);
    return () => window.clearTimeout(h);
  }, [undo, undoHold]);
  useEffect(() => {
    if (undo?.focus) undoBtnRef.current?.focus();
  }, [undo]);

  // The Clear button remounts when the confirmation closes: give it focus back.
  useEffect(() => {
    if (!confirmClear && refocusClear.current) {
      refocusClear.current = false;
      clearBtnRef.current?.focus();
    }
  }, [confirmClear]);

  const cancelClear = () => {
    refocusClear.current = true;
    setConfirmClear(false);
  };

  const removeItem = (column: ColKey, item: WeeklyItem, focus: boolean) => {
    send({ type: "weeklyDelete", column, id: item.id });
    setUndoHold(false);
    setUndo({
      id: Date.now(),
      msg: t("weekly.itemDeleted"),
      items: [{ column, item }],
      focus,
    });
  };

  const clearAll = () => {
    const snapshot: Removed[] = [];
    for (const c of WEEKLY_COLUMNS)
      for (const item of board.weekly[c.key])
        snapshot.push({ column: c.key, item });
    send({ type: "weeklyClear" });
    setConfirmClear(false);
    setUndoHold(false);
    setUndo({
      id: Date.now(),
      msg: t("weekly.cleared", { n: snapshot.length }),
      items: snapshot,
      focus: true,
    });
  };

  // Restored items go back with the same id and text; the server stamps a new
  // created_at (increasing, one per add), so a single restored item moves to
  // the end of its column and a cleared weekly comes back in its order.
  const restore = () => {
    if (!undo) return;
    for (const r of undo.items) send({ type: "weeklyAdd", column: r.column, item: { ...r.item } });
    setUndo(null);
  };

  const setGroup = (g: Grouping) => {
    setGrouping(g);
    writeGrouping(g);
  };

  const recapRow = (tk: Task, key: string) => {
    const total = tk.subtasks.length;
    const done = tk.subtasks.filter((s) => s.done).length;
    const day = dayOf(tk);
    return (
      <div
        key={key}
        className="text-[13px] text-[#065F46] bg-white rounded-lg border border-[#A7F3D0] px-3 py-1.5 flex items-center justify-between gap-2"
      >
        <span className="min-w-0">
          <span className="font-medium">{tk.title}</span>
          <span className="text-[#8A8A8A] text-[11px]">
            {" "}
            · {ownersLabel(tk, (n) => n)}
          </span>
          {tk.desc && (
            <span
              className="text-[#8A8A8A] text-[11px] block truncate"
              title={tk.desc}
            >
              {tk.desc}
            </span>
          )}
        </span>
        <span className="shrink-0 flex items-center gap-1.5">
          {total > 0 && (
            <span className="text-[10px] text-[#8A8A8A] inline-flex items-center gap-0.5">
              <IconCheck size={11} />
              {done}/{total} {t("weekly.subtasksDone")}
            </span>
          )}
          <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-[#ECFDF5] border border-[#A7F3D0]">
            {tk.priority}
          </span>
          {day && (
            <span className="text-[10px] text-[#8A8A8A] tabular-nums w-[44px] text-right">
              {day}
            </span>
          )}
        </span>
      </div>
    );
  };

  const range = rangeLabel(loc, start, end);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div className="text-[12px] text-[#6B6B6B] max-w-[760px]">
          {t("weekly.helpV2")}
        </div>
        {confirmClear ? (
          <div
            role="alertdialog"
            aria-labelledby="weekly-clear-q"
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.stopPropagation();
                cancelClear();
              }
            }}
            className="flex items-center gap-2 text-[12px]"
          >
            <span id="weekly-clear-q" className="text-[#DC2626]">
              {t("weekly.confirmClearN", { n: itemCount })}
            </span>
            <button
              type="button"
              autoFocus
              onClick={cancelClear}
              className="h-8 px-3 rounded-full font-semibold bg-white text-[#0A1931] border border-[#E8E6E1] hover:border-[#C9A96E]"
            >
              {t("task.no")}
            </button>
            <button
              type="button"
              onClick={clearAll}
              className="h-8 px-3 rounded-full font-semibold text-[#DC2626] border border-[#FECACA] bg-[#FEF2F2] hover:border-[#DC2626]"
            >
              {t("task.yes")}
            </button>
          </div>
        ) : (
          <button
            ref={clearBtnRef}
            type="button"
            onClick={() => setConfirmClear(true)}
            disabled={itemCount === 0}
            title={itemCount === 0 ? t("weekly.clearEmpty") : undefined}
            className="h-9 px-4 rounded-full text-[12px] font-semibold bg-white text-[#8A8A8A] border border-[#E8E6E1] hover:border-[#DC2626] hover:text-[#DC2626] disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:border-[#E8E6E1] disabled:hover:text-[#8A8A8A]"
          >
            {t("weekly.clear")}
          </button>
        )}
      </div>

      {/* Recap of the week shown (auto, from DONE tasks) */}
      <section
        aria-labelledby="weekly-recap-title"
        className="bg-[#ECFDF5] border border-[#A7F3D0] rounded-[14px] p-4"
      >
        <div className="flex items-center gap-x-3 gap-y-2 mb-3 flex-wrap">
          <div className="flex items-center gap-2 min-w-0">
            <h2
              id="weekly-recap-title"
              className="font-trajan text-[11px] uppercase tracking-widest text-[#065F46]"
            >
              {t("weekly.recapTitle")}
            </h2>
            <span className="bg-white border border-[#A7F3D0] text-[#065F46] text-[11px] font-semibold rounded-full px-2 py-0.5">
              {recap.length}
            </span>
          </div>
          <div
            className="flex items-center gap-1.5"
            role="group"
            aria-label={t("weekly.weekOf", { range })}
          >
            <button
              type="button"
              className={chevBtn}
              onClick={() => setOffset((o) => o + 1)}
              aria-label={t("weekly.prevWeek")}
              title={t("weekly.prevWeek")}
            >
              <IconChevron size={14} className="rotate-180" />
            </button>
            <span
              className="text-[12px] font-semibold text-[#065F46] tabular-nums min-w-[96px] text-center"
              aria-live="polite"
            >
              {range}
            </span>
            <button
              type="button"
              className={chevBtn}
              onClick={() => setOffset((o) => Math.max(0, o - 1))}
              disabled={offset === 0}
              aria-label={t("weekly.nextWeek")}
              title={t("weekly.nextWeek")}
            >
              <IconChevron size={14} />
            </button>
            {offset > 0 && (
              <button
                type="button"
                onClick={() => setOffset(0)}
                className="h-7 px-3 rounded-full text-[11px] font-semibold bg-white border border-[#A7F3D0] text-[#065F46] hover:border-[#065F46]"
              >
                {t("weekly.thisWeek")}
              </button>
            )}
          </div>
          {recap.length > 0 && (
            <div
              role="group"
              aria-label={t("weekly.groupBy")}
              className="ml-auto inline-flex rounded-full bg-white border border-[#A7F3D0] p-0.5"
            >
              {(["day", "owner"] as Grouping[]).map((g) => (
                <button
                  key={g}
                  type="button"
                  aria-pressed={grouping === g}
                  onClick={() => setGroup(g)}
                  className={`h-6 px-3 rounded-full text-[11px] font-semibold ${
                    grouping === g
                      ? "bg-[#0A1931] text-[#C9A96E]"
                      : "text-[#6B6B6B] hover:text-[#065F46]"
                  }`}
                >
                  {g === "day"
                    ? t("weekly.groupList")
                    : t("weekly.recapByOwner")}
                </button>
              ))}
            </div>
          )}
        </div>
        {recap.length === 0 ? (
          <div className="text-[12px] text-[#065F46]/70">
            {t("weekly.noneDone")}
          </div>
        ) : grouping === "owner" ? (
          <div className="space-y-3">
            {groups.map((g) => (
              <div key={g.owner}>
                <div className="flex items-center gap-2 mb-1.5">
                  <span className="text-[12px] font-semibold text-[#065F46]">
                    {g.owner}
                  </span>
                  <span className="text-[10px] font-semibold text-[#065F46] bg-white border border-[#A7F3D0] rounded-full px-1.5">
                    {g.tasks.length}
                  </span>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5">
                  {g.tasks.map((tk) => recapRow(tk, `${g.owner}:${tk.id}`))}
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5">
            {recap.map((tk) => recapRow(tk, tk.id))}
          </div>
        )}
      </section>

      {/* Archived — completed before the week shown */}
      {archivedDone.length > 0 && (
        <div className="bg-white rounded-[14px] border border-[#E8E6E1] p-3">
          <button
            type="button"
            onClick={() => setArchOpen((o) => !o)}
            aria-expanded={archOpen}
            aria-controls="weekly-archive"
            className="w-full flex items-center gap-2 text-left"
          >
            <IconChevron
              size={13}
              className={`text-[#8A8A8A] transition-transform ${archOpen ? "rotate-90" : ""}`}
            />
            <span className="font-trajan text-[11px] uppercase tracking-widest text-[#8A8A8A]">
              {t("archived.title")}
            </span>
            <span className="text-[11px] font-semibold text-[#8A8A8A] bg-[#F5F3EF] rounded-full px-2 py-0.5 border border-[#E8E6E1]">
              {archivedDone.length}
            </span>
            <span className="text-[10px] text-[#A8A29E] ml-1 hidden sm:inline">
              {t("weekly.archivedHint")}
            </span>
          </button>
          {archOpen && (
            <div id="weekly-archive">
              <div className="mt-3 grid grid-cols-1 sm:grid-cols-2 gap-1.5">
                {archShown.map((tk: Task) => {
                  const who = ownersLabel(tk, (n) => n);
                  const day =
                    taskCompletedAt(tk) > 0
                      ? new Date(taskCompletedAt(tk)).toLocaleDateString(loc, {
                          day: "numeric",
                          month: "short",
                        })
                      : "";
                  return (
                    <div
                      key={tk.id}
                      title={`${tk.title} · ${who}`}
                      className="text-[13px] text-[#6B6B6B] bg-[#FAF9F6] rounded-lg border border-[#E8E6E1] px-3 py-1.5 flex items-center justify-between gap-2"
                    >
                      <span className="min-w-0 truncate">
                        <span className="font-medium text-[#0A1931]">
                          {tk.title}
                        </span>
                        <span className="text-[#8A8A8A] text-[11px]">
                          {" "}
                          · {who}
                        </span>
                      </span>
                      <span className="shrink-0 flex items-center gap-1.5">
                        <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-white border border-[#E8E6E1]">
                          {tk.priority}
                        </span>
                        {day && (
                          <span className="text-[10px] text-[#8A8A8A] tabular-nums">
                            {day}
                          </span>
                        )}
                      </span>
                    </div>
                  );
                })}
              </div>
              {archivedDone.length > ARCHIVE_CAP && (
                <button
                  type="button"
                  onClick={() => setArchAll((a) => !a)}
                  className="mt-2 text-[12px] font-semibold text-[#6B6B6B] hover:text-[#0A1931] underline-offset-2 hover:underline"
                >
                  {archAll
                    ? t("weekly.showLess")
                    : t("weekly.showAll", { n: archivedDone.length })}
                </button>
              )}
            </div>
          )}
        </div>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-5 gap-4">
        {WEEKLY_COLUMNS.map((col) => (
          <WeeklyColumn
            key={col.key}
            colKey={col.key}
            label={t(`m.weekly.${col.key}`)}
            color={col.color}
            items={board.weekly[col.key]}
            send={send}
            onRemove={removeItem}
          />
        ))}
      </div>

      {/* The wrapper holds the position: the glass skin makes every .bg-white
          panel position:relative, which would undo "fixed" on the bar itself. */}
      {undo && (
        <div className="fixed bottom-6 inset-x-0 z-50 flex justify-center px-4 pointer-events-none">
          <div
            role="status"
            aria-live="polite"
            onMouseEnter={() => setUndoHold(true)}
            onMouseLeave={() => setUndoHold(false)}
            onFocus={() => setUndoHold(true)}
            onBlur={(e) => {
              if (!e.currentTarget.contains(e.relatedTarget as Node | null))
                setUndoHold(false);
            }}
            className="pointer-events-auto flex items-center gap-3 rounded-full bg-white border border-[#E8E6E1] shadow-lg pl-4 pr-1.5 py-1.5 text-[13px] text-[#0A1931] max-w-full"
          >
            <span className="min-w-0 truncate">{undo.msg}</span>
            <button
              ref={undoBtnRef}
              type="button"
              onClick={restore}
              className="h-8 px-4 rounded-full bg-[#0A1931] text-[#C9A96E] text-[12px] font-semibold shrink-0"
            >
              {t("weekly.undo")}
            </button>
            <button
              type="button"
              onClick={() => setUndo(null)}
              aria-label={t("weekly.dismiss")}
              className="h-8 w-8 rounded-full flex items-center justify-center text-[#8A8A8A] hover:text-[#0A1931] shrink-0"
            >
              <IconClose size={14} />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function WeeklyColumn({
  colKey,
  label,
  color,
  items,
  send,
  onRemove,
}: {
  colKey: ColKey;
  label: string;
  color: string;
  items: WeeklyItem[];
  send: (op: Op) => void;
  onRemove: (column: ColKey, item: WeeklyItem, focus: boolean) => void;
}) {
  const { t } = useT();
  const [draft, setDraft] = useState("");
  const add = () => {
    const v = draft.trim();
    if (!v) return;
    send({ type: "weeklyAdd", column: colKey, item: { id: genId(), text: v } });
    setDraft("");
  };

  return (
    <div className="bg-white rounded-[14px] border border-[#E8E6E1] p-3 min-w-0">
      <h3
        className={`weekly-pill weekly-pill--${colKey} text-[10px] font-semibold uppercase tracking-widest leading-snug rounded-full px-3 py-1 border inline-block max-w-full mb-3 ${color}`}
      >
        {label}
      </h3>
      <div className="space-y-1.5">
        {items.map((it) => (
          <div key={it.id} className="group flex items-start gap-1">
            <WeeklyItemField
              text={it.text}
              ariaLabel={t("weekly.itemLabel", { col: label })}
              title={t("weekly.itemHint")}
              onSave={(v) =>
                send({
                  type: "weeklyUpdate",
                  column: colKey,
                  id: it.id,
                  text: v,
                })
              }
              onDelete={() => onRemove(colKey, it, false)}
            />
            <button
              type="button"
              onClick={() => onRemove(colKey, it, true)}
              aria-label={t("weekly.deleteItem")}
              title={t("weekly.deleteItem")}
              className="opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100 [@media(hover:none)]:opacity-100 text-[#DC2626] h-6 w-6 mt-1 rounded-full flex items-center justify-center shrink-0 hover:bg-[#FEF2F2]"
            >
              <IconClose size={13} />
            </button>
          </div>
        ))}
      </div>
      <div className="flex gap-1 mt-2">
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.nativeEvent.isComposing) add();
          }}
          aria-label={t("weekly.addTo", { col: label })}
          placeholder={t(`weekly.ph.${colKey}`)}
          className="flex-1 min-w-0 h-8 rounded-full bg-[#F5F3EF] border border-[#E8E6E1] px-3 text-[12px] field"
        />
        <button
          type="button"
          onClick={add}
          disabled={!draft.trim()}
          aria-label={t("weekly.addItem")}
          title={t("weekly.addItem")}
          className="h-8 w-8 rounded-full bg-[#0A1931] text-[#C9A96E] text-[13px] font-semibold shrink-0 disabled:opacity-40 disabled:cursor-not-allowed"
        >
          +
        </button>
      </div>
    </div>
  );
}

// Follows teammates' edits live, except while this person is typing in it.
// Enter saves (Shift+Enter is a new line), Escape puts the saved text back.
// With `onDelete`, emptying the item deletes it (the caller offers undo);
// without it, an emptied item just shows its saved text again.
export function WeeklyItemField({
  text,
  onSave,
  onDelete,
  className,
  ariaLabel,
  title,
}: {
  text: string;
  onSave: (text: string) => void;
  onDelete?: () => void;
  className?: string;
  ariaLabel?: string;
  title?: string;
}) {
  const f = useSyncedField(text);
  const valueRef = useRef(f.value);
  valueRef.current = f.value;
  const textRef = useRef(text);
  textRef.current = text;
  const saveRef = useRef(onSave);
  saveRef.current = onSave;
  const focusedRef = f.focusedRef;

  // Leaving the page while typing (Back button, tab switch) never blurs the
  // field, so save what was typed when it unmounts.
  useEffect(
    () => () => {
      if (!focusedRef.current) return;
      const v = valueRef.current.trim();
      if (v && v !== textRef.current) saveRef.current(v);
    },
    [focusedRef],
  );

  return (
    <AutoTextarea
      value={f.value}
      aria-label={ariaLabel}
      title={title}
      onChange={(e) => f.setValue(e.target.value)}
      onFocus={f.onFocus}
      onKeyDown={(e) => {
        if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
          e.preventDefault();
          e.currentTarget.blur();
        } else if (e.key === "Escape") {
          e.stopPropagation();
          valueRef.current = text;
          f.setValue(text);
          e.currentTarget.blur();
        }
      }}
      onBlur={() => {
        f.onBlur();
        const v = valueRef.current.trim();
        if (v && v !== text) onSave(v);
        else if (!v && onDelete) onDelete();
        else f.setValue(text); // unchanged (or emptied with no delete): show the saved text
      }}
      className={
        className ??
        "flex-1 min-w-0 text-[12px] text-[#0A1931] bg-[#F5F3EF] rounded-lg border border-[#E8E6E1] p-2 field"
      }
    />
  );
}
