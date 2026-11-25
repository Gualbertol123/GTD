import { useEffect, useRef, useState } from "react";
import type { Board, Op, Priority, Project, Task } from "../../lib/types";
import { PRIORITY_DOT, STATUS_ORDER, UNASSIGNED, genId } from "../../lib/constants";
import { statusLabel, useT } from "../../lib/i18n";
import { useSyncedField } from "../../lib/useSyncedField";
import { useAutosave } from "../../lib/useAutosave";
import { ownersPatch } from "../../lib/owners";
import { toISODate } from "../../lib/dates";
import {
  PROJECT_COLORS,
  PROJECT_STATUS_COLOR,
  TASK_STATUS_COLOR,
  projectColor,
  projectPriority,
  type ProjectStats,
} from "../../lib/projects";
import { AutoTextarea } from "../AutoTextarea";
import { Avatars, HealthBadge, Icon, Pill, ProgressRing, fmtDay, fmtMs } from "./ProjectBits";
import { ProjectTasks } from "./ProjectTasks";

const PRIOS: Priority[] = ["P1", "P2", "P3", "P4"];

interface Props {
  board: Board;
  project: Project;
  stats: ProjectStats;
  send: (op: Op, onError?: (message: string) => void) => void;
  v2: boolean;
  onBack: () => void;
  prevId: string | null;
  nextId: string | null;
  onOpen: (id: string) => void;
  /** Called just before the project is deleted, with the ids of its linked tasks (for Undo). */
  onDeleted?: (project: Project, taskIds: string[], viaKeyboard: boolean) => void;
  /** Offers an Undo for a reversible action (shown by ProjectsView, which stays mounted). */
  notify?: (text: string, undo: () => void) => void;
}

const label = "font-trajan text-[10px] uppercase tracking-widest text-ink-2";
const card = "bg-white rounded-[14px] border border-[#E8E6E1]";

