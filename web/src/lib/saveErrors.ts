// A refused write the screen it came from did not report itself (most board,
// weekly and calendar edits): useBoard puts it here, and the app shell shows
// it ("Non salvato…") in the shared toast, on the desktop and the phone.
// Before, the change just snapped back with no word (it only reached the
// loading screen's error line).
type Listener = (message: string) => void;
const listeners = new Set<Listener>();

export function reportSaveError(message: string): void {
  listeners.forEach((l) => l(message));
}

export function onSaveError(l: Listener): () => void {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

/** A write naming a column the database does not have yet: a migration still
 *  to run. PostgREST says PGRST204 (unknown column in the body), Postgres
 *  42703 (unknown column in a filter). Any other refusal is something else. */
export function isMissingColumn(error: unknown): boolean {
  const code = error && typeof error === "object" && "code" in error ? (error as { code: unknown }).code : null;
  return code === "PGRST204" || code === "42703";
}
