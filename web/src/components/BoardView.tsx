import { useCallback, useMemo, useRef, useState } from "react";
import { boardTasks } from "../lib/projects";
import type { Board, Op, Priority, Status, Task } from "../lib/types";
import { STATUS_ORDER, PRIORITY_ORDER, isArchived } from "../lib/constants";
import { priorityLabel, statusLabel, useT } from "../lib/i18n";
import { TaskCard } from "./TaskCard";
import { isOwnedBy } from "../lib/owners";
import { QuickAdd } from "./QuickAdd";
import { MembersBar } from "./MembersBar";
import { PriorityDistribution } from "./PriorityDistribution";
import { ListView } from "./ListView";
import { MenuBar } from "./MenuBar";
import { StarIcon } from "./RecurrenceControls";
import {
  readHidden,
  writeHidden,
  readViewMode,
  writeViewMode,
  readWeights,
  writeWeights,
  readPinBandOpen,
  writePinBandOpen,
  type ViewMode,
} from "../lib/prefs";
import type { FilterState } from "./Filters";

interface Props {
  board: Board;
  members: string[];
  send: (op: Op) => void;
  filters: FilterState;
  setFilters: React.Dispatch<React.SetStateAction<FilterState>>;
}

const PRIOS: Priority[] = ["P1", "P2", "P3", "P4"];
const MIN_WEIGHT = 0.4;
const EMPTY_FILTERS: FilterState = { search: "", owner: "all", priority: "all", focusP1: false };

// Small decorative toolbar icons (the buttons carry their own text).
const ICON = {
  width: 14,
  height: 14,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 2,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  "aria-hidden": true,
};
function IconUsers() {
  return (
    <svg {...ICON}>
      <circle cx="9" cy="8" r="3.5" />
      <path d="M2.5 20a6.5 6.5 0 0 1 13 0" />
      <path d="M16 4.6a3.5 3.5 0 0 1 0 6.8M18 14.5a6.5 6.5 0 0 1 3.5 5.5" />
    </svg>
  );
}
function IconEye({ off }: { off: boolean }) {
  return (
    <svg {...ICON}>
      <path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z" />
      <circle cx="12" cy="12" r="3" />
      {off && <path d="M3 3l18 18" />}
    </svg>
  );
}
function IconColumns() {
  return (
    <svg {...ICON}>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M9 4v16M15 4v16" />
    </svg>
  );
}

