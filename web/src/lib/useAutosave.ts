import { useEffect, useRef } from "react";

const AUTOSAVE_MS = 600;

/**
 * Saves a text field while the user types (debounced) and, above all, on
 * unmount: Back, Prev/Next or a tab switch remove the field without a blur.
 * Everything the cleanup needs is read through refs, never from the closure
 * of the first render.
 */
export function useAutosave(
  value: string,
  remote: string,
  commit: (v: string) => void,
  { debounce = true, trim = false }: { debounce?: boolean; trim?: boolean } = {}
) {
  const latest = useRef(value);
  latest.current = value;
  const remoteRef = useRef(remote);
  const sent = useRef<string | null>(null);
  if (remoteRef.current !== remote) {
    remoteRef.current = remote;
    sent.current = null;
  }
  const commitRef = useRef(commit);
  commitRef.current = commit;
  const timer = useRef<number | null>(null);
  const opts = useRef({ trim });

  const cancel = () => {
    if (timer.current !== null) {
      window.clearTimeout(timer.current);
      timer.current = null;
    }
  };
  const flushRef = useRef(() => {});
  flushRef.current = () => {
    cancel();
    const v = opts.current.trim ? latest.current.trim() : latest.current;
    if (opts.current.trim && !v) return; // never save an empty name
    if (v === remoteRef.current || v === sent.current) return;
    sent.current = v;
    commitRef.current(v);
  };

  useEffect(() => {
    if (!debounce) return;
    if ((trim ? value.trim() : value) === remoteRef.current) return;
    timer.current = window.setTimeout(() => flushRef.current(), AUTOSAVE_MS);
    return cancel;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, debounce]);

  // Unmount: clear the pending timer and save what is left, once.
  useEffect(() => () => flushRef.current(), []);

  return {
    flush: () => flushRef.current(),
    /** Drop the pending edit: the field goes back to the saved value. */
    reset: () => {
      cancel();
      latest.current = remoteRef.current;
    },
  };
}
