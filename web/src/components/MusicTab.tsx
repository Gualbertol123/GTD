import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type KeyboardEvent, type RefObject } from "react";
import { createPortal } from "react-dom";
import { useT } from "../lib/i18n";
import { useMe } from "../lib/identity";
import { useRouteSub } from "../lib/history";
import {
  ARTISTS,
  coverOf,
  fetchCharts,
  fetchExplore,
  forgetMusicFailures,
  fetchMusicArtist,
  fetchSuggestions,
  fetchYtPlaylist,
  fetchSpotify,
  findYtPlaylists,
  getMusic,
  isSpotifyLink,
  matchSpotify,
  music,
  musicErrorText,
  playlistIdFrom,
  searchMusic,
  setDockRect,
  setMusic,
  sourceLabel,
  useLastRequest,
  useMusicSel,
  youtubeSearchUrl,
  type ChartArtist,
  type ChartList,
  type MusicErrorCode,
  type MusicFail,
  type Track,
  type SpotifyList,
  type YtPlaylist,
} from "../lib/music";
import {
  addToPlaylist,
  createPlaylist,
  deletePlaylist,
  insertInPlaylist,
  moveInPlaylist,
  reloadPlaylists,
  removeFromPlaylist,
  renamePlaylist,
  restorePlaylist,
  usePlaylist,
  usePlaylists,
  type Playlist,
  type WriteResult,
} from "../lib/musicDb";
import { countryName, isFail, parseView, rowKeys, viewSub, type View } from "../lib/musicTabRoute";
import { Cover, ModeSwitch, PlayButton, PremiumToggle, Progress } from "./MusicPlayer";
import { openSongMenu, playlistErrorText, songMenuProps, type SongMenuCtx } from "./SongMenu";
import {
  IconBack,
  IconBars,
  IconCheck,
  IconClose,
  IconDown,
  IconExternal,
  IconHome,
  IconImport,
  IconLink,
  IconMore,
  IconMute,
  IconNext,
  IconNote,
  IconPause,
  IconPlay,
  IconPlus,
  IconPrev,
  IconQueue,
  IconRepeat,
  IconSearch,
  IconShuffle,
  IconSpinner,
  IconTrend,
  IconUp,
  IconVolume,
} from "./MusicIcons";
import "../styles/musicTab.css";

// -----------------------------------------------------------------------------
// The MUSIC tab (desktop): a full music app around the same player.
//
//   sidebar   Home, Search, Import, the team's playlists
//   main      Home · Search · an artist · a playlist · an import
//   right     what is playing (cover, or the video in Video mode) and the queue
//   bottom    the player bar: song, controls, seek bar, music/video, volume
//
// The YouTube player itself stays in MusicPlayer (mounted once at the root);
// this tab drives it through lib/music and, in Video mode, tells it where to
// sit (setDockRect). The page lives in the URL (#/music/playlist/<id>, …), so
// Back returns to the previous music page.
//
// Every part reads only the bit of the music state it shows (useMusicSel), so
// the song changing re-renders two rows, not the page; only the seek bar
// follows the time.
// -----------------------------------------------------------------------------

type T = (key: string, vars?: Record<string, string | number>) => string;
/** Open a music page (a new history entry; `replace` rewrites this one). */
type Go = (v: View, opts?: { replace?: boolean }) => void;

// The page you were on, kept while you visit other tabs (until a reload).
let lastView: View = { kind: "home" };

