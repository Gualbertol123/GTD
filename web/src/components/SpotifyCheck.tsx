import { useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useT } from "../lib/i18n";
import { useMe } from "../lib/identity";
import { mlog, music, musicErrorText } from "../lib/music";
import { usePlaylists } from "../lib/musicDb";
import { beginSpotifyLogin, spotifyLoginAvailable, spotifyUserToken, useSpotifyAuth } from "../lib/spotifyAuth";
import {
  addEntry,
  cancelImport,
  checkRows,
  checkSummary,
  entriesOf,
  getImportState,
  importStep,
  retryMissing,
  startAddAll,
  subscribeImport,
  type CheckRow,
  type ImportState,
  type SpEntry,
} from "../lib/spotifyAddAll";
import { SpotifyApiError, likedTotal, markLibraryReturn, spotifyErrorText, spotifyMe, type SpItem } from "../lib/spotifyLibrary";
import { playlistErrorText } from "./SongMenu";
import { IconAlert, IconCheckCircle, IconError, IconPending, IconPlus, IconRepeat, IconSpinner } from "./MusicIcons";

// -----------------------------------------------------------------------------
// One button and one check (lib/spotifyAddAll.ts):
//   AddAllButton     "Aggiungi tutte le mie playlist" (signs in first when needed;
//                    the import then starts by itself on the way back)
//   ImportProgress   "Playlist 3 di 12 · brani 40 di 85", with Annulla
//   SpotifyCheck     "Le tue playlist Spotify": each list against the team
//                    playlists' sources — Aggiunta / In corso / Incompleta /
//                    Errore / Da aggiungere — with its one-click action.
// Spotify is credited in words ("Contenuti forniti da Spotify"); no Spotify
// cover art is shown next to the controls that make YouTube playlists.
// -----------------------------------------------------------------------------

type T = (key: string, vars?: Record<string, string | number>) => string;

export function useImportState(): ImportState {
  return useSyncExternalStore(subscribeImport, getImportState, getImportState);
}

/** A task's error code, in words. */
export function importErrorText(code: string | undefined, t: T): string {
  const c = code ?? "server";
  if (c.startsWith("sp:")) return spotifyErrorText(new SpotifyApiError(c.slice(3) as never), t);
  if (c.startsWith("db:")) return playlistErrorText(t("mt.notSaved"), c.slice(3), t);
  const bare = c.startsWith("sync:") ? c.slice(5) : c;
  if (bare === "migration") return t("sync.needMigration");
  if (bare === "none-found") return t("oc.noneFound");
  if (bare === "empty") return t("oc.empty");
  if (bare === "liked-other") return t("sync.likedOther");
  if (bare === "forbidden" || bare === "missing-table") return playlistErrorText(t("mt.notSaved"), bare, t);
  return musicErrorText(bare, t);
}

/**
 * "Aggiungi tutte le mie playlist": one primary button. `blocked`: another
 * import (the preview) is reading or matching; signing in leaves the page and
 * would drop it, so the button waits (with the note) while signed out.
 * aria-disabled, never disabled: the focus stays on it while it runs.
 */
export function AddAllButton({ className, blocked }: { className?: string; blocked?: boolean }) {
  const { t } = useT();
  const { me } = useMe();
  const auth = useSpotifyAuth();
  const s = useImportState();
  const noteId = useId();
  if (!spotifyLoginAvailable()) return null;
  const running = !!s.job?.running && !s.job.cancelled;
  const signedIn = auth.status === "in";
  const wait = !signedIn && !!blocked;
  const off = running || auth.status === "busy" || wait;
  return (
    <>
      <button
        type="button"
        className={`mt-pill mt-pill--solid oc-all${className ? " " + className : ""}`}
        aria-disabled={off || undefined}
        aria-busy={running || undefined}
        aria-describedby={signedIn ? undefined : noteId}
        onClick={() => {
          if (off) return;
          if (!signedIn) {
            // Off to Spotify; back on the library, the import starts by itself (takeAddAllIntent).
            mlog("add-all: needs the sign-in first");
            markLibraryReturn("add-all");
            void beginSpotifyLogin();
            return;
          }
          void startAddAll({ owner: me, likedName: t("spl.secLiked") });
        }}
      >
        {running || auth.status === "busy" ? <IconSpinner size={16} /> : <IconPlus size={16} />} {t("oc.all")}
      </button>
      {!signedIn && (
        <span id={noteId} className={wait ? "mt-hint oc-wait" : "sr-only"}>
          {t(wait ? "ux.music.splibWaitImport" : "oc.allSignIn")}
        </span>
      )}
    </>
  );
}

