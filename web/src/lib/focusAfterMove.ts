// Moving a task to another column (the editor's ‹ › or its section picker)
// unmounts its card and mounts a new one in the other column, so keyboard
// focus fell to <body> and the editor closed. The editor notes the id here;
// the card that mounts for that task within a moment reopens and takes focus. (After a mouse
// click the browser shows no ring for it; from the keyboard it does.)
let pending: { id: string; at: number } | null = null;

export function focusCardAfterMove(id: string): void {
  pending = { id, at: Date.now() };
}

/** A newly mounted card asks whether it should take focus. */
export function claimFocusAfterMove(id: string): boolean {
  if (!pending || pending.id !== id || Date.now() - pending.at > 1500) return false;
  pending = null;
  return true;
}