export function BoardView({ board, members, send, filters, setFilters }: Props) {
  const { t, lang } = useT();
  const [hidden, setHidden] = useState<Set<string>>(() => new Set(readHidden()));
  const [editorOpen, setEditorOpen] = useState(false);
  const [teamOpen, setTeamOpen] = useState(false);
  const [archOpen, setArchOpen] = useState(false);
  const [archQuery, setArchQuery] = useState("");
  const [doneOpen, setDoneOpen] = useState(false);
  const [doneQuery, setDoneQuery] = useState("");
  const [view, setView] = useState<ViewMode>(() => readViewMode());
  const [editLayout, setEditLayout] = useState(false);
  // Screenshot helper: hide owner names on the board. Deliberately NOT stored
  // in prefs — names are always back on next time the board loads.
  const [showNames, setShowNames] = useState(true);
  const [weights, setWeights] = useState<Record<string, number>>(() => readWeights());
  const [dragId, setDragId] = useState<string | null>(null);
  const [overCol, setOverCol] = useState<Status | null>(null);
  const [overBand, setOverBand] = useState(false);
  const [bandOpen, setBandOpen] = useState(readPinBandOpen);
  // Open cards per column: a column holding an open card grows so its editor
  // is not squeezed into a narrow strip.
  const [openCards, setOpenCards] = useState<Record<string, Status>>({});
  const setCardOpen = (id: string, status: Status, open: boolean) =>
    setOpenCards((prev) => {
      const next = { ...prev };
      if (open) next[id] = status;
      else delete next[id];
      return next;
    });

  const weightsRef = useRef(weights);
  weightsRef.current = weights;
  const containerRef = useRef<HTMLDivElement>(null);
  const drag = useRef<{
    left: Status;
    right: Status;
    startX: number;
    lwStart: number;
    rwStart: number;
    total: number;
    avail: number;
  } | null>(null);
  const pending = useRef<Record<string, number> | null>(null);

  const setViewPref = (v: ViewMode) => {
    setView(v);
    writeViewMode(v);
  };
  const toggleHidden = (s: Status) => {
    setHidden((prev) => {
      const next = new Set(prev);
      next.has(s) ? next.delete(s) : next.add(s);
      writeHidden([...next]);
      return next;
    });
  };
  const getW = (s: string) => weightsRef.current[s] ?? 1;

  // Project tasks kept off the board (project only, or later steps of a
  // sequential project) are left out of everything on this tab.
  const shown = useMemo(() => boardTasks(board), [board]);

  // Filter + priority-sort. passes() is also asked about a just-added task.
  const q = filters.search.trim().toLowerCase();
  const passes = (tk: Task) => {
    const text = !q || tk.title.toLowerCase().includes(q) || tk.desc.toLowerCase().includes(q);
    const owner = filters.owner === "all" || isOwnedBy(tk, filters.owner);
    const prio = filters.priority === "all" || tk.priority === filters.priority;
    const focus = !filters.focusP1 || tk.priority === "P1";
    return text && owner && prio && focus;
  };
  const tasks: Task[] = shown
    .filter(passes)
    .sort((a, b) => PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority]);

  const visibleCols = STATUS_ORDER.filter((s) => !hidden.has(s));
  const listTasks = tasks.filter((tk) => !hidden.has(tk.status));
  // Archive is self-contained: the whole archive (ignoring the board filters
  // above) with its own search box.
  const archivedAll = shown.filter((tk) => isArchived(tk));
  const aq = archQuery.trim().toLowerCase();
  const archivedShown = aq
    ? archivedAll.filter(
        (tk) => tk.title.toLowerCase().includes(aq) || tk.desc.toLowerCase().includes(aq)
      )
    : archivedAll;

  // Done bar mirrors the DONE column (this week's completed) as a full-width
  // section with its own search, sitting above the Archived bar.
  const doneWeekAll = shown.filter((tk) => tk.status === "DONE" && !isArchived(tk));
  const dq = doneQuery.trim().toLowerCase();
  const doneShown = dq
    ? doneWeekAll.filter(
        (tk) => tk.title.toLowerCase().includes(dq) || tk.desc.toLowerCase().includes(dq)
      )
    : doneWeekAll;

  // "In evidenza": highlighted tasks still to do, with the board's filters.
  // They stay in their column too (like the Done bar, a second view).
  const byDue = (a: Task, b: Task) =>
    (a.dueDate ?? "9999").localeCompare(b.dueDate ?? "9999") ||
    PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority];
  const pinned = tasks.filter((tk) => tk.pinned && tk.status !== "DONE").sort(byDue);
  const pinnedRecurring = pinned.filter((tk) => tk.recurrence);
  const pinnedOther = pinned.filter((tk) => !tk.recurrence);
  const dropOnBand = () => {
    if (dragId) send({ type: "updateTask", id: dragId, patch: { pinned: true } });
    setDragId(null);
    setOverBand(false);
  };

  const drop = (status: Status) => {
    if (dragId) send({ type: "moveTask", id: dragId, status });
    setDragId(null);
    setOverCol(null);
  };

  // ---- Column resize (edit mode) --------------------------------------------
  // Convert the cumulative pixel drag into a weight delta using the widths at
  // drag START (never the already-moved weights), so the boundary tracks the
  // cursor 1:1 instead of compounding.
  const onMove = useCallback((e: PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const sum = d.lwStart + d.rwStart; // conserved between the two columns
    // pixels-per-weight for these two columns at their combined width
    const combinedPx = (sum / d.total) * d.avail;
    let dw = combinedPx > 0 ? ((e.clientX - d.startX) / combinedPx) * sum : 0;
    // clamp so neither column drops below the minimum weight
    dw = Math.max(-(d.lwStart - MIN_WEIGHT), Math.min(d.rwStart - MIN_WEIGHT, dw));
    const next = { ...weightsRef.current, [d.left]: d.lwStart + dw, [d.right]: d.rwStart - dw };
    pending.current = next;
    setWeights(next);
  }, []);
  const onUp = useCallback(() => {
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
    if (pending.current) writeWeights(pending.current);
    drag.current = null;
  }, [onMove]);
  const startResize = (e: React.PointerEvent, left: Status, right: Status) => {
    e.preventDefault();
    e.stopPropagation();
    const width = containerRef.current?.clientWidth ?? 1;
    const gaps = Math.max(0, visibleCols.length - 1) * 12; // gap-3 between columns
    const avail = Math.max(1, width - gaps);
    const total = visibleCols.reduce((s, st) => s + getW(st), 0);
    drag.current = {
      left,
      right,
      startX: e.clientX,
      lwStart: getW(left),
      rwStart: getW(right),
      total,
      avail,
    };
    pending.current = { ...weightsRef.current };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };
  const resetWidths = () => {
    setWeights({});
    writeWeights({});
  };

  const filtersActive = q || filters.owner !== "all" || filters.priority !== "all" || filters.focusP1;
  const resetFilters = () => setFilters(EMPTY_FILTERS);
  // Nothing on the board (visible columns, not archived) passes the filters.
  const noMatch =
    !!filtersActive && tasks.filter((tk) => !hidden.has(tk.status) && !isArchived(tk)).length === 0;

  // New-task bar: will the task just added be seen, and how to reveal it.
  const quickVisibility = (tk: Task) => ({ filtered: !passes(tk), column: hidden.has(tk.status) });
  const quickReveal = (tk: Task) => {
    if (!passes(tk)) resetFilters();
    if (hidden.has(tk.status)) toggleHidden(tk.status);
  };
  const control = "h-9 rounded-full bg-white border border-[#E8E6E1] text-[13px] field";

  return (
    <div className="space-y-4">
      {/* Toolbar */}
      <div role="search" aria-label={t("filters.section")} className="bg-white rounded-[14px] border border-[#E8E6E1] p-3">
        <div className="flex flex-wrap items-center gap-2">
          {/* Board / List toggle */}
          <div
            role="group"
            aria-label={t("ux.board.viewToggle")}
            className="seg"
          >
            {(["board", "list"] as ViewMode[]).map((v) => (
              <button
                key={v}
                type="button"
                aria-pressed={view === v}
                onClick={() => setViewPref(v)}
                className="tab h-8 px-3 text-[11px] font-semibold"
              >
                {t(`view.${v}`)}
              </button>
            ))}
          </div>

          <div className="relative flex-1 min-w-[160px]">
            <span aria-hidden="true" className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-3 text-[13px]">⌕</span>
            <input
              value={filters.search}
              onChange={(e) => setFilters((f) => ({ ...f, search: e.target.value }))}
              placeholder={t("filters.search")}
              aria-label={t("filters.search")}
              className={`${control} w-full pl-8 pr-4`}
            />
          </div>
          <select value={filters.owner} onChange={(e) => setFilters((f) => ({ ...f, owner: e.target.value }))} aria-label={t("quick.owner")} className={`${control} px-3`}>
            <option value="all">{t("filters.allMembers")}</option>
            <option value="Unassigned">{t("members.unassigned")}</option>
            {members.map((m) => (
              <option key={m} value={m}>{m}</option>
            ))}
          </select>
          <select value={filters.priority} onChange={(e) => setFilters((f) => ({ ...f, priority: e.target.value }))} aria-label={t("quick.priority")} className={`${control} px-3`}>
            <option value="all">{t("filters.allPriorities")}</option>
            {PRIOS.map((p) => (
              <option key={p} value={p}>{priorityLabel(t, p)}</option>
            ))}
          </select>
          <button
            type="button"
            aria-pressed={filters.focusP1}
            onClick={() => setFilters((f) => ({ ...f, focusP1: !f.focusP1 }))}
            className={`h-9 px-4 rounded-full text-[12px] font-semibold border transition-colors ${
              filters.focusP1 ? "bg-[#DC2626] text-white border-[#DC2626]" : "bg-[#FEF2F2] text-[#C81E1E] border-[#FECACA]"
            }`}
          >
            {t("filters.focusP1")}
          </button>
          {filtersActive && (
            <button
              type="button"
              onClick={resetFilters}
              className="h-9 px-4 rounded-full text-[12px] font-semibold bg-white text-[#6B6B6B] border border-[#E8E6E1]"
            >
              {t("ux.board.resetFilters")}
            </button>
          )}

          <div className="ml-auto flex items-center gap-2">
            <button
              type="button"
              aria-expanded={teamOpen}
              aria-controls={teamOpen ? "board-team-panel" : undefined}
              onClick={() => setTeamOpen((o) => !o)}
              className="tab h-9 px-4 text-[12px] font-semibold gap-1.5"
            >
              <IconUsers /> {t("team.button")}
              <span className="tab__count">{board.members.length}</span>
            </button>
            {view === "board" && (
              <button
                type="button"
                aria-pressed={editLayout}
                onClick={() => setEditLayout((e) => !e)}
                className="tab h-9 px-4 text-[12px] font-semibold"
              >
                {editLayout ? t("view.editLayoutOn") : t("view.editLayout")}
              </button>
            )}
            <button
              type="button"
              // Pressed = names hidden: the button's job is to hide them.
              aria-pressed={!showNames}
              onClick={() => setShowNames((v) => !v)}
              title={t("view.namesHint")}
              className="tab h-9 px-4 text-[12px] font-semibold gap-1.5"
            >
              <IconEye off={!showNames} /> {t(showNames ? "view.names" : "view.namesHidden")}
            </button>
            <button
              type="button"
              aria-expanded={editorOpen}
              aria-controls={editorOpen ? "board-columns-panel" : undefined}
              onClick={() => setEditorOpen((o) => !o)}
              className="tab h-9 px-4 text-[12px] font-semibold gap-1.5"
            >
              <IconColumns /> {t("view.columns")}
              {hidden.size > 0 && (
                <span className="tab__count">
                  {visibleCols.length}/{STATUS_ORDER.length}
                </span>
              )}
            </button>
          </div>
        </div>

        {editorOpen && (
          <div id="board-columns-panel" className="mt-3 pt-3 border-t border-[#E8E6E1]">
            <div className="text-[10px] uppercase tracking-widest text-[#6B6B6B] mb-2">{t("view.columnsHint")}</div>
            <div role="group" aria-label={t("ux.board.columnsPanel")} className="flex flex-wrap gap-2">
              {STATUS_ORDER.map((s) => {
                const shown = !hidden.has(s);
                return (
                  <button
                    key={s}
                    type="button"
                    aria-pressed={shown}
                    onClick={() => toggleHidden(s)}
                    className={`h-8 px-3 rounded-full text-[12px] font-semibold border inline-flex items-center gap-1.5 transition-colors ${
                      shown ? "bg-[#0A1931] text-[#C9A96E] border-[#0A1931]" : "bg-white text-ink-3 border-[#E8E6E1] line-through"
                    }`}
                  >
                    <span aria-hidden="true">{shown ? "◉" : "◯"}</span>
                    {statusLabel(lang, s)}
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {editLayout && view === "board" && (
          <div className="mt-3 pt-3 border-t border-[#E8E6E1] flex items-center justify-between gap-2 flex-wrap">
            <span className="text-[11px] text-[#7A5F30]">{t("view.editHint")}</span>
            <button onClick={resetWidths} className="h-8 px-3 rounded-full text-[11px] font-semibold bg-white text-[#6B6B6B] border border-[#E8E6E1]">
              {t("view.resetWidths")}
            </button>
          </div>
        )}
      </div>

      {/* Team panel (collapsed by default to declutter the top) */}
      {teamOpen && (
        <div id="board-team-panel" className="bg-white rounded-[14px] border border-[#E8E6E1] p-3">
          <MembersBar board={board} send={send} />
        </div>
      )}

      {/* New-task row — visually distinct from the search/filter row above */}
      <div role="group" aria-label={t("quick.section")} className="rounded-[14px] border border-[#E8E6E1] bg-white p-3">
        <QuickAdd
          members={members}
          send={send}
          showNames={showNames}
          multiAssign={board.assigneesAvailable !== false}
          visibility={quickVisibility}
          onReveal={quickReveal}
        />
      </div>

      {/* Priority distribution — its own space */}
      <PriorityDistribution tasks={shown} />

      {noMatch && (
        <div
          role="status"
          className="flex flex-wrap items-center gap-2 rounded-[14px] border border-[#FDE68A] bg-[#FEF3C7] px-4 py-2.5 text-[13px] text-[#92400E]"
        >
          <span className="font-semibold">{t("ux.board.noMatch")}</span>
          <button
            type="button"
            onClick={resetFilters}
            className="h-8 px-3 rounded-full text-[12px] font-semibold bg-white text-[#0A1931] border border-[#E8E6E1]"
          >
            {t("ux.board.resetFilters")}
          </button>
        </div>
      )}

      {/* In evidenza — highlighted tasks and recurring tasks, above the columns. */}
      {board.recurringAvailable && (
        <section
          aria-label={t("pin.band")}
          onDragEnter={(e) => {
            if (dragId) {
              e.preventDefault();
              setOverBand(true);
            }
          }}
          onDragOver={(e) => {
            if (!dragId) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = "move";
            if (!overBand) setOverBand(true);
          }}
          onDragLeave={(e) => {
            if (!e.currentTarget.contains(e.relatedTarget as Node)) setOverBand(false);
          }}
          onDrop={(e) => {
            e.preventDefault();
            dropOnBand();
          }}
          className={`pin-band rounded-[14px] p-3 transition-colors ${overBand ? "drop-target" : ""}`}
        >
          <div className="flex items-center gap-2">
            <button
              type="button"
              aria-expanded={bandOpen}
              onClick={() =>
                setBandOpen((o) => {
                  writePinBandOpen(!o);
                  return !o;
                })
              }
              className="flex items-center gap-2 text-left min-w-0"
            >
              <span aria-hidden="true" className={`text-[#7A5F30] text-[11px] transition-transform ${bandOpen ? "rotate-90" : ""}`}>▶</span>
              <span className="text-[#C9A96E]"><StarIcon on size={15} /></span>
              <span className="font-trajan text-[12px] uppercase tracking-widest text-[#7A5F30]">{t("pin.band")}</span>
              <span className="text-[11px] font-semibold text-[#7A5F30] bg-white rounded-full px-2 py-0.5 border border-[#E8D6AE]">
                {pinned.length}
              </span>
            </button>
            <span className="text-[10px] text-[#7A5F30] ml-1 hidden md:inline truncate">
              {overBand ? t("pin.drop") : t("pin.bandHint")}
            </span>
          </div>
          {bandOpen &&
            (pinned.length === 0 ? (
              <p className="mt-2 text-[12px] text-[#7A5F30]">{overBand ? t("pin.drop") : t("pin.empty")}</p>
            ) : (
              // Groups side by side (recurring first), so a few highlighted
              // tasks take one row, not a row per group.
              <div className="mt-2 flex flex-wrap gap-x-4 gap-y-3">
                {[
                  { key: "recurring", label: t("pin.recurring"), list: pinnedRecurring },
                  { key: "tasks", label: t("pin.tasks"), list: pinnedOther },
                ]
                  .filter((g) => g.list.length > 0)
                  .map((g, _i, groups) => (
                    <div key={g.key} className="min-w-0 flex-1 basis-[260px]">
                      {groups.length > 1 && (
                        <div className="text-[10px] uppercase tracking-widest text-[#7A5F30] mb-1.5 px-0.5">
                          {g.label} · {g.list.length}
                        </div>
                      )}
                      <div className="grid grid-cols-[repeat(auto-fill,minmax(240px,1fr))] gap-2 items-start">
                        {g.list.map((tk) => (
                          <TaskCard
                            multiAssign={board.assigneesAvailable !== false}
                            key={tk.id}
                            task={tk}
                            members={members}
                            send={send}
                            showNames={showNames}
                            draggable={!editLayout}
                            showStatus
                            onDragStart={(e) => {
                              setDragId(tk.id);
                              e.dataTransfer.setData("text/plain", tk.id);
                              e.dataTransfer.effectAllowed = "move";
                              (e.currentTarget as HTMLElement).classList.add("dragging");
                            }}
                            onDragEnd={(e) => {
                              (e.currentTarget as HTMLElement).classList.remove("dragging");
                              setDragId(null);
                              setOverCol(null);
                              setOverBand(false);
                            }}
                          />
                        ))}
                      </div>
                    </div>
                  ))}
              </div>
            ))}
        </section>
      )}

      {view === "list" ? (
        <ListView
          tasks={listTasks}
          members={members}
          send={send}
          showNames={showNames}
          multiAssign={board.assigneesAvailable !== false}
        />
      ) : (
        <>
          <div
            ref={containerRef}
            onDragLeave={(e) => {
              // Clear the highlight only when the cursor actually leaves the board.
              if (!e.currentTarget.contains(e.relatedTarget as Node)) setOverCol(null);
            }}
            className="flex flex-wrap gap-3 items-start"
          >
            {visibleCols.map((status, i) => {
              const colTasks = tasks.filter((tk) => tk.status === status && !isArchived(tk));
              const isLast = i === visibleCols.length - 1;
              // Only cards still in this column count (one may have moved or gone).
              const hasOpen = colTasks.some((tk) => openCards[tk.id] === status);
              return (
                <div
                  key={status}
                  onDragEnter={(e) => {
                    if (dragId) {
                      e.preventDefault();
                      setOverCol(status);
                    }
                  }}
                  onDragOver={(e) => {
                    if (!dragId) return;
                    e.preventDefault();
                    e.dataTransfer.dropEffect = "move";
                    if (overCol !== status) setOverCol(status);
                  }}
                  onDrop={(e) => {
                    e.preventDefault();
                    drop(status);
                  }}
                  style={{ flexGrow: getW(status), flexShrink: 1, flexBasis: 0, minWidth: hasOpen ? 340 : 148, minHeight: 140 }}
                  className={`relative rounded-[14px] p-2 transition-colors ${
                    overCol === status ? "drop-target" : "bg-[#EFECE6]"
                  } ${editLayout ? "ring-1 ring-[#C9A96E]/40" : ""}`}
                >
                  <div className="flex items-center justify-between px-2 py-2 gap-2">
                    <div className="min-w-0">
                      <div className="font-trajan text-[12px] uppercase tracking-wide text-[#0A1931]">
                        {statusLabel(lang, status)}
                      </div>
                      <div className="text-[10px] text-[#6B6B6B] truncate">{t(`status.${status}.help`)}</div>
                    </div>
                    <span className="shrink-0 text-[11px] font-semibold text-[#6B6B6B] bg-white rounded-full px-2 py-0.5 border border-[#E8E6E1]">
                      {colTasks.length}
                    </span>
                  </div>

                  <div className="space-y-2">
                    {colTasks.map((tk) => (
                      <TaskCard
                        multiAssign={board.assigneesAvailable !== false}
                        key={tk.id}
                        task={tk}
                        members={members}
                        send={send}
                        showNames={showNames}
                        draggable={!editLayout}
                        onOpenChange={(o) => setCardOpen(tk.id, status, o)}
                        onDragStart={(e) => {
                          setDragId(tk.id);
                          e.dataTransfer.setData("text/plain", tk.id);
                          e.dataTransfer.effectAllowed = "move";
                          (e.currentTarget as HTMLElement).classList.add("dragging");
                        }}
                        onDragEnd={(e) => {
                          (e.currentTarget as HTMLElement).classList.remove("dragging");
                          setDragId(null);
                          setOverCol(null);
                        }}
                      />
                    ))}
                    {colTasks.length === 0 && (
                      <div className="text-[11px] text-ink-3 text-center py-6">
                        {status === "DONE" ? t("col.emptyDone") : t("col.empty")}
                      </div>
                    )}
                  </div>

                  {/* Resize handle (edit mode, between this column and the next) */}
                  {editLayout && !isLast && (
                    <div
                      onPointerDown={(e) => startResize(e, status, visibleCols[i + 1])}
                      title={t("view.editLayout")}
                      className="absolute top-0 right-[-8px] h-full w-4 flex items-center justify-center cursor-col-resize z-10"
                    >
                      <div className="w-1.5 h-12 rounded-full bg-[#C9A96E]" />
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {/* Done — this week's completed DONE tasks, mirroring the DONE column
              as a full-width searchable bar (a duplicate view, not a move). */}
          <div className="bg-[#EFECE6] rounded-[14px] border border-[#E3DFD7] p-3">
            <button
              type="button"
              aria-expanded={doneOpen}
              aria-controls={doneOpen ? "board-done-panel" : undefined}
              onClick={() => setDoneOpen((o) => !o)}
              className="w-full flex items-center gap-2 text-left"
            >
              <span aria-hidden="true" className={`text-[#6B6B6B] text-[11px] transition-transform ${doneOpen ? "rotate-90" : ""}`}>▶</span>
              <span className="font-trajan text-[11px] uppercase tracking-widest text-[#6B6B6B]">
                {t("doneBar.title")}
              </span>
              <span className="text-[11px] font-semibold text-[#6B6B6B] bg-white rounded-full px-2 py-0.5 border border-[#E8E6E1]">
                {doneWeekAll.length}
              </span>
              <span className="text-[10px] text-ink-3 ml-1 hidden sm:inline">{t("doneBar.hint")}</span>
            </button>
            {doneOpen && (
              <div id="board-done-panel" className="mt-3 space-y-3">
                <div className="relative max-w-[320px]">
                  <span className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-3 text-[13px]">⌕</span>
                  <input
                    value={doneQuery}
                    onChange={(e) => setDoneQuery(e.target.value)}
                    placeholder={t("doneBar.search")}
                    aria-label={t("doneBar.search")}
                    className="w-full h-9 rounded-full bg-white border border-[#E8E6E1] pl-8 pr-4 text-[13px] field"
                  />
                </div>
                {doneShown.length === 0 ? (
                  <div className="text-[12px] text-ink-3 py-2">{t("doneBar.none")}</div>
                ) : (
                  <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-2">
                    {doneShown.map((tk) => (
                      <TaskCard
                        multiAssign={board.assigneesAvailable !== false}
                        key={tk.id}
                        task={tk}
                        members={members}
                        send={send}
                        showNames={showNames}
                        draggable={!editLayout}
                        showStatus
                        onDragStart={(e) => {
                          setDragId(tk.id);
                          e.dataTransfer.setData("text/plain", tk.id);
                          e.dataTransfer.effectAllowed = "move";
                          (e.currentTarget as HTMLElement).classList.add("dragging");
                        }}
                        onDragEnd={(e) => {
                          (e.currentTarget as HTMLElement).classList.remove("dragging");
                          setDragId(null);
                          setOverCol(null);
                        }}
                      />
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Archived — DONE tasks completed more than a week ago (always shown) */}
          <div className="bg-[#EFECE6] rounded-[14px] border border-[#E3DFD7] p-3">
            <button
              type="button"
              aria-expanded={archOpen}
              aria-controls={archOpen ? "board-archive-panel" : undefined}
              onClick={() => setArchOpen((o) => !o)}
              className="w-full flex items-center gap-2 text-left"
            >
              <span aria-hidden="true" className={`text-[#6B6B6B] text-[11px] transition-transform ${archOpen ? "rotate-90" : ""}`}>▶</span>
              <span className="font-trajan text-[11px] uppercase tracking-widest text-[#6B6B6B]">
                {t("archived.title")}
              </span>
              <span className="text-[11px] font-semibold text-[#6B6B6B] bg-white rounded-full px-2 py-0.5 border border-[#E8E6E1]">
                {archivedAll.length}
              </span>
              <span className="text-[10px] text-ink-3 ml-1 hidden sm:inline">{t("archived.hint")}</span>
            </button>
            {archOpen && (
              <div id="board-archive-panel" className="mt-3 space-y-3">
                <div className="relative max-w-[320px]">
                  <span className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-3 text-[13px]">⌕</span>
                  <input
                    value={archQuery}
                    onChange={(e) => setArchQuery(e.target.value)}
                    placeholder={t("archived.search")}
                    aria-label={t("archived.search")}
                    className="w-full h-9 rounded-full bg-white border border-[#E8E6E1] pl-8 pr-4 text-[13px] field"
                  />
                </div>
                {archivedShown.length === 0 ? (
                  <div className="text-[12px] text-ink-3 py-2">{t("archived.none")}</div>
                ) : (
                  <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-2">
                    {archivedShown.map((tk) => (
                      <TaskCard
                        multiAssign={board.assigneesAvailable !== false}
                        key={tk.id}
                        task={tk}
                        members={members}
                        send={send}
                        showNames={showNames}
                        draggable={!editLayout}
                        showStatus
                        onDragStart={(e) => {
                          setDragId(tk.id);
                          e.dataTransfer.setData("text/plain", tk.id);
                          e.dataTransfer.effectAllowed = "move";
                          (e.currentTarget as HTMLElement).classList.add("dragging");
                        }}
                        onDragEnd={(e) => {
                          (e.currentTarget as HTMLElement).classList.remove("dragging");
                          setDragId(null);
                          setOverCol(null);
                        }}
                      />
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>

          {/* The canteen menu — today and the next days (lib/menu.ts) */}
          <MenuBar />
        </>
      )}

      {/* Undo for deletes, "done" checks and member removal. */}
    </div>
  );
}