export function MusicTab() {
  const { t } = useT();
  const [sub, setSub] = useRouteSub("music");
  const view = useMemo(() => parseView(sub), [sub]);
  const go = useCallback<Go>((v, opts) => setSub(viewSub(v) || undefined, opts), [setSub]);
  const { playlists, available, error: libError } = usePlaylists();
  const { me } = useMe();
  const [queueOpen, setQueueOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const bar = useRef<HTMLElement>(null);

  // Coming back to the tab (#/music): reopen the page you were on.
  useEffect(() => {
    if (!sub && lastView.kind !== "home") setSub(viewSub(lastView), { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    lastView = view;
  }, [view]);

  // While the tab is on screen it is the player's face.
  useEffect(() => {
    setMusic({ tab: true, warm: true });
    return () => {
      // Leaving the tab with music on: it carries on in the small player.
      setDockRect(null);
      setMusic({ tab: false, view: getMusic().source ? "mini" : "closed" });
    };
  }, []);

  // The tab fills the window below wherever the header ends (it may wrap).
  useLayoutEffect(() => {
    const el = root.current;
    if (!el) return;
    const fit = () => el.style.setProperty("--mt-top", `${Math.max(0, Math.round(el.getBoundingClientRect().top + window.scrollY))}px`);
    fit();
    const ro = new ResizeObserver(fit);
    if (el.parentElement) ro.observe(el.parentElement);
    window.addEventListener("resize", fit);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", fit);
    };
  }, []);

  useFollowPlayingPlaylist(playlists);

  // Library "+": the playlist exists at once; you type its name on its page.
  const newPlaylist = () => {
    const { playlist, saved } = createPlaylist(t("mt.newDefault"), me);
    renameOnOpen = playlist.id;
    go({ kind: "playlist", id: playlist.id });
    reportWrite(saved, t);
  };

  const job = useSpotifyJob();
  const onImport = view.kind === "import" || view.kind === "yt" || view.kind === "spotify";

  return (
    <div className={`mt${queueOpen ? " is-queue" : ""}`} ref={root}>
      <button className="mt-skip" onClick={() => bar.current?.focus()}>
        {t("mt.skip")}
      </button>
      <aside className="mt-side" aria-label={t("mt.sideLabel")}>
        <nav className="mt-box">
          <button className={`mt-nav${view.kind === "home" ? " is-on" : ""}`} aria-current={view.kind === "home" ? "page" : undefined} onClick={() => go({ kind: "home" })}>
            <IconHome size={22} /> {t("mt.home")}
          </button>
          <button className={`mt-nav${view.kind === "search" ? " is-on" : ""}`} aria-current={view.kind === "search" ? "page" : undefined} onClick={() => go({ kind: "search" })}>
            <IconSearch size={22} /> {t("mt.search")}
          </button>
          <button className={`mt-nav${onImport ? " is-on" : ""}`} aria-current={onImport ? "page" : undefined} onClick={() => go(job && job.phase === "matching" ? { kind: "spotify" } : { kind: "import" })}>
            <IconImport size={22} /> {t("mt.import")}
            {job?.phase === "matching" && job.list && (
              <span className="mt-navchip" aria-label={t("mt.importing", { n: job.done, m: job.list.songs.length })}>
                {job.done}/{job.list.songs.length}
              </span>
            )}
          </button>
        </nav>
        <div className="mt-box mt-lib">
          <div className="mt-lib__head">
            <span>{t("mt.library")}</span>
            <button className="mt-round" onClick={newPlaylist} title={t("mt.create")} aria-label={t("mt.create")} disabled={!available}>
              <IconPlus size={18} />
            </button>
          </div>
          <div className="mt-lib__list">
            {libError && libError !== "missing-table" && (
              <div className="mp-note mt-err" role="alert">
                {playlistErrorText(t("mt.libErr"), libError, t)}{" "}
                <button className="mt-pill mt-pill--sm" onClick={() => void reloadPlaylists()}>
                  {t("music.retry")}
                </button>
              </div>
            )}
            {playlists.map((p) => (
              <LibItem key={p.id} p={p} on={view.kind === "playlist" && view.id === p.id} go={go} />
            ))}
            {available && playlists.length === 0 && !libError && (
              <p className="mt-hint">
                {t("mt.libEmpty")}{" "}
                <button className="mt-link" onClick={() => go({ kind: "import" })}>
                  {t("mt.import")} →
                </button>
              </p>
            )}
            {!available && <p className="mt-hint">{t("mt.needMigration")}</p>}
          </div>
        </div>
      </aside>

      <main className="mt-main" aria-label={t("mt.mainLabel")}>
        {view.kind === "home" && <Home go={go} playlists={playlists} />}
        {view.kind === "search" && <Search initial={view.q} go={go} />}
        {view.kind === "import" && <ImportPage go={go} />}
        {view.kind === "spotify" && <SpotifyPage playlists={playlists} available={available} go={go} />}
        {view.kind === "yt" && <YtPlaylistPage key={view.list} list={view.list} playlists={playlists} available={available} go={go} />}
        {view.kind === "martist" && <MusicArtistPage key={view.id} id={view.id} name={view.name} />}
        {view.kind === "artist" && <ArtistPage key={view.name} name={view.name} />}
        {view.kind === "playlist" && <PlaylistPage key={view.id} id={view.id} go={go} />}
      </main>

      <NowPlaying open={queueOpen} onClose={() => setQueueOpen(false)} />
      <PlayerBar barRef={bar} queueOpen={queueOpen} onQueue={() => setQueueOpen((v) => !v)} />
      <AddMenuHost />
      <UndoHost />
    </div>
  );
}

const LibItem = memo(function LibItem({ p, on, go }: { p: Playlist; on: boolean; go: Go }) {
  const { t } = useT();
  return (
    <button className={`mt-libitem${on ? " is-on" : ""}`} aria-current={on ? "page" : undefined} onClick={() => go({ kind: "playlist", id: p.id })}>
      <Mosaic tracks={p.tracks} size={44} />
      <span>
        <b>{p.name}</b>
        <small>
          {t("mt.playlist")} · {p.owner || "—"} · {t("mt.songs").replace("{n}", String(p.tracks.length))}
        </small>
      </span>
    </button>
  );
});

/**
 * A team playlist that is playing gets the songs teammates (or you) add to it
 * appended to the queue. Nothing is reordered or removed while it plays.
 */
function useFollowPlayingPlaylist(playlists: Playlist[]) {
  const key = useMusicSel((s) => s.source?.key ?? null);
  const seen = useRef<{ key: string | null; ids: Set<string> }>({ key: null, ids: new Set() });
  useEffect(() => {
    const id = key?.startsWith("pl:") ? key.slice(3) : null;
    const p = id ? playlists.find((x) => x.id === id) : undefined;
    if (!p) {
      seen.current = { key, ids: new Set() };
      return;
    }
    if (seen.current.key !== key) {
      seen.current = { key, ids: new Set(p.tracks.map((x) => x.id)) };
      return;
    }
    const queued = new Set(getMusic().queue.map((x) => x.id));
    const added = p.tracks.filter((x) => !seen.current.ids.has(x.id) && !queued.has(x.id));
    seen.current.ids = new Set(p.tracks.map((x) => x.id));
    if (added.length) music.enqueue(added, "end", p.name);
  }, [key, playlists]);
}

// ---- Writes: optimistic, failures said in a toast, undo where it matters -------

/** The store already shows the change; only a failure (rolled back) is said. */
function reportWrite(p: Promise<WriteResult>, t: T): void {
  void p.then((r) => {
    if (!r.ok) music.toast(playlistErrorText(t("mt.notSaved"), r.error, t), "error");
  });
}

// An "Undo" pill (6 s) after a remove or a delete. Its own small store: the
// player's toast has no button.
type Undo = { id: number; text: string; run: () => void } | null;
let undo: Undo = null;
let undoSeq = 0;
const undoListeners = new Set<() => void>();
function setUndo(u: Undo) {
  undo = u;
  undoListeners.forEach((l) => l());
}
function showUndo(text: string, run: () => void) {
  const id = ++undoSeq;
  setUndo({ id, text, run });
  window.setTimeout(() => undo?.id === id && setUndo(null), 6000);
}
const subscribeUndo = (l: () => void) => {
  undoListeners.add(l);
  return () => {
    undoListeners.delete(l);
  };
};

function UndoHost() {
  const { t } = useT();
  const u = useSyncExternalStore(subscribeUndo, () => undo, () => undo);
  useEffect(() => () => setUndo(null), []);
  if (!u) return null;
  // Into <body>, like the player's toasts: a top-level glass layer.
  return createPortal(
    <div className="mp-toasts mt-undo" role="status" aria-live="polite">
      <div className="mp-toast">
        <span>{u.text}</span>
        <button
          className="mp-toast__btn"
          onClick={() => {
            setUndo(null);
            u.run();
          }}
        >
          {t("mt.undo")}
        </button>
      </div>
    </div>,
    document.body
  );
}

// ---- The "⋯" song menu and the "+" add-to-playlist menu --------------------------

type MenuCtx = SongMenuCtx;

/**
 * The one call into SongMenu's opener for "⋯" buttons:
 * openSongMenu(track, ctx, anchor). If its signature changes, fix it here.
 */
function openMoreMenu(track: Track, ctx: MenuCtx, anchor: HTMLElement): void {
  openSongMenu(track, ctx, anchor);
}

function MoreBtn({ track, ctx, size = 18 }: { track: Track; ctx: MenuCtx; size?: number }) {
  const { t } = useT();
  return (
    <button
      type="button"
      className="mt-iconbtn mt-more"
      aria-label={t("sm.more")}
      title={t("sm.more")}
      aria-haspopup="menu"
      onClick={(e) => {
        e.stopPropagation();
        openMoreMenu(track, ctx, e.currentTarget);
      }}
    >
      <IconMore size={size} />
    </button>
  );
}

// One "+" menu for the whole tab (not one per row), rendered into <body> so a
// scroll box never clips it.
type AddReq = { track: Track; anchor: HTMLElement } | null;
let addReq: AddReq = null;
const addListeners = new Set<() => void>();
function openAddMenu(r: AddReq) {
  addReq = r;
  addListeners.forEach((l) => l());
}
const subscribeAdd = (l: () => void) => {
  addListeners.add(l);
  return () => {
    addListeners.delete(l);
  };
};

function AddBtn({ track }: { track: Track }) {
  const { t } = useT();
  const open = useSyncExternalStore(subscribeAdd, () => addReq?.track === track, () => false);
  return (
    <button
      type="button"
      className="mt-iconbtn"
      title={t("mt.addTo")}
      aria-label={t("mt.addTo")}
      aria-haspopup="menu"
      aria-expanded={open}
      onClick={(e) => {
        e.stopPropagation();
        openAddMenu(open ? null : { track, anchor: e.currentTarget });
      }}
    >
      <IconPlus size={17} />
    </button>
  );
}

function AddMenuHost() {
  const r = useSyncExternalStore(subscribeAdd, () => addReq, () => null);
  useEffect(() => () => openAddMenu(null), []);
  return r ? createPortal(<AddMenu key={r.track.id} req={r} />, document.body) : null;
}

function AddMenu({ req }: { req: NonNullable<AddReq> }) {
  const { t } = useT();
  const { me } = useMe();
  const { playlists, available } = usePlaylists();
  const box = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState("");
  const tr = req.track;

  const close = (refocus = true) => {
    openAddMenu(null);
    if (refocus && req.anchor.isConnected) req.anchor.focus();
  };

  // Below the "+" (or above it when there is no room), inside the window.
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const a = req.anchor.getBoundingClientRect();
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    const left = Math.max(8, Math.min(a.right - w, window.innerWidth - w - 8));
    const below = a.bottom + 6;
    const top = below + h > window.innerHeight - 8 ? Math.max(8, a.top - h - 6) : below;
    setPos({ left, top });
  }, [req.anchor, naming]);

  // Once placed, focus the first choice (a hidden element can't take focus).
  useEffect(() => {
    if (!pos) return;
    const el = box.current;
    if (el && !el.contains(document.activeElement)) el.querySelector<HTMLElement>("input, [role=menuitem]:not(:disabled)")?.focus();
  }, [pos]);

  // A press outside, or the page scrolling under it, closes it.
  useEffect(() => {
    const down = (e: PointerEvent) => {
      if (!box.current?.contains(e.target as Node) && e.target !== req.anchor && !req.anchor.contains(e.target as Node)) close(false);
    };
    const scroll = (e: Event) => {
      if (box.current?.contains(e.target as Node)) return;
      if (box.current?.contains(document.activeElement) && document.activeElement?.tagName === "INPUT") return;
      close(false);
    };
    document.addEventListener("pointerdown", down, true);
    window.addEventListener("scroll", scroll, true);
    return () => {
      document.removeEventListener("pointerdown", down, true);
      window.removeEventListener("scroll", scroll, true);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [req]);

  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      if (naming) setNaming(false);
      else close();
      return;
    }
    if ((e.target as HTMLElement).tagName === "INPUT") return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp" || e.key === "Home" || e.key === "End") {
      e.preventDefault();
      const items = Array.from(box.current?.querySelectorAll<HTMLElement>("[role=menuitem]:not(:disabled)") ?? []);
      if (!items.length) return;
      const i = items.indexOf(document.activeElement as HTMLElement);
      const n =
        e.key === "Home" ? 0 : e.key === "End" ? items.length - 1 : e.key === "ArrowDown" ? (i + 1) % items.length : (i - 1 + items.length) % items.length;
      items[n].focus();
    }
    if (e.key === "Tab") close(false);
  };

  const add = (p: Playlist) => {
    close();
    music.toast(t("mt.added", { p: p.name }));
    reportWrite(addToPlaylist(p.id, tr), t);
  };
  const create = () => {
    const n = name.trim();
    if (!n) return;
    close();
    const { saved } = createPlaylist(n, me, [{ id: tr.id, title: tr.title, channel: tr.channel, thumb: tr.thumb }]);
    music.toast(t("mt.created", { p: n }));
    reportWrite(saved, t);
  };

  return (
    <div
      ref={box}
      className="mt-menu mt-menu--float"
      role="menu"
      aria-label={t("mt.addTo")}
      onKeyDown={onKey}
      style={pos ? { left: pos.left, top: pos.top } : { left: 0, top: 0, visibility: "hidden" }}
    >
      <div className="mt-menu__head">{t("mt.addTo")}</div>
      {playlists.map((p) => {
        const has = p.tracks.some((x) => x.id === tr.id);
        return (
          <button key={p.id} role="menuitem" disabled={has} onClick={() => add(p)}>
            <span>{p.name}</span>
            {has && <IconCheck size={14} />}
          </button>
        );
      })}
      {naming ? (
        <form
          className="mt-menu__name"
          onSubmit={(e) => {
            e.preventDefault();
            create();
          }}
        >
          <input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder={t("mt.newPh")} aria-label={t("mt.newPh")} maxLength={80} />
          <button type="submit" className="mt-pill mt-pill--solid mt-pill--sm" disabled={!name.trim()}>
            {t("mt.createBtn")}
          </button>
        </form>
      ) : (
        <button
          role="menuitem"
          className="mt-menu__new"
          disabled={!available}
          onClick={() => {
            setName("");
            setNaming(true);
          }}
        >
          <IconPlus size={15} /> {t("mt.create")}
        </button>
      )}
    </div>
  );
}

// ---- Bits -------------------------------------------------------------------

const GRADIENTS = [
  "linear-gradient(135deg,#5e5ce6,#bf5af2)",
  "linear-gradient(135deg,#0a84ff,#64d2ff)",
  "linear-gradient(135deg,#ff9f0a,#ff375f)",
  "linear-gradient(135deg,#30d158,#0a84ff)",
];
function gradientFor(name: string) {
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return GRADIENTS[h % GRADIENTS.length];
}

/** Enter or Space on an element that acts as a button (role="button"). */
function onActivate(run: () => void) {
  return (e: KeyboardEvent) => {
    if (e.target !== e.currentTarget) return;
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      run();
    }
  };
}

function ArtistAvatar({ name, size }: { name: string; size: number }) {
  const initials = name
    .split(/\s+/)
    .map((w) => w[0])
    .join("")
    .slice(0, 2);
  return (
    <span className="mt-avatar" style={{ width: size, height: size, background: gradientFor(name), fontSize: size * 0.36 }}>
      {initials}
    </span>
  );
}