/** Where the import is: "Playlist 3 di 12 · brani 40 di 85", a bar, Annulla. */
export function ImportProgress() {
  const { t } = useT();
  const s = useImportState();
  const j = s.job;
  if (!j?.running) return null;
  const cancel = (
    <button type="button" className="mt-pill mt-pill--sm oc-cancel" onClick={cancelImport}>
      {t("oc.cancel")}
    </button>
  );
  if (!j.tasks.length)
    return (
      <div className="oc-progress" role="status">
        <span className="oc-progress__label">
          <IconSpinner size={15} /> {t("oc.listing")}
        </span>
        {cancel}
      </div>
    );
  const st = importStep(j)!;
  const finished = j.tasks.filter((x) => x.status !== "queued" && x.status !== "reading" && x.status !== "matching" && x.status !== "saving").length;
  const frac = st.of ? Math.min(1, (finished + (st.m ? st.n / st.m : 0)) / st.of) : 0;
  // "Playlist 3 di 12 · brani 40 di 85" (the songs once they are known).
  const songs = st.m ? t("oc.progressOne", { n: st.n, m: st.m }) : "";
  const label = st.of > 1 ? (st.m ? t("oc.progress", { i: st.i, of: st.of, n: st.n, m: st.m }) : t("oc.progressList", { i: st.i, of: st.of })) : songs || t("oc.adding");
  return (
    <div className="oc-progress">
      <div className="mt-progress oc-progress__bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(frac * 100)} aria-valuetext={label}>
        <div className="mt-progress__label">
          {label}
          {st.name && <span className="oc-progress__name"> · {st.name}</span>}
        </div>
        <div className="mt-progress__bar">
          <span style={{ width: `${frac * 100}%` }} />
        </div>
      </div>
      {cancel}
    </div>
  );
}

// ---- The liked songs' count and the Spotify account (cached for a few minutes) --------------

interface Extra {
  liked?: number;
  me: string | null;
}
const EXTRA_MS = 3 * 60_000;
let extraCache: { key: string; at: number; data: Extra } | null = null;

/** What the check needs besides the playlists (which La mia libreria already read): the liked songs' count, the account id. */
function useExtra(): { data: Extra | null; error: unknown; retry: () => void } {
  const auth = useSpotifyAuth();
  const key = auth.status === "in" ? spotifyUserToken() ?? "" : "";
  const hit = extraCache && extraCache.key === key && Date.now() - extraCache.at < EXTRA_MS ? extraCache.data : null;
  const [st, setSt] = useState<{ key: string; data: Extra | null; error: unknown }>({ key, data: hit, error: null });
  const [n, setN] = useState(0);
  useEffect(() => {
    if (!key) return;
    const c = extraCache;
    if (c && c.key === key && Date.now() - c.at < EXTRA_MS && n === 0) return setSt({ key, data: c.data, error: null });
    const ctrl = new AbortController();
    setSt({ key, data: null, error: null });
    Promise.all([likedTotal(ctrl.signal).catch((e) => (e instanceof SpotifyApiError && e.code === "aborted" ? Promise.reject(e) : undefined)), spotifyMe(ctrl.signal)]).then(
      ([liked, me]) => {
        if (ctrl.signal.aborted) return;
        const data = { liked, me };
        extraCache = { key, at: Date.now(), data };
        setSt({ key, data, error: null });
      },
      (error) => {
        if (ctrl.signal.aborted || (error instanceof SpotifyApiError && error.code === "aborted")) return;
        mlog("check: account read failed", { error: error instanceof SpotifyApiError ? error.code : String(error) }, "warn");
        setSt({ key, data: null, error });
      }
    );
    return () => ctrl.abort();
  }, [key, n]);
  const cur = st.key === key ? st : { data: hit, error: null };
  return {
    data: cur.data,
    error: cur.error,
    retry: () => {
      extraCache = null;
      setN((x) => x + 1);
    },
  };
}

/** The Spotify account id (the liked songs' source), once read; null while unknown. */
export function useSpotifyAccount(): string | null {
  return useExtra().data?.me ?? null;
}

/** Tests / sign-out: forget what was read. */
export function forgetCheckCache(): void {
  extraCache = null;
}

// ---- The check ---------------------------------------------------------------------------------

