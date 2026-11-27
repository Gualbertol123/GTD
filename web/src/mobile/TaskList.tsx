import type { Task } from "../lib/types";
import { TaskCard } from "./TaskCard";
import { useNav } from "./nav";
import { useTaskActions, type Send } from "./actions";
import { useCardData } from "./cardData";

/**
 * A column of task cards wired to the shell's open / move actions.
 *
 * The cards are memoised (TaskCard.tsx), so everything handed to them stays
 * the same object until it really changes: the handlers are the shell's own
 * (nav) and useTaskActions' (stable callbacks), never a closure per card, and
 * each card gets its project and step from the board-wide CardData.
 */
export function TaskList({
  tasks,
  send,
  showStatus,
  hideProject,
  swipe = true,
}: {
  tasks: Task[];
  send: Send;
  showStatus?: boolean;
  /** Hide each card's project-name chip (in that project's own sheet). */
  hideProject?: boolean;
  /** Card swipe actions; off on the Board, where sideways swipes change column. */
  swipe?: boolean;
}) {
  const nav = useNav();
  const { toggleDone } = useTaskActions(send);
  const { projectById, steps, members, today } = useCardData();
  return (
    <div className="m-stack">
      {tasks.map((tk) => {
        const project = tk.projectId ? projectById.get(tk.projectId) : undefined;
        const step = project ? steps.get(tk.id) : undefined;
        return (
          <TaskCard
            key={tk.id}
            task={tk}
            project={project}
            stepN={step?.n}
            stepTotal={step?.total}
            members={members}
            today={today}
            showStatus={showStatus}
            hideProject={hideProject}
            swipe={swipe}
            onOpen={nav.openTask}
            onToggleDone={toggleDone}
            onMove={nav.moveTask}
          />
        );
      })}
    </div>
  );
}