export function ProjectDetail({ board, project: p, stats: s, send, v2, onBack, prevId, nextId, onOpen, onDeleted, notify }: Props) {
  const { t, lang } = useT();
  const [err, setErr] = useState<string | null>(null);
  const color = projectColor(p);
  const done = s.status === "done";
  const name = useSyncedField(p.name);
  const desc = useSyncedField(p.description ?? "");

  const save = (op: Op) => {
    setErr(null);
    send(op, (m) => setErr(m));
  };
  const patch = (patch: Partial<Project>) => save({ type: "projectUpdate", id: p.id, patch });
  // The name saves on blur, Enter or unmount (not while typing, so Escape can
  // still cancel the edit); the description saves while typing too.
  const nameSave = useAutosave(name.value, p.name, (v) => patch({ name: v }), { debounce: false, trim: true });
  const descSave = useAutosave(desc.value, p.description ?? "", (v) => patch({ description: v }));


  const toggleOwner = (m: string) => {
    const cur = p.owners ?? [];
    patch({ owners: cur.includes(m) ? cur.filter((o) => o !== m) : [...cur, m] });
  };

  // Opening a project (or its ‹ › neighbour) replaces the list, so the
  // control that opened it is gone and focus fell to <body>: the page takes
  // it, named by the project, and Tab goes on from its top.
  const pageRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const a = document.activeElement;
    if (!a || a === document.body || !a.isConnected || !pageRef.current?.contains(a)) pageRef.current?.focus({ preventScroll: true });
  }, [p.id]);

  return (
    <div ref={pageRef} tabIndex={-1} role="region" aria-label={p.name} className="space-y-4 outline-none">
      {/* Navigation */}
      <div className="flex items-center gap-2 flex-wrap">
        <button
          onClick={onBack}
          className="h-9 px-4 rounded-full bg-white border border-[#E8E6E1] text-[12px] font-semibold text-[#0A1931]"
        >
          ← {t("projects.back")}
        </button>
        <button
          onClick={() => prevId && onOpen(prevId)}
          disabled={!prevId}
          title={t("projects.prev")}
          aria-label={t("projects.prev")}
          className="w-9 h-9 rounded-full bg-white border border-[#E8E6E1] text-[#0A1931] disabled:opacity-30"
        >
          ‹
        </button>
        <button
          onClick={() => nextId && onOpen(nextId)}
          disabled={!nextId}
          title={t("projects.next")}
          aria-label={t("projects.next")}
          className="w-9 h-9 rounded-full bg-white border border-[#E8E6E1] text-[#0A1931] disabled:opacity-30"
        >
          ›
        </button>
        <span className="flex-1" />
        <button
          onClick={() => save({ type: "projectReportHidden", id: p.id, hidden: !p.reportHidden })}
          title={t("projects.reportHint")}
          className={`h-9 px-3 rounded-full border text-[12px] font-semibold ${
            p.reportHidden ? "bg-white text-ink-2 border-[#E8E6E1]" : "bg-[#ECFDF5] text-[#065F46] border-[#A7F3D0]"
          }`}
        >
          {p.reportHidden ? `○ ${t("projects.notInReport")}` : `● ${t("projects.inReport")}`}
        </button>
        {/* Deleted at once, with Annulla (owner's rule, 2026-11-25): its tasks are
            unlinked and kept, and Annulla links them back. */}
        <button
          onClick={(e) => {
            onDeleted?.(p, board.tasks.filter((x) => x.projectId === p.id).map((x) => x.id), e.detail === 0);
            save({ type: "projectDelete", id: p.id });
            onBack();
          }}
          className="h-9 px-3 rounded-full text-[12px] font-semibold text-ink-2 border border-[#E8E6E1]"
        >
          {t("projects.delete")}
        </button>
      </div>

      {!v2 && (
        <div className="rounded-[12px] border border-[#FDE68A] bg-[#FEF3C7] px-4 py-2.5 text-[12px] text-[#92400E]">
          {t("projects.migration")}
        </div>
      )}
      {err && (
        <div className="rounded-[12px] border border-[#FECACA] bg-[#FEF2F2] px-4 py-2.5 text-[12px] text-[#C81E1E]">
          {t("projects.saveFailed")} {err}
        </div>
      )}

      {/* Hero */}
      <div className={`${card} relative overflow-hidden`}>
        <span className="absolute left-0 right-0 top-0 h-1.5" style={{ background: color }} />
        <div className="p-4 sm:p-5 pt-6 grid grid-cols-1 lg:grid-cols-[1fr_auto] gap-5">
          <div className="min-w-0 space-y-3.5">
            <div className="flex items-center gap-2 flex-wrap" title={t("projects.autoStatus")}>
              {done ? (
                <Pill color={PROJECT_STATUS_COLOR.done} solid>✓ {t("projects.completedOn", { d: fmtMs(s.completedAt!, lang, true) })}</Pill>
              ) : (
                <Pill color={PROJECT_STATUS_COLOR.ongoing} solid>
                  {t("projects.status.ongoing")}
                </Pill>
              )}
              <span className="text-[11px] text-ink-2">{t("projects.autoStatus")}</span>
            </div>

            <AutoTextarea
              value={name.value}
              rows={1}
              aria-label={t("projects.newName")}
              title={t("ux.projects.cancelEdit")}
              onFocus={name.onFocus}
              onChange={(e) => name.setValue(e.target.value.replace(/[\r\n]+/g, " "))}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  e.currentTarget.blur();
                } else if (e.key === "Escape") {
                  e.preventDefault();
                  e.stopPropagation();
                  nameSave.reset();
                  name.setValue(p.name);
                  e.currentTarget.blur();
                }
              }}
              onBlur={() => {
                name.onBlur();
                nameSave.flush();
                if (!name.value.trim()) name.setValue(p.name);
              }}
              className="w-full font-trajan text-[22px] sm:text-[26px] leading-tight text-[#0A1931] bg-transparent outline-none border-b border-transparent field resize-none break-words [overflow-wrap:anywhere]"
            />

            <fieldset disabled={!v2} className="space-y-3 disabled:opacity-50">
              <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
                <div className="flex items-center gap-2">
                  <span className={label}>{t("projects.priority")}</span>
                  <div className="flex gap-1">
                    {PRIOS.map((pr) => (
                      <button
                        key={pr}
                        aria-pressed={projectPriority(p) === pr}
                        onClick={() => patch({ priority: pr })}
                        className={`h-7 px-2.5 rounded-full text-[11px] font-semibold border inline-flex items-center gap-1 ${
                          projectPriority(p) === pr
                            ? "bg-[#0A1931] text-[#C9A96E] border-[#0A1931]"
                            : "bg-white text-ink-2 border-[#E8E6E1]"
                        }`}
                      >
                        <span className={`w-2 h-2 rounded-full ${PRIORITY_DOT[pr]}`} />
                        {pr}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <label className="inline-flex items-center gap-1.5 bg-[#F5F3EF] rounded-full px-3 h-8 border border-[#E8E6E1] text-[12px] text-ink-2 field">
                    {t("projects.start")}
                    <input
                      type="date"
                      value={p.startDate ?? ""}
                      max={p.targetDate}
                      onChange={(e) => patch({ startDate: e.target.value || undefined })}
                      className="bg-transparent outline-none text-[12px] text-[#0A1931]"
                    />
                  </label>
                  <span className="text-ink-3">→</span>
                  <label className="inline-flex items-center gap-1.5 bg-[#F5F3EF] rounded-full px-3 h-8 border border-[#E8E6E1] text-[12px] text-ink-2 field">
                    {t("projects.target")}
                    <input
                      type="date"
                      value={p.targetDate ?? ""}
                      min={p.startDate}
                      onChange={(e) => patch({ targetDate: e.target.value || undefined })}
                      className="bg-transparent outline-none text-[12px] text-[#0A1931]"
                    />
                  </label>
                </div>
                <span className="flex items-center" role="group" aria-label={t("projects.color")}>
                  {PROJECT_COLORS.map((c) => {
                    const cname = t(`ux.projects.color.${c}`);
                    return (
                      <button
                        key={c}
                        type="button"
                        aria-pressed={color === c}
                        aria-label={cname}
                        title={cname}
                        onClick={() => patch({ color: c })}
                        className="group/sw p-0.5 rounded-full"
                      >
                        <span
                          className="block w-5 h-5 rounded-full"
                          style={{ background: c, boxShadow: color === c ? `0 0 0 2px #fff, 0 0 0 4px ${c}` : undefined }}
                        />
                      </button>
                    );
                  })}
                </span>
              </div>

              <div className="flex flex-wrap items-center gap-1.5">
                <span className={`${label} mr-1`}>{t("projects.leads")}</span>
                {board.members.map((m) => {
                  const on = (p.owners ?? []).includes(m);
                  return (
                    <button
                      key={m}
                      aria-pressed={on}
                      onClick={() => toggleOwner(m)}
                      className="tab h-7 px-2.5 text-[12px] gap-1"
                    >
                      {on && <Icon name="check" size={11} strokeWidth={2.6} />}
                      {m}
                    </button>
                  );
                })}
              </div>

              <AutoTextarea
                value={desc.value}
                onFocus={desc.onFocus}
                onChange={(e) => desc.setValue(e.target.value)}
                onBlur={() => {
                  desc.onBlur();
                  descSave.flush();
                }}
                placeholder={t("projects.descriptionPlaceholder")}
                aria-label={t("projects.description")}
                className="w-full rounded-lg bg-[#F5F3EF] border border-[#E8E6E1] px-2.5 py-2 text-[13px] leading-relaxed text-[#0A1931] field"
              />
            </fieldset>
          </div>

          {/* Progress */}
          <div className="flex lg:flex-col items-center lg:items-stretch gap-4 lg:w-[220px]">
            <div className="flex flex-col items-center gap-2">
              <ProgressRing value={s.share} color={done ? PROJECT_STATUS_COLOR.done : color} size={112} stroke={10} label={s.total ? undefined : "—"} />
              {!done && <HealthBadge health={s.health} daysLeft={s.daysLeft} />}
            </div>
            <div className="flex-1 space-y-1 text-[12px] text-ink-2">
              {STATUS_ORDER.filter((st) => s.byStatus[st]).map((st) => (
                <div key={st} className="flex items-center justify-between gap-2">
                  <span className="flex items-center gap-1.5">
                    <span className="w-2 h-2 rounded-full" style={{ background: TASK_STATUS_COLOR[st] }} />
                    {statusLabel(lang, st)}
                  </span>
                  <span className="font-semibold tabular-nums text-[#0A1931]">{s.byStatus[st]}</span>
                </div>
              ))}
              {s.total === 0 && <div className="text-ink-3">{t("projects.noTasksYet")}</div>}
              {(p.owners ?? []).length > 0 && (
                <div className="flex items-center justify-between gap-2 pt-1.5">
                  <span>{t("projects.leads")}</span>
                  <Avatars names={p.owners ?? []} max={4} />
                </div>
              )}
            </div>
          </div>
        </div>

        <Schedule project={p} stats={s} color={color} />
      </div>

      {/* Tasks + notes */}
      <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_300px] gap-4 items-start">
        <ProjectTasks board={board} project={p} stats={s} v2={v2} save={save} notify={notify} />
        <div className="space-y-4">
          <Notes project={p} v2={v2} patch={patch} />
          {p.items.length > 0 && <LegacyChecklist project={p} v2={v2} save={save} patch={patch} />}
        </div>
      </div>
    </div>
  );
}

