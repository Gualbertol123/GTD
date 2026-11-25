// The installed app's "Nuova attività" shortcut (manifest.webmanifest) opens
// /?new=1#/board. The phone opens its add sheet (MobileApp); the desktop
// focuses the Board's new-task field (QuickAdd; App opens the Board first).

/** The address asks for a new task. */
export function wantsNewTask(): boolean {
  try {
    return new URL(window.location.href).searchParams.has("new");
  } catch {
    return false;
  }
}

/** True once per request: the ?new is taken off the address (so a reload or
 *  Back does not ask again). */
export function takeNewTask(): boolean {
  if (!wantsNewTask()) return false;
  const url = new URL(window.location.href);
  url.searchParams.delete("new");
  window.history.replaceState(window.history.state, "", url.pathname + url.search + url.hash);
  return true;
}
