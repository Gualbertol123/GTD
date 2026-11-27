import { UNASSIGNED } from "../lib/constants";
import { useT } from "../lib/i18n";

/**
 * Who holds a task after ticking `name`. A name adds when several people can
 * share (migration 009), replaces when they cannot, and Unassigned never
 * shares; taking the last name off leaves it unassigned.
 */
export function nextOwners(prev: string[], name: string, multiAssign: boolean): string[] {
  if (!multiAssign || name === UNASSIGNED) return [name];
  if (prev.includes(name)) {
    const rest = prev.filter((o) => o !== name);
    return rest.length ? rest : [UNASSIGNED];
  }
  return [...prev.filter((o) => o !== UNASSIGNED), name];
}

// The "tick names" panel under an assignee pill: the same in a task's editor,
// the board's new-task bar and a project's new task.
export function AssigneePanel({
  members,
  owners,
  multiAssign,
  onToggle,
  onClose,
}: {
  members: string[];
  owners: string[];
  multiAssign: boolean;
  onToggle: (name: string) => void;
  /** Escape closes the panel (and nothing around it). */
  onClose?: () => void;
}) {
  const { t } = useT();
  const memberLabel = (name: string) => (name === UNASSIGNED ? t("members.unassigned") : name);
  return (
    <div
      className="rounded-[12px] border border-[#E8E6E1] bg-[#F5F3EF] p-2.5 space-y-2"
      onKeyDown={
        onClose
          ? (e) => {
              if (e.key === "Escape") {
                // The card around it checks defaultPrevented and stays open.
                e.preventDefault();
                onClose();
              }
            }
          : undefined
      }
    >
      <div className="flex items-baseline justify-between gap-2 flex-wrap">
        <span className="font-trajan text-[10px] uppercase tracking-wide text-ink-3">{t("assign.title")}</span>
        <span className="text-[10px] text-ink-2">{t(multiAssign ? "assign.hintMulti" : "assign.hintSingle")}</span>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {[UNASSIGNED, ...members].map((m) => (
          <button
            key={m}
            type="button"
            onClick={() => onToggle(m)}
            aria-pressed={owners.includes(m)}
            className="tab h-7 px-3 text-[11px]"
          >
            {memberLabel(m)}
          </button>
        ))}
      </div>
      {!multiAssign && <p className="text-[10px] text-[#C81E1E]">{t("assign.migrationNote")}</p>}
    </div>
  );
}
