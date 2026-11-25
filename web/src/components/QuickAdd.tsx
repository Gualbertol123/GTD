import { useEffect, useRef, useState } from "react";
import { toISODate } from "../lib/dates";
import type { Op, Priority, Recurrence, Status, Task } from "../lib/types";
import { STATUS_ORDER, UNASSIGNED, genId } from "../lib/constants";
import { ownerInitial, ownersLabel, ownersPatch } from "../lib/owners";
import { priorityLabel, statusLabel, useT } from "../lib/i18n";
import { useMe } from "../lib/identity";
import { useProjects } from "../lib/projectsContext";
import { RepeatIcon, StarIcon } from "./RecurrenceControls";

const PRIOS: Priority[] = ["P1", "P2", "P3", "P4"];

interface Props {
  members: string[];
  send: (op: Op) => void;
  showNames?: boolean; // false hides the owner name (screenshot mode)
  /** False before migration 009: a new task can only be given to one person. */
  multiAssign?: boolean;
  /** Where will a new task show? `filtered`: the filters hide it; `column`: its column is hidden. */
  visibility?: (task: Task) => { filtered: boolean; column: boolean };
  /** Clear what hides the task (filters and/or its hidden column). */
  onReveal?: (task: Task) => void;
}

interface Added {
  task: Task;
  filtered: boolean;
  column: boolean;
}