export function summaryText(sum: ReturnType<typeof checkSummary>, t: T): string {
  if (sum.complete) return t("oc.allAdded", { n: sum.total });
  const parts = [t("oc.some", { a: sum.added, n: sum.total })];
  if (sum.incomplete) parts.push(t("oc.sInc", { n: sum.incomplete }));
  if (sum.running) parts.push(t("oc.sRun", { n: sum.running }));
  if (sum.error) parts.push(t("oc.sErr", { n: sum.error }));
  if (sum.todo) parts.push(t("oc.sTodo", { n: sum.todo }));
  return parts.join(" · ");
}

const STATE_ICON = {
  added: <IconCheckCircle size={20} />,
  incomplete: <IconAlert size={20} />,
  error: <IconError size={20} />,
  todo: <IconPending size={20} />,
  running: <IconSpinner size={20} />,
} as const;

function CheckRowItem({ row, onOpen, spMe }: { row: CheckRow; onOpen: (id: string) => void; spMe: string | null }) {
  const { t, lang } = useT();
  const { me } = useMe();
  // Feedback at once: the click shows a spinner before the job store answers.
  const [clicked, setClicked] = useState(false);
  useEffect(() => setClicked(false), [row.state, row.task?.seq]);
  // The row's buttons change with its state: the focus, when it was on one, moves to the new one.
  const acts = useRef<HTMLSpanElement>(null);
  const hadFocus = useRef(false);
  const when = (ms: number) => new Date(ms).toLocaleString(lang === "en" ? "en-GB" : "it-IT", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
  const { entry, playlist, task } = row;
  const state = clicked && row.state !== "running" ? "running" : row.state;
  const label = t(`oc.${state === "todo" ? "todo" : state}`);
  const total = typeof entry.count === "number" ? entry.count : undefined;
  let detail = "";
  if (state === "running") {
    if (!task || task.status === "queued") detail = t("oc.queued");
    else if (task.m) detail = t("oc.progressOne", { n: task.n, m: task.m });
  } else if (state === "added" || state === "incomplete") {
    const songs = total !== undefined ? t("oc.songs", { have: row.have ?? 0, total }) : t("oc.songsN", { have: row.have ?? 0 });
    const synced = playlist?.source?.syncedAt ? t("oc.synced", { d: when(playlist.source.syncedAt) }) : "";
    detail = [songs, state === "incomplete" ? t("oc.missing", { n: row.missing ?? 0 }) : "", synced].filter(Boolean).join(" · ");
  } else if (state === "error") detail = importErrorText(task?.error, t);
  useEffect(() => {
    if (!hadFocus.current) return;
    const el = acts.current;
    if (!el || el.contains(document.activeElement)) return;
    if (document.activeElement && document.activeElement !== document.body) return void (hadFocus.current = false);
    el.querySelector<HTMLElement>("button")?.focus();
  }, [state]);
  const act = (run: () => void) => () => {
    hadFocus.current = true;
    setClicked(true);
    run();
  };
  return (
    <li className={`oc-row is-${state}`}>
      <span className="oc-row__icon" aria-hidden="true">
        {STATE_ICON[state]}
      </span>
      <span className="oc-row__main">
        <b className="oc-row__name">{entry.name}</b>
        <small>
          <span className="oc-row__state">{label}</span>
          {detail ? ` · ${detail}` : ""}
        </small>
      </span>
      <span className="oc-row__acts" ref={acts} onFocus={() => (hadFocus.current = true)} onBlur={(e) => !acts.current?.contains(e.relatedTarget as Node | null) && e.relatedTarget && (hadFocus.current = false)}>
        {state === "running" && (
          // Kept focusable (aria-disabled): the focus stays in the row while it runs.
          <button type="button" className="mt-pill mt-pill--sm" aria-disabled="true" aria-label={`${detail || t("oc.adding")}: ${entry.name}`}>
            <IconSpinner size={14} /> {!task || task.status === "queued" ? t("oc.queued") : t("oc.adding")}
          </button>
        )}
        {state === "incomplete" && playlist && (
          <button type="button" className="mt-pill mt-pill--sm" onClick={act(() => retryMissing(playlist, entry.key, me))} aria-label={`${t("oc.retryMissing")}: ${entry.name}`}>
            <IconRepeat size={14} /> {t("oc.retryMissing")}
          </button>
        )}
        {(state === "incomplete" || state === "added") && playlist && (
          <button type="button" className="mt-pill mt-pill--sm" onClick={() => onOpen(playlist.id)} aria-label={`${t("oc.view")}: ${entry.name}`}>
            {t("oc.view")}
          </button>
        )}
        {state === "error" && (
          <button type="button" className="mt-pill mt-pill--sm" onClick={act(() => addEntry(entry, me, spMe))} aria-label={`${t("oc.retry")}: ${entry.name}`}>
            <IconRepeat size={14} /> {t("oc.retry")}
          </button>
        )}
        {state === "todo" && (
          <button type="button" className="mt-pill mt-pill--sm mt-pill--solid" onClick={act(() => addEntry(entry, me, spMe))} aria-label={`${t("oc.add")}: ${entry.name}`}>
            <IconPlus size={14} /> {t("oc.add")}
          </button>
        )}
      </span>
    </li>
  );
}

/**
 * "Le tue playlist Spotify": the check, with the one button. Only when signed
 * in; `items`: the person's playlists as La mia libreria read them.
 */
export function SpotifyCheck({ items, onOpen }: { items: SpItem[]; onOpen: (playlistId: string) => void }) {
  const { t } = useT();
  const { playlists } = usePlaylists();
  const s = useImportState();
  const lists = useExtra();
  const likedName = t("spl.secLiked");
  const { entries, excluded } = useMemo(
    () => (lists.data ? entriesOf(items, { name: likedName, count: lists.data.liked }) : { entries: [] as SpEntry[], excluded: [] as SpItem[] }),
    [items, lists.data, likedName]
  );
  // Recomputed on every job step and every team playlist change (realtime).
  const rows = useMemo(() => checkRows(entries, playlists, s, lists.data?.me), [entries, playlists, s, lists.data?.me]);
  const sum = checkSummary(rows);
  const logged = useRef("");
  useEffect(() => {
    if (!lists.data) return;
    const k = `${sum.total}/${sum.added}/${sum.incomplete}/${sum.error}/${sum.todo}`;
    if (k === logged.current || sum.running) return;
    logged.current = k;
    mlog("check: status", sum);
  }, [lists.data, sum]);

  return (
    <section className="oc-check" aria-labelledby="oc-check-h">
      <div className="oc-check__head">
        <h2 id="oc-check-h" className="mt-h2 mt-h2--small">
          {t("oc.checkTitle")}
        </h2>
        <AddAllButton />
      </div>
      <ImportProgress />
      {lists.error ? (
        <div className="mp-note mt-err" role="alert">
          {spotifyErrorText(lists.error, t)}{" "}
          <button className="mt-pill mt-pill--sm" onClick={lists.retry}>
            {t("music.retry")}
          </button>
        </div>
      ) : !lists.data ? (
        <div className="spl-loading" role="status">
          <IconSpinner size={20} title={t("music.loading")} />
        </div>
      ) : (
        <>
          <p className={`oc-sum${sum.complete ? " is-ok" : ""}`} role="status" aria-live="polite">
            {sum.complete && <IconCheckCircle size={18} />} {rows.length ? summaryText(sum, t) : t("oc.none")}
          </p>
          {s.job?.listError && !s.job.running && (
            <p className="mp-note mt-err" role="alert">
              {t("oc.listError", { why: importErrorText(s.job.listError, t) })}
            </p>
          )}
          {rows.length > 0 && (
            <ul className="oc-list" aria-label={t("oc.listLabel")}>
              {rows.map((r) => (
                <CheckRowItem key={r.entry.key} row={r} onOpen={onOpen} spMe={lists.data?.me ?? null} />
              ))}
            </ul>
          )}
          {excluded.length > 0 && <p className="mt-hint oc-note">{t("oc.excluded", { n: excluded.length })}</p>}
        </>
      )}
      <p className="mt-hint oc-credit">{t("oc.credit")}</p>
    </section>
  );
}

/** The import-ending toasts, phrased (MusicTab shows them, with "Apri"). */
export function taskToast(task: { name: string; status: string; found?: number; missing?: number; error?: string; existed?: boolean; linked?: boolean }, t: T): { text: string; error: boolean } | null {
  if (task.status === "cancelled") return null;
  if (task.status === "error") return { text: t("oc.failed", { p: task.name, why: importErrorText(task.error, t) }), error: true };
  if (task.existed) return { text: t("oc.already", { p: task.name }), error: false };
  if (task.linked) return { text: t("oc.linkedDone", { p: task.name }), error: false };
  const n = task.found ?? 0;
  const m = task.missing ?? 0;
  return { text: m ? t("oc.done", { p: task.name, n, m }) : t("oc.doneAll", { p: task.name, n }), error: false };
}

/** Says a link cannot be added. */
export function toastLinkProblem(kind: "bad" | "busy", t: T): void {
  music.toast(t(kind === "bad" ? "oc.badLink" : "oc.busy"), kind === "bad" ? "error" : "info");
}