/** A playlist's cover: its first four songs' pictures, or a note. */
const Mosaic = memo(function Mosaic({ tracks, size }: { tracks: Track[]; size: number }) {
  const pics = tracks.slice(0, 4).map((t) => coverOf(t.id));
  if (pics.length === 0)
    return (
      <span className="mt-mosaic mt-mosaic--empty" style={{ width: size, height: size }}>
        <IconNote size={Math.max(18, size * 0.36)} />
      </span>
    );
  if (pics.length < 4)
    return (
      <span className="mt-mosaic" style={{ width: size, height: size, display: "inline-grid" }}>
        <Cover src={pics[0]} className="mt-mosaic__one" />
      </span>
    );
  return (
    <span className="mt-mosaic mt-mosaic--grid" style={{ width: size, height: size }}>
      {pics.map((p, i) => (
        <Cover key={i} src={p} />
      ))}
    </span>
  );
});

function greeting(t: T) {
  const h = new Date().getHours();
  return h < 13 ? t("m.hello.morning") : h < 18 ? t("m.hello.afternoon") : t("m.hello.evening");
}

/** What went wrong, in words, with Riprova and (for a search) YouTube's own search. */
function ErrorNote({ code, q, onRetry }: { code: string; q?: string; onRetry?: () => void }) {
  const { t } = useT();
  if (code === "aborted") return null;
  return (
    <div className="mp-note mt-err" role="alert" title={code}>
      <span>{musicErrorText(code, t)}</span>
      {onRetry && (
        <button
          className="mt-pill mt-pill--sm"
          onClick={() => {
            forgetMusicFailures();
            onRetry();
          }}
        >
          <IconRepeat size={14} /> {t("music.retry")}
        </button>
      )}
      {q?.trim() && (
        <a href={youtubeSearchUrl(q)} target="_blank" rel="noopener noreferrer">
          {t("music.openYt")} <IconExternal size={13} />
        </a>
      )}
    </div>
  );
}

/**
 * A list's big gold Play: pause / resume when this list (by key) is the one
 * playing, else start it. The icon flips on the click; a ring turns while
 * YouTube loads.
 */
function ListPlay({ srcKey, start, disabled, label }: { srcKey: string; start: () => void; disabled?: boolean; label?: string }) {
  const { t } = useT();
  const mine = useMusicSel((s) => !!srcKey && s.source?.key === srcKey);
  const playing = useMusicSel((s) => s.playing);
  const busy = useMusicSel((s) => s.playing && (s.status === "loading" || s.status === "buffering"));
  const on = mine && playing;
  return (
    <button
      className={`mt-play mt-play--big${mine && busy ? " is-busy" : ""}`}
      disabled={disabled}
      aria-label={`${on ? t("music.pause") : t("music.play")}${label ? ` ${label}` : ""}`}
      aria-busy={mine && busy}
      onClick={() => (mine ? music.toggle() : start())}
    >
      {on ? <IconPause size={24} /> : <IconPlay size={24} />}
      {mine && busy && <IconSpinner className="mp-busy-ring" size={80} title={t("music.loading")} />}
    </button>
  );
}

/** A section's data: loaded (and aborted on leaving), with a retry. */
function useLoad<D>(load: (signal: AbortSignal) => Promise<D | MusicFail>, deps: unknown[]): { data: D | null; error: MusicErrorCode | null; retry: () => void } {
  const [n, setN] = useState(0);
  const [state, setState] = useState<{ data: D | null; error: MusicErrorCode | null }>({ data: null, error: null });
  useEffect(() => {
    const ctrl = new AbortController();
    setState((s) => (s.data === null && s.error === null ? s : { data: null, error: null }));
    void load(ctrl.signal).then((r) => {
      if (ctrl.signal.aborted) return;
      if (isFail(r)) {
        if (r.error !== "aborted") setState({ data: null, error: r.error as MusicErrorCode });
      } else setState({ data: r as D, error: null });
    });
    return () => ctrl.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, n]);
  const retry = useCallback(() => setN((x) => x + 1), []);
  return { ...state, retry };
}

// ---- Home ---------------------------------------------------------------------

/** The countries offered for charts on the home ("ZZ" = the world). */
const COUNTRIES = ["IT", "ZZ", "ES", "US", "MX", "GB", "FR", "BR"];

function Home({ go, playlists }: { go: Go; playlists: Playlist[] }) {
  const { t, lang } = useT();
  const [country, setCountry] = useState(() => {
    try {
      return sessionStorage.getItem("gtd-music-country") || "IT";
    } catch {
      return "IT";
    }
  });
  const pickCountry = (c: string) => {
    setCountry(c);
    try {
      sessionStorage.setItem("gtd-music-country", c);
    } catch {
      /* fine */
    }
  };
  const explore = useLoad((signal) => fetchExplore({ signal }), []);
  const charts = useLoad((signal) => fetchCharts(country, { signal }), [country]);
  const trends = explore.data?.sections?.[0];
  const fresh = explore.data?.sections?.slice(1) ?? [];
  const trendLabel = trends?.title ?? t("mt.trends");
  const playingTrends = useMusicSel((s) => s.source?.key === "trends" && s.playing);
  const mixOn = useMusicSel((s) => s.source?.kind === "mix");
  const mixPlaying = useMusicSel((s) => s.source?.kind === "mix" && s.playing);

  // The trends tile works while they load: the click is kept and plays them on arrival.
  const [wantTrends, setWantTrends] = useState(false);
  const playTrends = useCallback(() => {
    if (trends) music.play({ kind: "videos", label: trendLabel, key: "trends", tracks: trends.tracks, start: 0 });
  }, [trends, trendLabel]);
  useEffect(() => {
    if (wantTrends && trends) {
      setWantTrends(false);
      playTrends();
    }
  }, [wantTrends, trends, playTrends]);
  useEffect(() => {
    if (explore.error) setWantTrends(false);
  }, [explore.error]);

  const bothFailed = !!explore.error && !!charts.error;

  return (
    <div className="mt-page">
      <div className="mt-hero" style={{ background: "linear-gradient(180deg, rgba(94,92,230,.45), transparent)" }}>
        <h1>{greeting(t)}</h1>
        <p className="mt-hint" style={{ margin: "4px 0 0" }}>
          {t("mt.homeIntro")}
        </p>
      </div>

      <div className="mt-quick">
        <button
          className="mt-qtile"
          aria-busy={wantTrends}
          onPointerDown={music.warm}
          onClick={() => (playingTrends ? music.toggle() : trends ? playTrends() : explore.error ? explore.retry() : setWantTrends(true))}
        >
          <span className="mt-qtile__art mt-glyph" style={{ background: "linear-gradient(135deg,#ff375f,#ff9f0a)" }}>
            {(!trends && !explore.error) || wantTrends ? <IconSpinner size={26} /> : <IconTrend size={28} />}
          </span>
          <b>{trendLabel}</b>
          <PlayFab on={playingTrends} />
        </button>
        {charts.data?.lists?.slice(0, 2).map((l) => (
          <button key={l.list} className="mt-qtile" onClick={() => go({ kind: "yt", list: l.list })}>
            <Cover src={l.thumb} className="mt-qtile__img" />
            <b>{l.title}</b>
          </button>
        ))}
        {playlists.slice(0, 5).map((p) => (
          <button key={p.id} className="mt-qtile" onClick={() => go({ kind: "playlist", id: p.id })}>
            <Mosaic tracks={p.tracks} size={56} />
            <b>{p.name}</b>
          </button>
        ))}
      </div>

      {/* One message when YouTube answered neither. */}
      {bothFailed && (
        <ErrorNote
          code={explore.error!}
          onRetry={() => {
            explore.retry();
            charts.retry();
          }}
        />
      )}

      {/* Trends: the songs, playable straight away. */}
      <div className="mt-h2row">
        <h2 className="mt-h2">{trendLabel}</h2>
        {trends && (
          <button className="mt-pill mt-pill--solid" onClick={playTrends}>
            <IconPlay size={15} /> {t("mt.playAll")}
          </button>
        )}
      </div>
      {explore.error && !bothFailed && <ErrorNote code={explore.error} onRetry={explore.retry} />}
      {!trends && !explore.error && <div className="mt-spin mt-spin--block" />}
      {trends && <TrackGrid tracks={trends.tracks.slice(0, 12)} label={trendLabel} srcKey="trends" />}

      {/* Charts: country picker + the chart playlists + most listened artists. */}
      <div className="mt-h2row">
        <h2 className="mt-h2">{t("mt.charts")}</h2>
      </div>
      <div className="mt-chips" style={{ marginTop: 0 }}>
        {COUNTRIES.map((c) => (
          <button key={c} className={`mt-chip${country === c ? " is-on" : ""}`} aria-pressed={country === c} onClick={() => pickCountry(c)}>
            {countryName(c, lang, t("mt.world"))}
          </button>
        ))}
      </div>
      {!charts.data && !charts.error && <div className="mt-spin mt-spin--block" />}
      {charts.error && !bothFailed && <ErrorNote code={charts.error} onRetry={charts.retry} />}
      {charts.data?.lists && <ChartCards lists={charts.data.lists} go={go} />}

      <h2 className="mt-h2">{t("mt.teamPlaylists")}</h2>
      {playlists.length === 0 ? (
        <p className="mt-hint">
          {t("mt.noPlaylists")}{" "}
          <button className="mt-link" onClick={() => go({ kind: "import" })}>
            {t("mt.importCta")}
          </button>
        </p>
      ) : (
        <div className="mt-cards">
          {playlists.map((p) => (
            <PlaylistCard key={p.id} p={p} go={go} />
          ))}
        </div>
      )}

      {charts.data?.artists && charts.data.artists.length > 0 && (
        <>
          <h2 className="mt-h2">
            {t("mt.topArtists")} · {countryName(country, lang, t("mt.world"))}
          </h2>
          <div className="mt-cards">
            {charts.data.artists.slice(0, 12).map((a) => (
              <ChartArtistCard key={a.id} artist={a} go={go} />
            ))}
          </div>
        </>
      )}

      {fresh.map((sec) => (
        <div key={sec.title}>
          <h2 className="mt-h2">{sec.title}</h2>
          <TrackCards tracks={sec.tracks.slice(0, 12)} label={sec.title} srcKey={`explore:${sec.title}`} />
        </div>
      ))}

      <h2 className="mt-h2">{t("mt.teamArtists")}</h2>
      <div className="mt-chips" style={{ marginTop: 0 }}>
        <button
          className={`mt-chip${mixOn ? " is-on" : ""}`}
          aria-pressed={mixOn}
          onPointerDown={music.warm}
          onClick={() => (mixOn ? music.toggle() : music.play({ kind: "mix" }))}
        >
          {mixPlaying ? <IconPause size={14} /> : <IconPlay size={14} />} {t("music.mix")}
        </button>
        {ARTISTS.map((a) => (
          <button key={a.name} className="mt-chip" onClick={() => go({ kind: "artist", name: a.name })}>
            {a.name}
          </button>
        ))}
      </div>
    </div>
  );
}