// Full new-task bar: choose who it goes to, priority, status and due date up
// front — nothing is assumed. The assignee control holds as many people as you
// like, the same as the picker inside a task.
export function QuickAdd({
  members,
  send,
  showNames = true,
  multiAssign = true,
  visibility,
  onReveal,
}: Props) {
  const { t, lang } = useT();
  const titleRef = useRef<HTMLInputElement>(null);
  const [empty, setEmpty] = useState(false);
  const [added, setAdded] = useState<Added | null>(null);
  // The confirmation stays a little longer when the new task is out of sight.
  useEffect(() => {
    if (!added) return;
    const h = window.setTimeout(() => setAdded(null), added.filtered || added.column ? 9000 : 4000);
    return () => window.clearTimeout(h);
  }, [added]);
  const { me } = useMe();
  const [title, setTitle] = useState("");
  const [owners, setOwners] = useState<string[]>([
    me && members.includes(me) ? me : members[0] ?? UNASSIGNED,
  ]);
  const [pickOpen, setPickOpen] = useState(false);
  const [priority, setPriority] = useState<Priority>("P2");
  const [status, setStatus] = useState<Status>("NEXT");
  const [due, setDue] = useState("");
  const [repeat, setRepeat] = useState<Recurrence["freq"] | "">("");
  const [pin, setPin] = useState(false);
  const { recurring: recurringOn } = useProjects();

  const memberLabel = (name: string) => (name === UNASSIGNED ? t("members.unassigned") : name);

  // Same rule as the picker inside a task: a name adds when several people can
  // share, replaces when they cannot, and Unassigned never shares.
  const toggleOwner = (name: string) => {
    if (!multiAssign || name === UNASSIGNED) {
      setOwners([name]);
      return;
    }
    setOwners((prev) =>
      prev.includes(name)
        ? prev.filter((o) => o !== name).length
          ? prev.filter((o) => o !== name)
          : [UNASSIGNED]
        : [...prev.filter((o) => o !== UNASSIGNED), name]
    );
  };

  const create = () => {
    const v = title.trim();
    if (!v) {
      // Say why nothing happened, and put the cursor where the title goes.
      setEmpty(true);
      titleRef.current?.focus();
      return;
    }
    const task: Task = {
      id: genId(),
      title: v,
      desc: "",
      ...ownersPatch(owners),
      priority,
      status,
      notes: "",
      subtasks: [],
      dueDate: due || undefined,
      // A task born in Waiting starts counting its days today.
      ...(status === "WAITING" ? { waitingSince: toISODate(new Date()) } : {}),
      ...(recurringOn && pin ? { pinned: true } : {}),
      ...(recurringOn && repeat ? { recurrence: { freq: repeat, every: 1 } } : {}),
      updatedAt: Date.now(),
      createdAt: Date.now(),
    };
    send({ type: "addTask", task });
    const vis = visibility?.(task) ?? { filtered: false, column: false };
    setAdded({ task, ...vis });
    setTitle("");
    setDue("");
    setRepeat("");
    setPin(false);
    setPickOpen(false);
  };

  const field =
    "qa-field h-11 rounded-full bg-white border border-[#E8E6E1] text-[13px] field";

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
      <input
        ref={titleRef}
        value={title}
        onChange={(e) => {
          setTitle(e.target.value);
          if (empty) setEmpty(false);
        }}
        onKeyDown={(e) => e.key === "Enter" && create()}
        placeholder={t("quick.title")}
        aria-label={t("quick.title")}
        aria-invalid={empty || undefined}
        aria-describedby={empty ? "quick-add-hint" : undefined}
        className={`${field} flex-1 min-w-[200px] px-5`}
      />
      {showNames ? (
        <button
          type="button"
          onClick={() => setPickOpen((v) => !v)}
          aria-expanded={pickOpen}
          title={t("quick.owner")}
          className={`${field} pl-1.5 pr-3 inline-flex items-center gap-1.5 text-[#0A1931]`}
        >
          <span className="flex -space-x-1.5">
            {owners.slice(0, 3).map((name, i) => (
              <span
                key={`${name}-${i}`}
                className="w-7 h-7 rounded-full bg-[#0A1931] text-white text-[10px] font-bold flex items-center justify-center ring-2 ring-white"
              >
                {ownerInitial(name)}
              </span>
            ))}
          </span>
          <span>{ownersLabel({ owner: owners[0] ?? UNASSIGNED, assignees: owners }, memberLabel)}</span>
          {/* The same down chevron as the dropdowns next to it. */}
          <svg
            width="12"
            height="12"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="3"
            strokeLinecap="round"
            strokeLinejoin="round"
            className={`ml-1 opacity-70 transition-transform ${pickOpen ? "rotate-180" : ""}`}
            aria-hidden="true"
          >
            <path d="m6 9 6 6 6-6" />
          </svg>
        </button>
      ) : (
        // Screenshot mode: the selected owner is still used on submit, just not shown.
        <span className={`${field} px-4 inline-flex items-center text-ink-3`} title={t("quick.owner")}>
          —
        </span>
      )}
      <select
        value={priority}
        onChange={(e) => setPriority(e.target.value as Priority)}
        title={t("quick.priority")}
        aria-label={t("quick.priority")}
        className={`${field} px-3`}
      >
        {PRIOS.map((p) => (
          <option key={p} value={p}>{priorityLabel(t, p)}</option>
        ))}
      </select>
      <select
        value={status}
        onChange={(e) => setStatus(e.target.value as Status)}
        title={t("quick.status")}
        aria-label={t("quick.status")}
        className={`${field} px-3`}
      >
        {STATUS_ORDER.map((s) => (
          <option key={s} value={s}>{statusLabel(lang, s)}</option>
        ))}
      </select>
      <label className={`${field} pl-4 pr-3 inline-flex items-center gap-1.5 text-[#6B6B6B]`}>
        <span className="text-[12px]">{t("quick.due")}</span>
        <input
          type="date"
          value={due}
          onChange={(e) => setDue(e.target.value)}
          title={t("quick.due")}
          className="min-w-0 bg-transparent outline-none text-[13px] text-[#0A1931]"
        />
      </label>
      {recurringOn && (
        <>
          <label className={`${field} pl-4 pr-3 inline-flex items-center gap-1.5 text-[#6B6B6B]`} title={t("rec.repeat")}>
            <RepeatIcon />
            <select
              value={repeat}
              onChange={(e) => setRepeat(e.target.value as Recurrence["freq"] | "")}
              aria-label={t("rec.repeat")}
              className="bg-transparent outline-none text-[13px] text-[#0A1931] cursor-pointer"
            >
              <option value="">{t("rec.repeat")}: {t("rec.never")}</option>
              {(["daily", "weekly", "monthly", "yearly"] as const).map((f) => (
                <option key={f} value={f}>{t(`rec.${f}`)}</option>
              ))}
            </select>
          </label>
          <button
            type="button"
            aria-pressed={pin}
            onClick={() => setPin((v) => !v)}
            title={t(pin ? "pin.remove" : "pin.add")}
            aria-label={t("pin.add")}
            className={`${field} w-11 inline-flex items-center justify-center ${pin ? "text-[#C9A96E] !border-[#C9A96E]" : "text-[#6B6B6B]"}`}
          >
            <StarIcon on={pin} size={16} />
          </button>
        </>
      )}
      <button
        type="button"
        onClick={create}
        className="h-11 px-6 rounded-full bg-[#0A1931] text-[#C9A96E] text-[13px] font-semibold tracking-wide uppercase"
      >
        + {t("quick.add")}
      </button>
      </div>

      {/* Feedback for the last submit: an empty title, or where the task went. */}
      <div aria-live="polite" role="status" className={empty || added ? "" : "!mt-0"}>
        {empty ? (
          <p id="quick-add-hint" className="px-2 text-[12px] font-semibold text-[#C81E1E]">
            {t("ux.board.titleRequired")}
          </p>
        ) : added ? (
          <p className="px-2 text-[12px] text-[#6B6B6B] flex flex-wrap items-center gap-x-1.5 gap-y-1">
            <span>{t("ux.board.added", { status: statusLabel(lang, added.task.status) })}</span>
            {(added.filtered || added.column) && (
              <>
                <span className="text-[#92400E] font-semibold">
                  {added.column && !added.filtered
                    ? t("ux.board.addedHiddenCol", { status: statusLabel(lang, added.task.status) })
                    : t("ux.board.addedHidden")}
                </span>
                {onReveal && (
                  <button
                    type="button"
                    onClick={() => {
                      onReveal(added.task);
                      setAdded({ ...added, filtered: false, column: false });
                    }}
                    className="h-7 px-3 rounded-full text-[11px] font-semibold bg-white text-[#0A1931] border border-[#E8E6E1]"
                  >
                    {t("ux.board.show")}
                  </button>
                )}
              </>
            )}
          </p>
        ) : null}
      </div>

      {showNames && pickOpen && (
        <div className="rounded-[12px] border border-[#E8E6E1] bg-[#F5F3EF] p-2.5 space-y-2">
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
    </div>
  );
}
