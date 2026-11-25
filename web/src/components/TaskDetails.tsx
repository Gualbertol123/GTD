import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import type { Op, Priority, Status, Task } from "../lib/types";
import { STATUS_ORDER, UNASSIGNED, genId } from "../lib/constants";
import { ownerInitial, ownersLabel, ownersPatch, taskOwners } from "../lib/owners";
import { priorityLabel, statusLabel, useT } from "../lib/i18n";
import { useSyncedField } from "../lib/useSyncedField";
import { daysSince } from "../lib/dates";
import { useProjects } from "../lib/projectsContext";
import { projectColor } from "../lib/projects";
import { AutoTextarea } from "./AutoTextarea";
import { SortableSubtasks } from "./SortableSubtasks";
import { RecurrenceControls } from "./RecurrenceControls";

const PRIOS: Priority[] = ["P1", "P2", "P3", "P4"];

interface Props {
  task: Task;
  members: string[];
  send: (op: Op) => void;
  showNames?: boolean; // false hides the owner name (screenshot mode)
  /** False before migration 009: a task can still only be held by one person. */
  multiAssign?: boolean;
  /** Called after the task is deleted; it gets the deleted task (for an undo). */
  onDeleted?: (task: Task) => void;
}

// ---- Undo toast -------------------------------------------------------------
// One small store shared by every surface (task delete, subtask delete, mark
// done, member removal, a deleted project, Weekly items and Clear). It lives outside any card, so
// the toast survives the card that raised it unmounting. The host is mounted
// once, at the App root; an extra host would stay silent.
interface UndoToast {
  id: number;
  text: string;
  onUndo: () => void;
  ms: number;
  /** Move keyboard focus to Annulla (the delete was done from the keyboard). */
  focus?: boolean;
}
let toastNow: UndoToast | null = null;
let toastSeq = 0;
const toastListeners = new Set<() => void>();
const toastHosts: number[] = [];
const emitToast = () => toastListeners.forEach((l) => l());
const subscribeToast = (l: () => void) => {
  toastListeners.add(l);
  return () => {
    toastListeners.delete(l);
  };
};

/** Shows "text · Annulla" for a few seconds (longer while the pointer or
 *  focus is on it); Annulla runs onUndo. */
export function showUndo(text: string, onUndo: () => void, ms = 6000, opts: { focus?: boolean } = {}) {
  toastNow = { id: ++toastSeq, text, onUndo, ms, focus: opts.focus };
  emitToast();
}
function clearToast(id: number) {
  if (toastNow?.id === id) {
    toastNow = null;
    emitToast();
  }
}