const PlaylistCard = memo(function PlaylistCard({ p, go }: { p: Playlist; go: Go }) {
  const { t } = useT();
  const open = () => go({ kind: "playlist", id: p.id });
  return (
    <div className="mt-card" onClick={open} onKeyDown={onActivate(open)} role="button" tabIndex={0} aria-label={p.name}>
      <div className="mt-card__art">
        <Mosaic tracks={p.tracks} size={150} />
        {p.tracks.length > 0 && (
          <button
            className="mt-play mt-play--float"
            aria-label={`${t("music.play")} ${p.name}`}
            onPointerDown={music.warm}
            onClick={(e) => {
              e.stopPropagation();
              music.play({ kind: "videos", label: p.name, key: `pl:${p.id}`, tracks: p.tracks, start: 0 });
            }}
          >
            <IconPlay size={18} />
          </button>
        )}
      </div>
      <b>{p.name}</b>
      <small>
        {p.owner || "—"} · {t("mt.songs").replace("{n}", String(p.tracks.length))}
      </small>
    </div>
  );
});

/** Songs as a compact two-column grid (number, cover, title), playable. */
const TrackGrid = memo(function TrackGrid({ tracks, label, srcKey }: { tracks: Track[]; label: string; srcKey: string }) {
  const nowId = useMusicSel((s) => s.now?.id ?? null);
  const keys = useMemo(() => rowKeys(tracks), [tracks]);
  const play = useCallback((i: number) => music.play({ kind: "videos", label, key: srcKey, tracks, start: i }), [tracks, label, srcKey]);
  return (
    <div className="mt-tgrid">
      {tracks.map((tr, i) => (
        <GridRow key={keys[i]} tr={tr} i={i} on={nowId === tr.id} tracks={tracks} label={label} srcKey={srcKey} play={play} />
      ))}
    </div>
  );
});

const GridRow = memo(function GridRow({
  tr,
  i,
  on,
  tracks,
  label,
  srcKey,
  play,
}: {
  tr: Track;
  i: number;
  on: boolean;
  tracks: Track[];
  label: string;
  srcKey: string;
  play: (i: number) => void;
}) {
  const { t } = useT();
  const ctx: MenuCtx = { list: { tracks, label, index: i, key: srcKey } };
  return (
    <div className={`mt-trow${on ? " is-on" : ""}`} {...songMenuProps(tr, ctx)}>
      <span className="mt-trow__n">{i + 1}</span>
      <button className="mt-trow__main" onPointerDown={music.warm} onClick={() => play(i)} aria-label={`${t("music.play")} ${tr.title}`} aria-current={on ? "true" : undefined}>
        <Cover id={tr.id} src={tr.thumb} className="mt-img40" />
        <span>
          <b>{tr.title}</b>
          <small>{tr.channel}</small>
        </span>
      </button>
      <MoreBtn track={tr} ctx={ctx} />
    </div>
  );
});

/** Songs as cards (cover, title, artist), playable. */
const TrackCards = memo(function TrackCards({ tracks, label, srcKey }: { tracks: Track[]; label: string; srcKey: string }) {
  const { t } = useT();
  const keys = useMemo(() => rowKeys(tracks), [tracks]);
  return (
    <div className="mt-cards">
      {tracks.map((tr, i) => {
        const play = () => music.play({ kind: "videos", label, key: srcKey, tracks, start: i });
        const ctx: MenuCtx = { list: { tracks, label, index: i, key: srcKey } };
        return (
          <div
            key={keys[i]}
            className="mt-card"
            onClick={play}
            onKeyDown={onActivate(play)}
            onPointerDown={music.warm}
            role="button"
            tabIndex={0}
            aria-label={`${t("music.play")} ${tr.title}, ${tr.channel}`}
            {...songMenuProps(tr, ctx)}
          >
            <div className="mt-card__art mt-card__art--wide">
              <Cover id={tr.id} src={tr.thumb} className="mt-card__img" />
              <span className="mt-play mt-play--float" aria-hidden="true">
                <IconPlay size={18} />
              </span>
              <span className="mt-card__more">
                <MoreBtn track={tr} ctx={ctx} />
              </span>
            </div>
            <b title={tr.title}>{tr.title}</b>
            <small>{tr.channel}</small>
          </div>
        );
      })}
    </div>
  );
});

const ChartCards = memo(function ChartCards({ lists, go }: { lists: ChartList[]; go: Go }) {
  return (
    <div className="mt-cards">
      {lists.map((l) => {
        const open = () => go({ kind: "yt", list: l.list });
        return (
          <div key={l.list} className="mt-card" onClick={open} onKeyDown={onActivate(open)} role="button" tabIndex={0} aria-label={l.title}>
            <div className="mt-card__art">
              <Cover src={l.thumb} className="mt-card__img" />
            </div>
            <b title={l.title}>{l.title}</b>
            <small>YouTube Music</small>
          </div>
        );
      })}
    </div>
  );
});

const ChartArtistCard = memo(function ChartArtistCard({ artist, go }: { artist: ChartArtist; go: Go }) {
  const { t } = useT();
  const open = () => go({ kind: "martist", id: artist.id, name: artist.name });
  return (
    <div className="mt-card" onClick={open} onKeyDown={onActivate(open)} role="button" tabIndex={0} aria-label={artist.name}>
      <div className="mt-card__art mt-card__art--round">
        {artist.thumb ? <Cover src={artist.thumb} className="mt-card__img mt-card__img--round" /> : <ArtistAvatar name={artist.name} size={150} />}
      </div>
      <b>{artist.name}</b>
      <small>{t("mt.artist")}</small>
    </div>
  );
});

function PlayFab({ on }: { on: boolean }) {
  return <span className={`mt-play mt-play--tile${on ? " is-on" : ""}`}>{on ? <IconPause size={16} /> : <IconPlay size={16} />}</span>;
}

// ---- Search -------------------------------------------------------------------

const GENRES = ["Pop latino", "Cantautori italiani", "Reggaeton", "Ballate", "Anni 2000", "Flamenco pop", "Dance", "Acoustic"];

// The last results, so coming back to Search (or Back) shows them again.
let lastSearch: { query: string; tracks: Track[] } | null = null;