// ---- Schedule strip -------------------------------------------------------------

function msOf(iso: string): number {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d).getTime();
}

function Schedule({ project: p, stats: s, color }: { project: Project; stats: ProjectStats; color: string }) {
  const { t, lang } = useT();
  if (!p.startDate || !p.targetDate || s.status === "done") return null;
  const a = msOf(p.startDate);
  const b = msOf(p.targetDate) + 86400000;
  if (b <= a) return null;
  const now = msOf(toISODate(new Date()));
  const pos = (ms: number) => Math.max(0, Math.min(100, ((ms - a) / (b - a)) * 100));
  const elapsed = pos(now);
  return (
    <div className="px-4 sm:px-5 pb-4">
      <div className="flex items-center justify-between text-[10px] font-semibold text-ink-2 mb-1 gap-2">
        <span>{fmtDay(p.startDate, lang, true)}</span>
        <span className="text-center">
          {t("projects.timeUsed", { n: Math.round(elapsed) })} · {t("projects.workDone", { n: Math.round(s.share * 100) })}
        </span>
        <span>{fmtDay(p.targetDate, lang, true)}</span>
      </div>
      <div className="relative h-3 rounded-full" style={{ background: "rgba(120,120,128,0.14)" }}>
        <div className="absolute inset-y-0 left-0 rounded-full" style={{ width: `${s.share * 100}%`, background: color }} />
        {now >= a && now <= b && (
          <span className="absolute -top-1.5 -bottom-1.5 w-0.5 bg-[#FF3B30]" style={{ left: `${elapsed}%` }} title={t("projects.timeline.today")} />
        )}
      </div>
    </div>
  );
}