/** Mounted once, at the App root (App.tsx); extra hosts stay silent. */
export function UndoToastHost() {
  const { t } = useT();
  const [hostId] = useState(() => ++toastSeq);
  const [, force] = useState(0);
  useEffect(() => {
    toastHosts.push(hostId);
    emitToast();
    return () => {
      const i = toastHosts.indexOf(hostId);
      if (i >= 0) toastHosts.splice(i, 1);
      emitToast();
    };
  }, [hostId]);
  const toast = useSyncExternalStore(subscribeToast, () => toastNow);
  useEffect(() => subscribeToast(() => force((n) => n + 1)), []);
  // It stays while the pointer or keyboard focus is on it (time to read and
  // reach Annulla), then its time starts again.
  const [hold, setHold] = useState(false);
  const undoRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!toast || hold) return;
    const h = window.setTimeout(() => clearToast(toast.id), toast.ms);
    return () => window.clearTimeout(h);
  }, [toast, hold]);
  useEffect(() => {
    if (toast?.focus) undoRef.current?.focus();
    if (!toast) setHold(false);
  }, [toast]);
  if (toastHosts[0] !== hostId || typeof document === "undefined") return null;
  return createPortal(
    <div
      role="status"
      aria-live="polite"
      className="fixed left-1/2 -translate-x-1/2 bottom-24 z-[60] pointer-events-none max-w-[calc(100vw-32px)]"
    >
      {toast && (
        <div
          onMouseEnter={() => setHold(true)}
          onMouseLeave={() => setHold(false)}
          onFocus={() => setHold(true)}
          onBlur={(e) => {
            if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setHold(false);
          }}
          className="pointer-events-auto flex items-center gap-3 rounded-full bg-[#1C1C1E] text-white shadow-xl pl-4 pr-1.5 py-1.5 text-[13px]"
        >
          <span className="min-w-0 truncate">{toast.text}</span>
          <button
            ref={undoRef}
            type="button"
            onClick={() => {
              toast.onUndo();
              clearToast(toast.id);
            }}
            className="shrink-0 h-8 px-3 rounded-full text-[12px] font-semibold text-[#E9C989] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#E9C989]"
          >
            {t("ux.board.undo")}
          </button>
          <button
            type="button"
            onClick={() => clearToast(toast.id)}
            aria-label={t("ux.board.dismiss")}
            className="shrink-0 h-8 w-8 rounded-full inline-flex items-center justify-center text-white/70 focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#E9C989]"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden="true">
              <path d="M6 6l12 12M18 6 6 18" />
            </svg>
          </button>
        </div>
      )}
    </div>,
    document.body
  );
}