function Search({ initial, go }: { initial?: string; go: Go }) {
  const { t } = useT();
  const [q, setQ] = useState(initial ?? "");
  const [busy, setBusy] = useState(false);
  // The results and the words that produced them (not the live input).
  const [res, setRes] = useState<{ query: string; tracks: Track[] } | null>(() => (lastSearch && (!initial || lastSearch.query === initial) ? lastSearch : null));
  const [error, setError] = useState<{ query: string; code: MusicErrorCode } | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const req = useLastRequest();
  const [sugs, setSugs] = useState<string[]>([]);
  const [showSugs, setShowSugs] = useState(false);
  const [active, setActive] = useState(-1);

  // Suggestions while typing (free), a moment after the last key; an older
  // answer never replaces a newer one.
  useEffect(() => {
    const text = q.trim();
    setActive(-1);
    if (text.length < 2) {
      setSugs([]);
      return;
    }
    const ctrl = new AbortController();
    const id = setTimeout(() => {
      void fetchSuggestions(text, { signal: ctrl.signal }).then((s) => {
        if (!ctrl.signal.aborted) setSugs(s);
      });
    }, 200);
    return () => {
      clearTimeout(id);
      ctrl.abort();
    };
  }, [q]);

  const run = async (words: string) => {
    setShowSugs(false);
    const w = words.trim();
    if (!w) return;
    const signal = req.next();
    setBusy(true);
    // The words go in the address (shareable), without piling up history.
    go({ kind: "search", q: w }, { replace: true });
    const r = await searchMusic(w, { signal });
    if (signal.aborted || (isFail(r) && r.error === "aborted")) return;
    setBusy(false);
    if (isFail(r)) {
      setError({ query: w, code: r.error });
      setRes(null);
    } else {
      setError(null);
      setRes((lastSearch = { query: w, tracks: r.tracks }));
    }
  };

  // Opened on a search address (#/music/search/<words>): run it.
  useEffect(() => {
    if (initial && res?.query !== initial) void run(initial);
    else input.current?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const open = showSugs && sugs.length > 0;
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Escape") {
      if (open) e.preventDefault();
      setShowSugs(false);
      return;
    }
    if (!sugs.length) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      setShowSugs(true);
      setActive((a) => (e.key === "ArrowDown" ? (a + 1) % sugs.length : a <= 0 ? sugs.length - 1 : a - 1));
    } else if (e.key === "Enter" && open && active >= 0) {
      e.preventDefault();
      setQ(sugs[active]);
      void run(sugs[active]);
    }
  };

  return (
    <div className="mt-page">
      <form
        className="mt-search"
        role="search"
        onSubmit={(e) => {
          e.preventDefault();
          void run(q);
        }}
      >
        <span aria-hidden="true" className="mt-search__icon">
          <IconSearch size={20} />
        </span>
        <input
          ref={input}
          value={q}
          role="combobox"
          aria-expanded={open}
          aria-controls="mt-sugs"
          aria-autocomplete="list"
          aria-activedescendant={open && active >= 0 ? `mt-sug-${active}` : undefined}
          onChange={(e) => {
            setQ(e.target.value);
            setShowSugs(true);
          }}
          onFocus={() => setShowSugs(true)}
          onBlur={() => setTimeout(() => setShowSugs(false), 150)}
          onKeyDown={onKey}
          placeholder={t("mt.searchPh")}
          aria-label={t("mt.search")}
          autoComplete="off"
        />
        {busy && <IconSpinner size={20} className="mt-search__spin" title={t("music.loading")} />}
        {open && (
          <div className="mt-sugs" role="listbox" id="mt-sugs" aria-label={t("mt.search")}>
            {sugs.map((sg, i) => (
              <button
                key={sg}
                id={`mt-sug-${i}`}
                type="button"
                role="option"
                tabIndex={-1}
                aria-selected={i === active}
                className={i === active ? "is-active" : undefined}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  setQ(sg);
                  void run(sg);
                }}
              >
                <IconSearch size={16} /> {sg}
              </button>
            ))}
          </div>
        )}
      </form>
      {error && <ErrorNote code={error.code} q={error.query} onRetry={() => void run(error.query)} />}
      {res &&
        (res.tracks.length ? (
          <>
            <h2 className="mt-h2 mt-h2--small">{t("mt.results", { q: res.query })}</h2>
            <TrackTable tracks={res.tracks} label={res.query} srcKey={`search:${res.query.toLowerCase()}`} />
          </>
        ) : (
          <p className="mt-hint">{t("music.noResults")}</p>
        ))}
      {!res && !error && (
        <>
          <h2 className="mt-h2">{t("mt.browse")}</h2>
          <div className="mt-genres">
            {GENRES.map((g, i) => (
              <button
                key={g}
                className="mt-genre"
                style={{ background: GRADIENTS[i % GRADIENTS.length] }}
                onClick={() => {
                  setQ(g);
                  void run(g);
                }}
              >
                {g}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

// ---- Import ------------------------------------------------------------------

/** Searches suggested on the Import page; the first three run on their own. */
const SUGGESTED = [
  "Enrique Iglesias greatest hits",
  "Ricky Martin greatest hits",
  "Tiziano Ferro best of",
  "Latin pop hits",
  "Hit italiane",
  "Reggaeton classics",
  "Ballate romantiche",
  "Pop anni 2000",
  "Musica per concentrarsi",
];

function ImportPage({ go }: { go: Go }) {
  const { t } = useT();
  const [link, setLink] = useState("");
  const [linkError, setLinkError] = useState(false);
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);
  const [found, setFound] = useState<{ title: string; lists: YtPlaylist[] } | null>(null);
  const [error, setError] = useState<{ q: string; code: MusicErrorCode } | null>(null);
  const req = useLastRequest();

  // "For your artists": the top lists for each favourite, from the day's cache.
  const picks = useLoad(
    async (signal) => {
      const rs = await Promise.all(SUGGESTED.slice(0, 3).map((s) => findYtPlaylists(s, true, { signal })));
      const lists = rs.flatMap((r) => ("lists" in r ? r.lists.slice(0, 4) : []));
      const err = rs.find((r): r is MusicFail => isFail(r));
      return lists.length || !err ? { lists } : err;
    },
    []
  );

  const run = async (words: string) => {
    const w = words.trim();
    if (!w) return;
    setQ(words);
    const signal = req.next();
    setBusy(true);
    const r = await findYtPlaylists(w, SUGGESTED.includes(words), { signal });
    if (signal.aborted || (isFail(r) && r.error === "aborted")) return;
    setBusy(false);
    if (isFail(r)) {
      setError({ q: w, code: r.error });
    } else {
      setError(null);
      setFound({ title: w, lists: r.lists });
    }
  };

  return (
    <div className="mt-page">
      <div className="mt-hero" style={{ background: "linear-gradient(180deg, rgba(255,55,95,.4), transparent)" }}>
        <h1>{t("mt.import")}</h1>
        <p className="mt-hint" style={{ margin: "6px 0 0" }}>
          {t("mt.importIntro")}
        </p>
      </div>

      <button className="mt-spotify" onClick={() => go({ kind: "spotify" })}>
        <span className="mt-spotify__icon" aria-hidden="true">
          <IconImport size={22} />
        </span>
        <span>
          <b>{t("sp.button")}</b>
          <small>{t("sp.buttonHint")}</small>
        </span>
      </button>

      <form
        className="mt-search mt-search--static"
        onSubmit={(e) => {
          e.preventDefault();
          if (isSpotifyLink(link)) {
            void startSpotify(link.trim());
            return go({ kind: "spotify" });
          }
          const list = playlistIdFrom(link);
          if (!list) return setLinkError(true);
          setLinkError(false);
          go({ kind: "yt", list });
        }}
      >
        <span aria-hidden="true" className="mt-search__icon">
          <IconLink size={20} />
        </span>
        <input
          value={link}
          onChange={(e) => {
            setLink(e.target.value);
            setLinkError(false);
          }}
          placeholder={t("mt.linkPh")}
          aria-label={t("mt.linkPh")}
          aria-invalid={linkError}
        />
        <button type="submit" className="mt-pill mt-pill--solid" disabled={!link.trim()}>
          {t("mt.open")}
        </button>
      </form>
      {linkError && (
        <div className="mp-note" role="alert">
          {t("mt.badLink")}
        </div>
      )}

      <form
        className="mt-search mt-search--static"
        onSubmit={(e) => {
          e.preventDefault();
          void run(q);
        }}
      >
        <span aria-hidden="true" className="mt-search__icon">
          <IconSearch size={20} />
        </span>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("mt.findPh")} aria-label={t("mt.findPh")} />
        {busy && <IconSpinner size={20} className="mt-search__spin" title={t("music.loading")} />}
      </form>
      <div className="mt-chips">
        {SUGGESTED.map((s) => (
          <button key={s} className={`mt-chip${found?.title === s ? " is-on" : ""}`} aria-pressed={found?.title === s} onClick={() => void run(s)}>
            {s}
          </button>
        ))}
      </div>

      {error && <ErrorNote code={error.code} q={error.q} onRetry={() => void run(error.q)} />}

      {found && (
        <>
          <h2 className="mt-h2">{found.title}</h2>
          {found.lists.length ? <ListCards lists={found.lists} go={go} /> : <p className="mt-hint">{t("music.noResults")}</p>}
        </>
      )}

      <h2 className="mt-h2">{t("mt.forArtists")}</h2>
      {picks.error && <ErrorNote code={picks.error} onRetry={picks.retry} />}
      {!picks.data && !picks.error && <div className="mt-spin mt-spin--block" />}
      {picks.data && <ListCards lists={picks.data.lists} go={go} />}
    </div>
  );
}

const ListCards = memo(function ListCards({ lists, go }: { lists: YtPlaylist[]; go: Go }) {
  return (
    <div className="mt-cards">
      {lists.map((l) => {
        const open = () => go({ kind: "yt", list: l.list });
        return (
          <div key={l.list} className="mt-card" onClick={open} onKeyDown={onActivate(open)} role="button" tabIndex={0} aria-label={l.title}>
            <div className="mt-card__art">
              <Cover src={l.thumb} className="mt-card__img" />
            </div>
            <b title={l.title}>{l.title}</b>
            <small>{l.channel || "YouTube"}</small>
          </div>
        );
      })}
    </div>
  );
});

// ---- Importa da Spotify: the job outlives the page ------------------------------
//
// Reading the list and finding each song on YouTube takes a while. The job
// lives here, outside the page: leaving the page lets it carry on (the
// sidebar's Import shows "12/34"), and coming back shows where it is.

interface SpJob {
  url: string;
  phase: "reading" | "matching" | "done" | "error";
  error: string | null;
  list: SpotifyList | null;
  done: number;
  matches: (Track | null)[];
}
let spJob: SpJob | null = null;
let spCtrl: AbortController | null = null;
const spListeners = new Set<() => void>();
function setSp(j: SpJob | null) {
  spJob = j;
  spListeners.forEach((l) => l());
}
const subscribeSp = (l: () => void) => {
  spListeners.add(l);
  return () => {
    spListeners.delete(l);
  };
};
function useSpotifyJob(): SpJob | null {
  return useSyncExternalStore(subscribeSp, () => spJob, () => spJob);
}

async function startSpotify(url: string): Promise<void> {
  spCtrl?.abort();
  const ctrl = new AbortController();
  spCtrl = ctrl;
  const mine = () => spCtrl === ctrl;
  if (!isSpotifyLink(url)) return setSp({ url, phase: "error", error: "bad-link", list: null, done: 0, matches: [] });
  setSp({ url, phase: "reading", error: null, list: null, done: 0, matches: [] });
  const r = await fetchSpotify(url, { signal: ctrl.signal });
  if (!mine() || !spJob) return;
  if (isFail(r)) {
    if (r.error !== "aborted") setSp({ ...spJob, phase: "error", error: r.error });
    return;
  }
  setSp({ ...spJob, list: r, phase: "matching" });
  const found = await matchSpotify(r.songs, (n) => mine() && spJob && setSp({ ...spJob, done: n }), () => !mine(), { signal: ctrl.signal });
  if (!mine() || !spJob) return;
  setSp({ ...spJob, matches: found, done: r.songs.length, phase: "done" });
}

/** Ask YouTube once more for the songs not found. */
async function retrySpotifyMissing(): Promise<void> {
  const j = spJob;
  if (!j?.list || j.phase !== "done") return;
  const idx = j.list.songs.map((_, i) => i).filter((i) => !j.matches[i]);
  if (!idx.length) return;
  const ctrl = new AbortController();
  spCtrl?.abort();
  spCtrl = ctrl;
  const mine = () => spCtrl === ctrl;
  const base = j.list.songs.length - idx.length;
  setSp({ ...j, phase: "matching", done: base });
  const found = await matchSpotify(
    idx.map((i) => j.list!.songs[i]),
    (n) => mine() && spJob && setSp({ ...spJob, done: base + n }),
    () => !mine(),
    { signal: ctrl.signal }
  );
  if (!mine() || !spJob) return;
  const matches = j.matches.slice();
  idx.forEach((i, k) => (matches[i] = found[k] ?? null));
  setSp({ ...spJob, matches, done: j.list.songs.length, phase: "done" });
}

function SpotifyPage({ playlists, available, go }: { playlists: Playlist[]; available: boolean; go: Go }) {
  const { t } = useT();
  const { me } = useMe();
  const job = useSpotifyJob();
  const [link, setLink] = useState(job?.url ?? "");

  const list = job?.list ?? null;
  const phase = job?.phase ?? "idle";
  const matches = useMemo(() => job?.matches ?? [], [job?.matches]);
  const tracks = useMemo(() => matches.filter((m): m is Track => !!m), [matches]);
  const missing = list && phase === "done" ? list.songs.filter((_, i) => !matches[i]) : [];
  const label = list?.name ?? "Spotify";
  const srcKey = list ? `sp:${list.id}` : "";
  const saved = list && playlists.find((p) => p.name === list.name && p.tracks[0]?.id === tracks[0]?.id);
  const error = job?.error ?? null;
  const busy = phase === "reading" || phase === "matching";

  const save = () => {
    if (!list) return;
    const { playlist, saved: done } = createPlaylist(list.name, me, tracks);
    music.toast(t("mt.created", { p: list.name }));
    reportWrite(done, t);
    go({ kind: "playlist", id: playlist.id });
  };

  return (
    <div className="mt-page">
      <button className="mt-link" onClick={() => go({ kind: "import" })}>
        <IconBack size={15} /> {t("mt.import")}
      </button>
      <div className="mt-hero mt-hero--artist mt-hero--spotify">
        {list?.cover ? (
          <Cover src={list.cover} className="mt-hero__img" />
        ) : (
          <span className="mt-hero__img mt-spotify__big" aria-hidden="true">
            <IconImport size={56} />
          </span>
        )}
        <div>
          <small>{list ? t(list.kind === "album" ? "sp.album" : "sp.playlist") : t("sp.button")}</small>
          <h1>{list?.name ?? t("sp.title")}</h1>
          <small>{list ? `${list.owner} · ${t("mt.songs").replace("{n}", String(list.songs.length))}` : t("sp.intro")}</small>
        </div>
      </div>

      <form
        className="mt-search mt-search--static"
        onSubmit={(e) => {
          e.preventDefault();
          void startSpotify(link.trim());
        }}
      >
        <span aria-hidden="true" className="mt-search__icon">
          <IconLink size={20} />
        </span>
        <input value={link} onChange={(e) => setLink(e.target.value)} placeholder={t("sp.linkPh")} aria-label={t("sp.linkPh")} />
        <button type="submit" className="mt-pill mt-pill--solid" disabled={!link.trim() || (busy && link.trim() === job?.url)}>
          {busy && link.trim() === job?.url ? <IconSpinner size={16} title={t("music.loading")} /> : t("sp.go")}
        </button>
      </form>
      {error === "bad-link" && (
        <div className="mp-note" role="alert">
          {t("sp.badLink")}
        </div>
      )}
      {error === "not-found" && (
        <div className="mp-note" role="alert">
          {t("sp.notFound")}
        </div>
      )}
      {error && error !== "bad-link" && error !== "not-found" && <ErrorNote code={error} onRetry={() => job && void startSpotify(job.url)} />}
      {!job && <p className="mt-hint">{t("sp.how")}</p>}

      {phase === "reading" && <div className="mt-spin mt-spin--block" />}
      {phase === "matching" && list && (
        <div className="mt-progress" role="progressbar" aria-valuemin={0} aria-valuemax={list.songs.length} aria-valuenow={job?.done ?? 0}>
          <div className="mt-progress__label">{t("sp.matching").replace("{n}", String(job?.done ?? 0)).replace("{m}", String(list.songs.length))}</div>
          <div className="mt-progress__bar">
            <span style={{ width: `${list.songs.length ? ((job?.done ?? 0) / list.songs.length) * 100 : 0}%` }} />
          </div>
        </div>
      )}

      {phase === "done" && list && (
        <>
          <div className="mt-actions">
            <ListPlay srcKey={srcKey} disabled={!tracks.length} label={label} start={() => music.play({ kind: "videos", label, key: srcKey, tracks, start: 0 })} />
            {saved ? (
              <button className="mt-pill" onClick={() => go({ kind: "playlist", id: saved.id })}>
                <IconCheck size={16} /> {t("mt.saved")}
              </button>
            ) : (
              <button className="mt-pill mt-pill--solid" disabled={!available || !tracks.length} onClick={save}>
                <IconPlus size={16} /> {t("mt.saveTeam")}
              </button>
            )}
            <span className="mt-hint">{t("sp.found").replace("{n}", String(tracks.length)).replace("{m}", String(list.songs.length))}</span>
          </div>
          {list.kind === "playlist" && list.songs.length >= 100 && <p className="mt-hint">{t("sp.first100")}</p>}
          {tracks.length > 0 && <TrackTable tracks={tracks} label={label} srcKey={srcKey} />}
          {missing.length > 0 && (
            <details className="mt-missing">
              <summary>{t("sp.missing").replace("{n}", String(missing.length))}</summary>
              <button className="mt-pill mt-pill--sm mt-missing__retry" onClick={() => void retrySpotifyMissing()}>
                <IconRepeat size={14} /> {t("mt.retryMissing")}
              </button>
              <ul>
                {missing.map((s, i) => (
                  <li key={i}>
                    {s.artist} — {s.title}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </>
      )}
    </div>
  );
}

/** A YouTube playlist before it is saved: listen to it, or keep it for the team. */
function YtPlaylistPage({ list, playlists, available, go }: { list: string; playlists: Playlist[]; available: boolean; go: Go }) {
  const { t } = useT();
  const { me } = useMe();
  const { data, error, retry } = useLoad((signal) => fetchYtPlaylist(list, { signal }), [list]);
  const back = (
    <button className="mt-link" onClick={() => go({ kind: "import" })}>
      <IconBack size={15} /> {t("mt.import")}
    </button>
  );

  if (error)
    return (
      <div className="mt-page">
        {back}
        <div style={{ height: 44 }} />
        {error === "not-found" ? <div className="mp-note">{t("mt.listNotFound")}</div> : <ErrorNote code={error} onRetry={retry} />}
      </div>
    );
  if (!data)
    return (
      <div className="mt-page">
        {back}
        <div style={{ height: 44 }} />
        <div className="mt-spin mt-spin--block" />
      </div>
    );

  const tracks = data.tracks ?? [];
  const label = data.title;
  const srcKey = `yt:${list}`;
  const saved = playlists.find((p) => p.name === data.title && p.tracks[0]?.id === tracks[0]?.id);

  const save = () => {
    const { playlist, saved: done } = createPlaylist(data.title, me, tracks);
    music.toast(t("mt.created", { p: data.title }));
    reportWrite(done, t);
    go({ kind: "playlist", id: playlist.id });
  };

  return (
    <div className="mt-page">
      {back}
      <div className="mt-hero mt-hero--artist" style={{ background: gradientFor(data.title) }}>
        {data.thumb ? <Cover src={data.thumb} className="mt-hero__img" /> : <Mosaic tracks={tracks} size={160} />}
        <div>
          <small>{t("mt.ytPlaylist")}</small>
          <h1>{data.title}</h1>
          <small>
            {data.channel || "YouTube"} · {t("mt.songs").replace("{n}", String(tracks.length))}
            {data.total && data.total > tracks.length ? ` (${t("mt.ofTotal").replace("{n}", String(data.total))})` : ""}
          </small>
        </div>
      </div>
      <div className="mt-actions">
        <ListPlay srcKey={srcKey} disabled={!tracks.length} label={label} start={() => music.play({ kind: "videos", label, key: srcKey, tracks, start: 0 })} />
        {saved ? (
          <button className="mt-pill" onClick={() => go({ kind: "playlist", id: saved.id })}>
            <IconCheck size={16} /> {t("mt.saved")}
          </button>
        ) : (
          <button className="mt-pill mt-pill--solid" disabled={!available || !tracks.length} onClick={save}>
            <IconPlus size={16} /> {t("mt.saveTeam")}
          </button>
        )}
        {!available && <span className="mt-hint">{t("mt.needMigration")}</span>}
      </div>
      {tracks.length ? <TrackTable tracks={tracks} label={label} srcKey={srcKey} /> : <p className="mt-hint">{t("mt.listEmpty")}</p>}
    </div>
  );
}

// ---- Artist ------------------------------------------------------------------

/** One of the team's favourite artists. */
function ArtistPage({ name }: { name: string }) {
  const { t } = useT();
  const artist = ARTISTS.find((a) => a.name === name);
  const { data, error, retry } = useLoad(
    (signal) => (artist ? searchMusic("", { channelId: artist.channel, order: "viewCount", signal }) : Promise.resolve<MusicFail>({ error: "not-found" })),
    [artist?.channel]
  );
  if (!artist)
    return (
      <div className="mt-page">
        <div style={{ height: 44 }} />
        <div className="mp-note">{t("music.err.notFound")}</div>
      </div>
    );
  const top = data?.tracks ?? null;
  const srcKey = `artist:${artist.name}`;

  return (
    <div className="mt-page">
      <div className="mt-hero mt-hero--artist" style={{ background: `${gradientFor(artist.name)}` }}>
        <ArtistAvatar name={artist.name} size={160} />
        <div>
          <small>{t("mt.artist")}</small>
          <h1>{artist.name}</h1>
        </div>
      </div>
      <div className="mt-actions">
        <ListPlay srcKey={srcKey} label={artist.name} start={() => music.play({ kind: "artist", artist: artist.name, key: srcKey })} />
        <span className="mt-hint">{t("mt.artistAll")}</span>
      </div>
      <h2 className="mt-h2">{t("mt.popular")}</h2>
      {error && <ErrorNote code={error} q={artist.name} onRetry={retry} />}
      {!top && !error && <div className="mt-spin mt-spin--block" />}
      {top && top.length < 5 && <p className="mt-hint">{t("mt.fewPopular")}</p>}
      {top && top.length > 0 && <TrackTable tracks={top.slice(0, 15)} label={artist.name} srcKey={`artistTop:${artist.name}`} />}
    </div>
  );
}

/** Any YouTube Music artist (from the charts). */
function MusicArtistPage({ id, name }: { id: string; name: string }) {
  const { t } = useT();
  const { data, error, retry } = useLoad((signal) => fetchMusicArtist(id, { signal }), [id]);
  const title = data?.name || name;
  const srcKey = `martist:${id}`;
  return (
    <div className="mt-page">
      <div className="mt-hero mt-hero--artist" style={{ background: gradientFor(title || id) }}>
        {data?.thumb ? <Cover src={data.thumb} className="mt-hero__img mt-hero__img--round" /> : <ArtistAvatar name={title || "?"} size={160} />}
        <div>
          <small>{t("mt.artist")}</small>
          <h1>{title}</h1>
        </div>
      </div>
      <div className="mt-actions">
        <ListPlay
          srcKey={srcKey}
          disabled={!data?.tracks?.length}
          label={title}
          start={() => data && music.play({ kind: "videos", label: title, key: srcKey, tracks: data.tracks, start: 0 })}
        />
      </div>
      {error && <ErrorNote code={error} q={title} onRetry={retry} />}
      {!data && !error && <div className="mt-spin mt-spin--block" />}
      {data?.tracks && <TrackTable tracks={data.tracks} label={title} srcKey={srcKey} />}
    </div>
  );
}

// ---- Playlist ----------------------------------------------------------------

// A playlist just made with the Library "+": its page opens with the name field.
let renameOnOpen: string | null = null;

function PlaylistPage({ id, go }: { id: string; go: Go }) {
  const { t } = useT();
  const p = usePlaylist(id);
  const { loaded } = usePlaylists();
  const shuffle = useMusicSel((s) => s.shuffle);
  const [confirm, setConfirm] = useState(false);
  const [editing, setEditing] = useState(() => renameOnOpen === id);
  useEffect(() => {
    if (renameOnOpen === id) renameOnOpen = null;
  }, [id]);
  const confirmRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (confirm) confirmRef.current?.focus();
  }, [confirm]);

  if (!p)
    return (
      <div className="mt-page">
        <div style={{ height: 44 }} />
        {loaded ? <p className="mt-hint">{t("mt.gone")}</p> : <div className="mt-spin mt-spin--block" />}
      </div>
    );
  const srcKey = `pl:${p.id}`;

  const remove = () => {
    const snap = p;
    setConfirm(false);
    reportWrite(deletePlaylist(p.id), t);
    // Back must not land on a playlist that is gone: replace this entry.
    go({ kind: "home" }, { replace: true });
    showUndo(t("mt.deleted", { p: snap.name }), () => reportWrite(restorePlaylist(snap), t));
  };

  return (
    <div className="mt-page">
      <div className="mt-hero mt-hero--artist" style={{ background: gradientFor(p.name) }}>
        <Mosaic tracks={p.tracks} size={160} />
        <div className="mt-hero__text">
          <small>{t("mt.playlist")}</small>
          {editing ? (
            <RenameField
              name={p.name}
              onDone={(name) => {
                setEditing(false);
                if (name && name !== p.name) reportWrite(renamePlaylist(p.id, name), t);
              }}
            />
          ) : (
            <h1 className="mt-title">
              <span className="mt-title__text" onClick={() => setEditing(true)} title={t("mt.rename")}>
                {p.name}
              </span>
              <button className="mt-iconbtn mt-title__edit" onClick={() => setEditing(true)} aria-label={`${t("mt.renameBtn")} ${p.name}`} title={t("mt.renameBtn")}>
                <IconPencil size={18} />
              </button>
            </h1>
          )}
          <p>
            {p.owner || "—"} · {t("mt.songs").replace("{n}", String(p.tracks.length))}
          </p>
        </div>
      </div>
      <div className="mt-actions">
        <ListPlay srcKey={srcKey} disabled={!p.tracks.length} label={p.name} start={() => music.play({ kind: "videos", label: p.name, key: srcKey, tracks: p.tracks, start: 0 })} />
        <button className={`mt-ghost${shuffle ? " is-on" : ""}`} onClick={() => music.setShuffle(!shuffle)} title={t("mt.shuffle")} aria-pressed={shuffle}>
          <IconShuffle size={16} /> {t("mt.shuffle")}
        </button>
        <span style={{ flex: 1 }} />
        {confirm ? (
          <div className="mt-confirm" role="alertdialog" aria-label={t("mt.deleteQ")} onKeyDown={(e) => e.key === "Escape" && setConfirm(false)}>
            <span className="mt-hint">{t("mt.deleteQ")}</span>
            <button ref={confirmRef} className="mt-ghost mt-ghost--danger" onClick={remove}>
              {t("mt.delete")}
            </button>
            <button className="mt-ghost" onClick={() => setConfirm(false)}>
              {t("mt.cancel")}
            </button>
          </div>
        ) : (
          <button className="mt-ghost" onClick={() => setConfirm(true)}>
            {t("mt.delete")}
          </button>
        )}
      </div>
      {p.tracks.length === 0 ? <p className="mt-hint">{t("mt.emptyPlaylist")}</p> : <TrackTable tracks={p.tracks} label={p.name} srcKey={srcKey} playlistId={p.id} />}
    </div>
  );
}

/** The playlist's name as a text field: Enter or leaving saves, Escape cancels. */
function RenameField({ name, onDone }: { name: string; onDone: (name: string | null) => void }) {
  const { t } = useT();
  const [v, setV] = useState(name);
  const done = useRef(false);
  const finish = (val: string | null) => {
    if (done.current) return;
    done.current = true;
    onDone(val?.trim() || null);
  };
  return (
    <input
      className="mt-rename"
      autoFocus
      onFocus={(e) => e.currentTarget.select()}
      value={v}
      maxLength={80}
      aria-label={t("mt.newName")}
      onChange={(e) => setV(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          finish(v);
        } else if (e.key === "Escape") {
          e.preventDefault();
          finish(null);
        }
      }}
      onBlur={() => finish(v)}
    />
  );
}

/** A pencil (rename). Same outline style as MusicIcons. */
function IconPencil({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" className="mi" aria-hidden="true">
      <path d="M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16v4Z" />
      <path d="m13.5 6.5 4 4" />
    </svg>
  );
}

// ---- Track table ---------------------------------------------------------------

/**
 * A list of songs. It follows only which song is on and whether it plays, and
 * each row is memoised: a song change re-renders two rows.
 */
const TrackTable = memo(function TrackTable({ tracks, label, srcKey, playlistId }: { tracks: Track[]; label: string; srcKey: string; playlistId?: string }) {
  const { t } = useT();
  const nowId = useMusicSel((s) => s.now?.id ?? null);
  const playing = useMusicSel((s) => s.playing);
  const keys = useMemo(() => rowKeys(tracks), [tracks]);
  const play = useCallback((i: number) => music.play({ kind: "videos", label, key: srcKey, tracks, start: i }), [tracks, label, srcKey]);
  return (
    <div className="mt-table">
      <div className="mt-tr mt-tr--head" aria-hidden="true">
        <span>#</span>
        <span>{t("mt.title")}</span>
        <span />
      </div>
      <div role="list" aria-label={label}>
        {tracks.map((tr, i) => {
          const on = nowId === tr.id;
          return (
            <TrackRow key={keys[i]} tr={tr} i={i} last={i === tracks.length - 1} on={on} eq={on && playing} tracks={tracks} label={label} srcKey={srcKey} playlistId={playlistId} play={play} />
          );
        })}
      </div>
    </div>
  );
});

const TrackRow = memo(function TrackRow({
  tr,
  i,
  last,
  on,
  eq,
  tracks,
  label,
  srcKey,
  playlistId,
  play,
}: {
  tr: Track;
  i: number;
  last: boolean;
  on: boolean;
  eq: boolean;
  tracks: Track[];
  label: string;
  srcKey: string;
  playlistId?: string;
  play: (i: number) => void;
}) {
  const { t } = useT();
  const ctx: MenuCtx = { list: { tracks, label, index: i, key: srcKey }, playlistId };
  const title = tr.title || tr.id;
  return (
    <div
      className={`mt-tr${on ? " is-on" : ""}`}
      role="listitem"
      tabIndex={0}
      aria-label={`${i + 1}. ${title}${tr.channel ? `, ${tr.channel}` : ""}`}
      aria-current={on ? "true" : undefined}
      onPointerDown={music.warm}
      // One click plays (not when the click was on one of the row's buttons).
      onClick={(e) => {
        if ((e.target as HTMLElement).closest("button")) return;
        play(i);
      }}
      onKeyDown={onActivate(() => play(i))}
      {...songMenuProps(tr, ctx)}
    >
      <span className="mt-tr__n">
        <span className="mt-tr__num">{eq ? <IconBars size={16} className="mi-eq" /> : i + 1}</span>
        <button className="mt-tr__play" tabIndex={-1} onClick={() => play(i)} aria-label={`${t("music.play")} ${title}`}>
          <IconPlay size={15} />
        </button>
      </span>
      <span className="mt-tr__title">
        <Cover id={tr.id} src={tr.thumb} className="mt-img40" />
        <span>
          <b>{title}</b>
          <small>{tr.channel}</small>
        </span>
      </span>
      <span className="mt-tr__act">
        {playlistId && (
          <>
            <button
              className="mt-iconbtn"
              title={t("mt.up")}
              aria-label={t("mt.up")}
              disabled={i === 0}
              onClick={() => reportWrite(moveInPlaylist(playlistId, i, i - 1), t)}
            >
              <IconUp size={16} />
            </button>
            <button
              className="mt-iconbtn"
              title={t("mt.down")}
              aria-label={t("mt.down")}
              disabled={last}
              onClick={() => reportWrite(moveInPlaylist(playlistId, i, i + 1), t)}
            >
              <IconDown size={16} />
            </button>
          </>
        )}
        <AddBtn track={tr} />
        {playlistId && (
          <button
            className="mt-iconbtn mt-iconbtn--remove"
            title={t("mt.remove")}
            aria-label={`${t("mt.remove")}: ${title}`}
            onClick={() => {
              reportWrite(removeFromPlaylist(playlistId, tr.id, i), t);
              showUndo(t("mt.removed", { s: title }), () => reportWrite(insertInPlaylist(playlistId, tr, i), t));
            }}
          >
            <IconClose size={16} />
          </button>
        )}
        <MoreBtn track={tr} ctx={ctx} />
      </span>
    </div>
  );
});

// ---- Now playing + queue ---------------------------------------------------------

function NowPlaying({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useT();
  const video = useMusicSel((s) => s.mode === "video");
  const now = useMusicSel((s) => s.now);
  const label = useMusicSel((s) => sourceLabel(s.source, t));
  const loading = useMusicSel((s) => s.playing && (s.status === "loading" || s.status === "buffering"));
  const queue = useMusicSel((s) => s.queue);
  const index = useMusicSel((s) => s.index);
  const slot = useRef<HTMLDivElement>(null);

  // In Video mode the player (fixed, at the root) sits exactly on this slot.
  // Only the window and this panel's own scroll move it; an unchanged rectangle
  // writes nothing (setDockRect compares). A hidden slot (narrow window, queue
  // closed) means not docked.
  useLayoutEffect(() => {
    const el = slot.current;
    if (!video || !el) {
      setDockRect(null);
      return;
    }
    let raf = 0;
    const measure = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const r = el.getBoundingClientRect();
        setDockRect(r.width >= 2 && r.height >= 2 ? { x: r.left, y: r.top, w: r.width, h: r.height } : null);
      });
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    const box = el.closest(".mt-now__box");
    window.addEventListener("scroll", measure, { passive: true });
    box?.addEventListener("scroll", measure, { passive: true });
    window.addEventListener("resize", measure);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      window.removeEventListener("scroll", measure);
      box?.removeEventListener("scroll", measure);
      window.removeEventListener("resize", measure);
      setDockRect(null);
    };
  }, [video]);

  const upNext = useMemo(() => (index >= 0 ? queue.slice(index + 1, index + 30) : []), [queue, index]);
  const keys = useMemo(() => rowKeys(upNext), [upNext]);
  const current: Track | null = now ? { id: now.id, title: now.title, channel: now.author } : null;
  const title = now?.title || label;

  return (
    <aside className={`mt-now${open ? " is-open" : ""}`} aria-label={t("mt.nowPlaying")} onKeyDown={(e) => open && e.key === "Escape" && onClose()}>
      <div className="mt-box mt-now__box">
        <div className="mt-now__head">
          <span>{t("mt.nowPlaying")}</span>
          <button className="mt-iconbtn mt-now__close" onClick={onClose} aria-label={t("music.close")}>
            <IconClose size={16} />
          </button>
        </div>
        {video ? (
          <div className="mt-now__video" ref={slot} />
        ) : (
          <div className="mt-now__cover" {...(current ? songMenuProps(current) : {})}>
            {now ? <Cover id={now.id} big /> : <IconNote size={48} />}
          </div>
        )}
        <div className="mt-now__title">{title || t("music.nothing")}</div>
        <div className="mt-now__author">
          {loading ? (
            <span className="mt-loading">
              <IconSpinner size={14} /> {t("music.loading")}
            </span>
          ) : (
            now?.author
          )}
        </div>
        {upNext.length > 0 && (
          <>
            <div className="mt-now__head" style={{ marginTop: 18 }}>
              {t("mt.next")}
            </div>
            <div className="mt-queue" role="list">
              {upNext.map((tr, i) => (
                <QueueItem key={keys[i]} tr={tr} at={index + 1 + i} />
              ))}
            </div>
          </>
        )}
        <div className="mt-now__fine">
          <PremiumToggle />
        </div>
      </div>
    </aside>
  );
}

const QueueItem = memo(function QueueItem({ tr, at }: { tr: Track; at: number }) {
  const { t } = useT();
  return (
    <div className="mt-qitem" role="listitem" {...songMenuProps(tr)}>
      <button className="mt-qitem__main" onClick={() => music.playAt(at)} aria-label={`${t("music.play")} ${tr.title || tr.id}`}>
        <Cover id={tr.id} src={tr.thumb} className="mt-img40" />
        <span>
          <b>{tr.title || tr.id}</b>
          <small>{tr.channel}</small>
        </span>
      </button>
      <MoreBtn track={tr} ctx={{}} size={16} />
    </div>
  );
});

// ---- Player bar ------------------------------------------------------------------

function PlayerBar({ barRef, queueOpen, onQueue }: { barRef: RefObject<HTMLElement>; queueOpen: boolean; onQueue: () => void }) {
  const { t } = useT();
  const now = useMusicSel((s) => s.now);
  const label = useMusicSel((s) => sourceLabel(s.source, t));
  const has = useMusicSel((s) => !!s.source);
  const loading = useMusicSel((s) => s.playing && (s.status === "loading" || s.status === "buffering"));
  const shuffle = useMusicSel((s) => s.shuffle);
  const repeat = useMusicSel((s) => s.repeat);
  const current = useMemo<Track | null>(() => (now ? { id: now.id, title: now.title, channel: now.author } : null), [now]);

  return (
    <footer className="mt-bar" ref={barRef} tabIndex={-1} aria-label={t("mt.barLabel")}>
      <div className="mt-bar__song" {...(current ? songMenuProps(current) : {})}>
        {now ? (
          <Cover id={now.id} className="mt-bar__img" />
        ) : (
          <span className="mt-bar__ph">{loading ? <IconSpinner size={22} title={t("music.loading")} /> : <IconNote size={22} />}</span>
        )}
        <span>
          <b>{now?.title || label || t("music.nothing")}</b>
          <small>{loading && !now?.author ? t("music.loading") : now?.author}</small>
        </span>
        {current && <AddBtn track={current} />}
        {current && <MoreBtn track={current} ctx={{}} />}
      </div>
      <div className="mt-bar__center">
        <div className="mt-bar__controls">
          <button className={`mt-iconbtn${shuffle ? " is-on" : ""}`} onClick={() => music.setShuffle(!shuffle)} aria-pressed={shuffle} title={t("mt.shuffle")} aria-label={t("mt.shuffle")}>
            <IconShuffle size={18} />
          </button>
          <button className="mt-iconbtn" onClick={music.prev} disabled={!has} aria-label={t("music.prev")}>
            <IconPrev size={18} />
          </button>
          <PlayButton className="mt-play" size={18} />
          <button className="mt-iconbtn" onClick={music.next} disabled={!has} aria-label={t("music.next")}>
            <IconNext size={18} />
          </button>
          <button className={`mt-iconbtn${repeat ? " is-on" : ""}`} onClick={() => music.setRepeat(!repeat)} aria-pressed={repeat} title={t("mt.repeat")} aria-label={t("mt.repeat")}>
            <IconRepeat size={18} />
          </button>
        </div>
        <Progress />
      </div>
      <div className="mt-bar__right">
        <button className={`mt-iconbtn mt-queuebtn${queueOpen ? " is-on" : ""}`} onClick={onQueue} aria-pressed={queueOpen} title={t("mt.queue")} aria-label={t("mt.queue")}>
          <IconQueue size={18} />
        </button>
        <ModeSwitch />
        <Volume />
      </div>
    </footer>
  );
}

/** Mute and the volume slider: their own component, so a drag re-renders only them. */
function Volume() {
  const { t } = useT();
  const volume = useMusicSel((s) => s.volume);
  const muted = useMusicSel((s) => s.muted);
  // While dragging, the slider shows the finger's value (the player follows,
  // throttled); nothing written back by the player can make it jump.
  const [drag, setDrag] = useState<number | null>(null);
  const vol = drag ?? (muted ? 0 : volume);
  const endDrag = () => setDrag(null);
  return (
    <>
      <button className="mt-iconbtn" onClick={() => music.setMuted(!muted)} aria-label={muted ? t("mt.unmute") : t("mt.mute")} aria-pressed={muted}>
        {muted || volume === 0 ? <IconMute size={18} /> : <IconVolume size={18} />}
      </button>
      <input
        className="mt-volume"
        type="range"
        min={0}
        max={100}
        value={vol}
        onChange={(e) => {
          const v = Number(e.target.value);
          setDrag(v);
          music.setVolume(v);
        }}
        onPointerUp={endDrag}
        onKeyUp={endDrag}
        onBlur={endDrag}
        aria-label={t("mt.volume")}
        aria-valuetext={`${vol}%`}
        style={{ ["--p" as string]: `${vol}%` }}
      />
    </>
  );
}