// ---- Notes ----------------------------------------------------------------------

function Notes({ project: p, v2, patch }: { project: Project; v2: boolean; patch: (p: Partial<Project>) => void }) {
  const { t } = useT();
  const notes = useSyncedField(p.notes ?? "");
  const notesSave = useAutosave(notes.value, p.notes ?? "", (v) => patch({ notes: v }));
  return (
    <div className={`${card} p-4 space-y-2`}>
      <h3 className="font-trajan text-[13px] uppercase tracking-widest text-[#0A1931]">{t("projects.notes")}</h3>
      <AutoTextarea
        value={notes.value}
        disabled={!v2}
        onFocus={notes.onFocus}
        onChange={(e) => notes.setValue(e.target.value)}
        onBlur={() => {
          notes.onBlur();
          notesSave.flush();
        }}
        placeholder={t("projects.notesPlaceholder")}
        aria-label={t("projects.notes")}
        className="w-full min-h-[7rem] rounded-lg bg-[#FFFBF2] border border-[#E8E6E1] p-2.5 text-[12px] leading-relaxed text-[#0A1931] field disabled:opacity-50"
      />
    </div>
  );
}

// ---- The old checklist ------------------------------------------------------------
// Projects used to carry a checklist. It is no longer edited; whatever a project
// still holds is shown once, to be turned into board tasks or copied into notes.

function LegacyChecklist({
  project: p,
  v2,
  save,
  patch,
}: {
  project: Project;
  v2: boolean;
  save: (op: Op) => void;
  patch: (p: Partial<Project>) => void;
}) {
  const { t } = useT();
  const toTasks = () => {
    const now = Date.now();
    p.items.forEach((it, i) => {
      const task: Task = {
        id: genId(),
        title: it.text || "—",
        desc: "",
        ...ownersPatch((p.owners ?? []).length ? (p.owners ?? []).slice(0, 1) : [UNASSIGNED]),
        priority: projectPriority(p),
        status: it.done ? "DONE" : "BACKLOG",
        notes: "",
        subtasks: [],
        projectId: p.id,
        updatedAt: now,
        createdAt: now + i, // keep the checklist's order
        ...(it.done ? { doneAt: it.doneAt ?? now } : {}),
      };
      save({ type: "addTask", task });
    });
    patch({ items: [] });
  };
  const toNotes = () => {
    const lines = p.items.map((it) => `${it.done ? "☑" : "☐"} ${it.text}`).join("\n");
    const cur = (p.notes ?? "").trimEnd();
    patch({ notes: cur ? `${cur}\n\n${lines}` : lines, items: [] });
  };
  return (
    <div className="rounded-[14px] border border-dashed border-[#E3DFD7] bg-[#FAF9F6] p-4 space-y-2">
      <h3 className="font-trajan text-[11px] uppercase tracking-widest text-ink-2">{t("projects.legacy.title")}</h3>
      <p className="text-[11px] text-ink-2">{t("projects.legacy.hint")}</p>
      <ul className="space-y-1">
        {p.items.map((it) => (
          <li key={it.id} className={`text-[12px] flex gap-1.5 ${it.done ? "line-through text-ink-3" : "text-[#0A1931]"}`}>
            <span>{it.done ? "☑" : "☐"}</span>
            <span className="break-words min-w-0">{it.text}</span>
          </li>
        ))}
      </ul>
      <div className="flex gap-1.5 flex-wrap pt-1">
        <button
          onClick={toTasks}
          disabled={!v2}
          className="h-8 px-3 rounded-full bg-[#0A1931] text-[#C9A96E] text-[11px] font-semibold disabled:opacity-40"
        >
          {t("projects.legacy.toTasks")}
        </button>
        <button
          onClick={toNotes}
          disabled={!v2}
          className="h-8 px-3 rounded-full border border-[#E8E6E1] bg-white text-[#0A1931] text-[11px] font-semibold disabled:opacity-40"
        >
          {t("projects.legacy.toNotes")}
        </button>
      </div>
    </div>
  );
}