// The full editable body for a task. Reused by the inline board card and the
// calendar side panel — no popups anywhere.
export function TaskDetails({
  task,
  members,
  send,
  showNames = true,
  multiAssign = true,
  onDeleted,
}: Props) {
  const { t, lang } = useT();
  const [confirmDel, setConfirmDel] = useState(false);
  const [newSub, setNewSub] = useState("");
  const [assignOpen, setAssignOpen] = useState(false);
  const { projects, available: projectsOn, recurring: recurringOn } = useProjects();
  const linked = task.projectId ? projects.find((p) => p.id === task.projectId) : undefined;

  const title = useSyncedField(task.title);
  const notes = useSyncedField(task.notes);
  const desc = useSyncedField(task.desc);
  const fileDir = useSyncedField(task.fileDir ?? "");
  const [copied, setCopied] = useState(false);
  const [titleHint, setTitleHint] = useState(false);
  const titleCancelled = useRef(false);
  const noRef = useRef<HTMLButtonElement>(null);
  const delRef = useRef<HTMLButtonElement>(null);
  const wasConfirming = useRef(false);
  useEffect(() => {
    // "No" gets the focus (never the destructive "Sì"); cancelling hands it
    // back to the Elimina button.
    if (confirmDel) noRef.current?.focus();
    else if (wasConfirming.current) delRef.current?.focus();
    wasConfirming.current = confirmDel;
  }, [confirmDel]);
  useEffect(() => {
    if (!titleHint) return;
    const h = window.setTimeout(() => setTitleHint(false), 3000);
    return () => window.clearTimeout(h);
  }, [titleHint]);

  const commitTitle = () => {
    if (titleCancelled.current) {
      titleCancelled.current = false;
      return;
    }
    const v = title.value.trim();
    if (!v) {
      // An empty title is never saved: bring the old one back and say why.
      title.setValue(task.title);
      setTitleHint(true);
      return;
    }
    if (v !== task.title) patch({ title: v });
  };

  const deleteTask = () => {
    const snapshot: Task = { ...task, subtasks: task.subtasks.map((s) => ({ ...s })) };
    send({ type: "deleteTask", id: task.id });
    onDeleted?.(snapshot);
    showUndo(t("ux.board.taskDeleted", { title: snapshot.title }), () =>
      send({ type: "addTask", task: snapshot })
    );
  };

  const deleteSub = (subtaskId: string) => {
    const sub = task.subtasks.find((s) => s.id === subtaskId);
    if (!sub) return;
    const order = task.subtasks.map((s) => s.id);
    const wasLast = order[order.length - 1] === subtaskId;
    send({ type: "deleteSubtask", taskId: task.id, subtaskId });
    // addSubtask appends at the end, so a reorder puts it back where it was.
    showUndo(t("ux.board.subtaskDeleted"), () => {
      send({ type: "addSubtask", taskId: task.id, subtask: { ...sub } });
      if (!wasLast) send({ type: "reorderSubtasks", taskId: task.id, ids: order });
    });
  };

  const copyFileDir = async () => {
    if (!fileDir.value) return;
    try {
      await navigator.clipboard.writeText(fileDir.value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked — ignore */
    }
  };

  const done = task.subtasks.filter((s) => s.done).length;
  const total = task.subtasks.length;
  const pct = total ? Math.round((done / total) * 100) : 0;

  const patch = (p: Partial<Task>) => send({ type: "updateTask", id: task.id, patch: p });
  const idx = STATUS_ORDER.indexOf(task.status);
  const move = (dir: -1 | 1) => {
    const next = STATUS_ORDER[idx + dir];
    if (next) send({ type: "moveTask", id: task.id, status: next });
  };
  const owners = taskOwners(task);
  const memberLabel = (name: string) => (name === UNASSIGNED ? t("members.unassigned") : name);

  // Picking a name adds it when the task can be shared, and replaces the whole
  // assignment when it cannot. Taking the last name off leaves it unassigned.
  const toggleOwner = (name: string) => {
    if (!multiAssign || name === UNASSIGNED) {
      patch(ownersPatch([name]));
      return;
    }
    const next = owners.includes(name)
      ? owners.filter((o) => o !== name)
      : [...owners.filter((o) => o !== UNASSIGNED), name];
    patch(ownersPatch(next));
  };

  const addSub = () => {
    const v = newSub.trim();
    if (!v) return;
    send({ type: "addSubtask", taskId: task.id, subtask: { id: genId(), text: v, done: false } });
    setNewSub("");
  };

  return (
    <div className="space-y-3">
      <div>
        <AutoTextarea
          value={title.value}
          onFocus={title.onFocus}
          onChange={(e) => {
            title.setValue(e.target.value);
            if (titleHint) setTitleHint(false);
          }}
          onKeyDown={(e) => {
            // Enter saves (the title is one line); Escape reverts.
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              e.currentTarget.blur();
            } else if (e.key === "Escape") {
              e.preventDefault();
              titleCancelled.current = true;
              title.setValue(task.title);
              e.currentTarget.blur();
            }
          }}
          onBlur={() => {
            title.onBlur();
            commitTitle();
          }}
          aria-label={t("ux.board.taskTitle")}
          aria-describedby={titleHint ? `title-hint-${task.id}` : undefined}
          className="w-full font-semibold text-[14px] leading-snug text-[#0A1931] bg-[#F5F3EF] rounded-lg border border-transparent px-2 py-1.5 field"
        />
        {titleHint && (
          <p id={`title-hint-${task.id}`} role="status" className="mt-1 text-[11px] text-[#92400E]">
            {t("ux.board.titleEmpty")}
          </p>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => showNames && setAssignOpen((v) => !v)}
          aria-expanded={showNames ? assignOpen : undefined}
          title={showNames ? t("assign.edit") : undefined}
          className="inline-flex items-center gap-1.5 bg-[#F5F3EF] rounded-full pl-1 pr-2.5 h-8 border border-[#E8E6E1] text-[12px] text-[#0A1931] field"
        >
          <span className="flex -space-x-1.5">
            {(showNames ? owners.slice(0, 3) : ["•"]).map((name, i) => (
              <span
                key={`${name}-${i}`}
                className="w-6 h-6 rounded-full bg-[#0A1931] text-white text-[10px] font-bold flex items-center justify-center ring-2 ring-[#F5F3EF]"
              >
                {showNames ? ownerInitial(name) : "•"}
              </span>
            ))}
          </span>
          <span className={showNames ? "" : "text-ink-3"}>
            {showNames ? ownersLabel(task, memberLabel) : "—"}
          </span>
          {showNames && (
            <span className="text-[9px] text-[#6B6B6B]">{assignOpen ? "▾" : "▸"}</span>
          )}
        </button>

        <label className="inline-flex flex-wrap items-center gap-x-1.5 min-w-0 max-w-full bg-[#F5F3EF] rounded-full px-3 min-h-8 border border-[#E8E6E1] text-[12px] text-[#6B6B6B] field">
          {t("task.due")}
          <input
            type="date"
            value={task.dueDate ?? ""}
            onChange={(e) => send({ type: "setDueDate", id: task.id, dueDate: e.target.value || undefined })}
            className="min-w-0 max-w-full bg-transparent outline-none text-[12px] text-[#0A1931]"
          />
        </label>

        {projectsOn && projects.length > 0 && (
          <label className="inline-flex items-center gap-1.5 bg-[#F5F3EF] rounded-full pl-2.5 pr-1 h-8 border border-[#E8E6E1] text-[12px] text-[#6B6B6B] max-w-full field">
            <span
              className="w-2.5 h-2.5 rounded-full shrink-0"
              style={{ background: linked ? projectColor(linked) : "transparent", boxShadow: linked ? undefined : "inset 0 0 0 1px #C9C5BE" }}
            />
            <select
              value={linked ? linked.id : ""}
              onChange={(e) => patch({ projectId: e.target.value || undefined })}
              title={t("task.project")}
              className="bg-transparent outline-none text-[12px] text-[#0A1931] max-w-[180px] cursor-pointer"
            >
              <option value="">{t("task.noProject")}</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name || "—"}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>

      {showNames && assignOpen && (
        <div
          className="rounded-[12px] border border-[#E8E6E1] bg-[#F5F3EF] p-2.5 space-y-2"
          onKeyDown={(e) => {
            // Escape closes the picker first (the card stays open).
            if (e.key === "Escape") {
              e.preventDefault();
              setAssignOpen(false);
            }
          }}
        >
          <div className="flex items-baseline justify-between gap-2 flex-wrap">
            <span className="font-trajan text-[10px] uppercase tracking-wide text-ink-3">
              {t("assign.title")}
            </span>
            <span className="text-[10px] text-[#6B6B6B]">
              {t(multiAssign ? "assign.hintMulti" : "assign.hintSingle")}
            </span>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {[UNASSIGNED, ...members].map((m) => {
              const on = owners.includes(m);
              return (
                <button
                  key={m}
                  type="button"
                  onClick={() => toggleOwner(m)}
                  aria-pressed={on}
                  className="tab h-7 px-3 text-[11px]"
                >
                  {memberLabel(m)}
                </button>
              );
            })}
          </div>
          {!multiAssign && (
            <p className="text-[10px] text-[#C81E1E]">{t("assign.migrationNote")}</p>
          )}
        </div>
      )}

      <div className="flex items-center gap-1.5 flex-wrap">
        {PRIOS.map((p) => (
          <button
            key={p}
            onClick={() => patch({ priority: p })}
            title={priorityLabel(t, p)}
            className={`h-7 px-2.5 rounded-full text-[11px] font-semibold border transition-all ${
              task.priority === p
                ? p === "P1"
                  ? "bg-[#DC2626] text-white border-[#DC2626]"
                  : p === "P2"
                  ? "bg-[#C9A96E] text-[#0A1931] border-[#C9A96E]"
                  : p === "P3"
                  ? "bg-[#C9C5BE] text-[#0A1931] border-[#C9C5BE]"
                  : "bg-[#0A1931] text-white border-[#0A1931]"
                : "bg-white text-[#6B6B6B] border-[#E8E6E1]"
            }`}
          >
            {p}
          </button>
        ))}
        <span className="text-[11px] text-[#6B6B6B] ml-1">{t(`prio.${task.priority}short`)}</span>
      </div>

      <RecurrenceControls task={task} send={send} available={!!recurringOn} />

      {task.status === "WAITING" && task.waitingSince && (
        <div className="text-[11px] text-[#92400E]">
          {t("task.waiting")} · {daysSince(task.waitingSince)} {t("task.days")}
        </div>
      )}

      {/* Subtasks — styled like a small kanban column */}
      <div className="bg-[#EFECE6] rounded-[12px] border border-transparent p-2.5">
        <div className="flex items-center justify-between mb-2 px-1">
          <span className="font-trajan text-[10px] uppercase tracking-wide text-[#6B6B6B]">
            {t("task.subtasks")} {total ? `${done}/${total} · ${pct}%` : ""}
          </span>
        </div>
        {total > 0 && (
          <div className="h-1.5 rounded-full bg-[#DED9D0] overflow-hidden mb-2.5 mx-0.5">
            <div className="h-full bg-[#C9A96E] transition-all" style={{ width: `${pct}%` }} />
          </div>
        )}
        <SortableSubtasks
          items={task.subtasks}
          onReorder={(subtasks) => send({ type: "reorderSubtasks", taskId: task.id, ids: subtasks.map((s) => s.id) })}
          onToggle={(subtaskId, done) =>
            send({
              type: "updateSubtask",
              taskId: task.id,
              subtaskId,
              patch: { done, doneAt: done ? Date.now() : undefined },
            })
          }
          onText={(subtaskId, text) =>
            send({ type: "updateSubtask", taskId: task.id, subtaskId, patch: { text } })
          }
          onDelete={deleteSub}
        />
        <div className="flex items-center gap-1.5 mt-2">
          <span className="w-5 text-right text-[11px] font-semibold text-ink-3 tabular-nums shrink-0">
            {total + 1}.
          </span>
          <input
            value={newSub}
            onChange={(e) => setNewSub(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && addSub()}
            placeholder={t("task.addSubtask")}
            className="flex-1 min-w-0 h-8 rounded-full bg-white border border-[#E8E6E1] px-3 text-[12px] field"
          />
          <button onClick={addSub} className="h-8 w-8 shrink-0 flex items-center justify-center rounded-full bg-[#0A1931] text-[#C9A96E] text-[14px] font-semibold">
            +
          </button>
        </div>
      </div>

      <div>
        <div className="font-trajan text-[10px] uppercase tracking-wide text-ink-3 mb-1">
          {t("task.description")}
        </div>
        <AutoTextarea
          value={desc.value}
          onFocus={desc.onFocus}
          onChange={(e) => desc.setValue(e.target.value)}
          onBlur={() => {
            desc.onBlur();
            if (desc.value !== task.desc) patch({ desc: desc.value });
          }}
          placeholder={t("task.descPlaceholder")}
          className="w-full min-h-[3.2rem] rounded-lg bg-[#F5F3EF] border border-[#E8E6E1] p-2 text-[12px] field"
        />
      </div>

      <div>
        <div className="font-trajan text-[10px] uppercase tracking-wide text-ink-3 mb-1">
          {t("task.notes")}
        </div>
        <AutoTextarea
          value={notes.value}
          onFocus={notes.onFocus}
          onChange={(e) => notes.setValue(e.target.value)}
          onBlur={() => {
            notes.onBlur();
            if (notes.value !== task.notes) patch({ notes: notes.value });
          }}
          placeholder={t("task.notesPlaceholder")}
          className="w-full min-h-[3.2rem] rounded-lg bg-[#F5F3EF] border border-[#E8E6E1] p-2 text-[12px] field"
        />
      </div>

      {/* File Directory — shared network path with a copy button */}
      <div>
        <div className="font-trajan text-[10px] uppercase tracking-wide text-ink-3 mb-1">
          {t("task.fileDir")}
        </div>
        <div className="flex items-center gap-2 bg-[#F5F3EF] border border-[#E8E6E1] rounded-lg pl-2 pr-1 field">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-ink-3 shrink-0" aria-hidden="true">
            <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
          </svg>
          <input
            value={fileDir.value}
            onFocus={fileDir.onFocus}
            onChange={(e) => fileDir.setValue(e.target.value)}
            onBlur={() => {
              fileDir.onBlur();
              if (fileDir.value !== (task.fileDir ?? "")) patch({ fileDir: fileDir.value });
            }}
            placeholder={t("task.fileDirPlaceholder")}
            spellCheck={false}
            className="flex-1 min-w-0 bg-transparent py-2 text-[12px] font-mono text-[#0A1931] outline-none"
          />
          <button
            onClick={copyFileDir}
            disabled={!fileDir.value}
            title={t("task.copy")}
            className="shrink-0 h-8 px-3 my-0.5 rounded-md bg-[#0A1931] text-[#C9A96E] text-[11px] font-semibold disabled:opacity-30"
          >
            {copied ? t("task.copied") : t("task.copy")}
          </button>
        </div>
      </div>

      <div className="flex items-center justify-between pt-1 flex-wrap gap-2">
        <div className="flex items-center gap-2">
          <button
            onClick={() => move(-1)}
            disabled={idx <= 0}
            title={t("task.prev")}
            className="w-8 h-8 rounded-full border border-[#E8E6E1] text-[#0A1931] disabled:opacity-30"
          >
            ‹
          </button>
          <button
            onClick={() => move(1)}
            disabled={idx >= STATUS_ORDER.length - 1}
            title={t("task.next")}
            className="w-8 h-8 rounded-full bg-[#0A1931] text-white disabled:opacity-30"
          >
            ›
          </button>
          {/* Move directly to any section */}
          <select
            value={task.status}
            onChange={(e) => send({ type: "moveTask", id: task.id, status: e.target.value as Status })}
            title={t("quick.status")}
            className="h-8 rounded-full bg-[#F5F3EF] border border-[#E8E6E1] px-2 text-[12px] text-[#0A1931] field cursor-pointer"
          >
            {STATUS_ORDER.map((s) => (
              <option key={s} value={s}>{statusLabel(lang, s)}</option>
            ))}
          </select>
        </div>
        {confirmDel ? (
          <div
            role="group"
            aria-label={t("task.delete")}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.preventDefault();
                setConfirmDel(false);
              }
            }}
            className="flex flex-wrap items-center gap-2 min-w-0 max-w-full text-[13px] bg-[#FEF2F2] border border-[#FECACA] rounded-[18px] pl-3 pr-1 py-1"
          >
            <span className="min-w-0 flex-1 text-[#C81E1E] font-semibold break-words">
              {total > 0
                ? t("ux.board.deleteConfirmSubs", { title: task.title, n: total })
                : t("ux.board.deleteConfirm", { title: task.title })}
            </span>
            <span className="flex items-center gap-2 shrink-0">
              <button
                type="button"
                onClick={deleteTask}
                className="h-8 px-4 rounded-full bg-[#DC2626] text-white text-[12px] font-semibold"
              >
                {t("task.yes")}
              </button>
              <button
                ref={noRef}
                type="button"
                onClick={() => setConfirmDel(false)}
                className="h-8 px-4 rounded-full bg-white text-[#6B6B6B] border border-[#E8E6E1] text-[12px] font-semibold"
              >
                {t("task.no")}
              </button>
            </span>
          </div>
        ) : (
          <button
            ref={delRef}
            type="button"
            onClick={() => setConfirmDel(true)}
            className="h-8 px-4 rounded-full text-[12px] font-semibold text-[#6B6B6B] border border-[#E8E6E1]"
          >
            {t("task.delete")}
          </button>
        )}
      </div>
    </div>
  );
}
