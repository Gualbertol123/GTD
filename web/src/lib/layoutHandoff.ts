// What the phone layout had open, for the desktop to pick up when the layout
// switches (a tablet rotated across 767 px). The phone's project sheet is not
// in the address (it is an overlay with its own history step), so without
// this the desktop landed on the projects list (UX audit G-25).
import { navigate } from "./history";

let openProject: string | null = null;

/** The phone's open project sheet (null when none). */
export function setPhoneProject(id: string | null): void {
  openProject = id;
}

/**
 * On the switch to the desktop layout: open the project the phone had open.
 * The sheet, unmounting, steps back over its own history entry first; the
 * project's address is pushed after that step, or it would be undone.
 */
export function handOffToDesktop(): void {
  const id = openProject;
  openProject = null;
  if (!id) return;
  const go = () => navigate({ tab: "projects", sub: id });
  const onOverlay = !!(window.history.state as { overlay?: unknown } | null)?.overlay;
  if (!onOverlay) return go();
  let done = false;
  const once = () => {
    if (done) return;
    done = true;
    window.removeEventListener("popstate", once);
    // After the popstate's own route sync.
    setTimeout(go, 0);
  };
  window.addEventListener("popstate", once);
  setTimeout(once, 600); // the sheet's step never came: go anyway
}
