import { memo, useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useT } from "../lib/i18n";
import { matchSpotify, mlog, music, type SpotifyList, type Track } from "../lib/music";
import type { SpLibSec, View } from "../lib/musicTabRoute";
import { beginSpotifyLogin, signOutSpotify, spotifyLoginAvailable, useSpotifyAuth } from "../lib/spotifyAuth";
import {
  LIKED_CAP,
  SpotifyApiError,
  albumTracks,
  artistAlbums,
  followedArtists,
  importListOf,
  likedTracks,
  markLibraryReturn,
  myPlaylists,
  playlistTracks,
  recentlyPlayed,
  savedAlbums,
  searchSpotify,
  spotifyErrorText,
  songOf,
  type ListResult,
  type SearchPage,
  type SearchType,
  type SpItem,
  type SpTrack,
} from "../lib/spotifyLibrary";
import { Cover } from "./MusicPlayer";
import { IconBack, IconExternal, IconNote, IconPlus, IconSearch, IconSpinner, IconUser } from "./MusicIcons";

// -----------------------------------------------------------------------------
// "La mia libreria Spotify" (MUSICA tab, #/music/splib/…): the signed-in
// person's own Spotify library — playlists, liked songs, saved albums,
// followed artists, recently played, and a Spotify search. Every list opens
// to its songs; any playlist, album, the liked songs or the recent list can be
// imported into the team library through the same two-step job as "Importa
// da Spotify" (each song found on YouTube, its Spotify id kept in
// Track.spotify). Single songs go to a team playlist with "+".
//
// Spotify's rules: every item shows its cover art and details, a "da Spotify"
// label and an "Apri su Spotify" link back to Spotify; nothing here plays
// Spotify audio (Spotify mode does, on its own). Spotify is credited in words
// only (SpotifyCredit): no home-made copy of Spotify's icon. The controls that
// turn a Spotify song into a YouTube one ("+" and "Importa") never sit beside
// Spotify's cover art: song rows show no art, and a list's import sits in its
// own panel that says the result is YouTube songs without Spotify's art.
// -----------------------------------------------------------------------------

type Go = (v: View, opts?: { replace?: boolean }) => void;
type SplibView = Extract<View, { kind: "splib" }>;

export interface SpotifyLibraryProps {
  view: SplibView;
  go: Go;
  /** Opens the tab's "+" menu for a song (MusicTab's AddMenu). */
  onAdd: (track: Track, anchor: HTMLElement) => void;
  /** Starts the import job (MusicTab's Spotify job store) and shows its page. */
  onImport: (list: SpotifyList, name: string, url: string) => void;
  /** A Spotify import is reading or matching: signing in (which leaves the page) would drop it. */
  importBusy?: boolean;
}

/** A long name in a page's big title is drawn smaller (musicTab.css clamps it to two lines). */
const titleCls = (name: string | undefined) => ((name?.length ?? 0) > 24 ? " mt-title--long" : "");

/**
 * The Spotify credit, in words: Spotify's branding rules allow only the
 * official, unmodified icon or logo, so no imitation mark is drawn. One
 * component for every credit on the page.
 */
export function SpotifyCredit({ className }: { className?: string }) {
  return <span className={`spl-credit${className ? " " + className : ""}`}>Spotify</span>;
}

// ---- Loading with a cache (switching sections is instant) ---------------------------

const CACHE_MS = 5 * 60_000;
const cache = new Map<string, { at: number; data: unknown }>();

function useSp<D>(key: string, load: (signal: AbortSignal) => Promise<D>): { data: D | null; error: unknown; retry: () => void } {
  const { t } = useT();
  const hit = cache.get(key);
  const fresh = hit && Date.now() - hit.at < CACHE_MS ? (hit.data as D) : null;
  const [state, setState] = useState<{ key: string; data: D | null; error: unknown }>({ key, data: fresh, error: null });
  const [n, setN] = useState(0);
  const loadRef = useRef(load);
  loadRef.current = load;
  useEffect(() => {
    const c = cache.get(key);
    if (c && Date.now() - c.at < CACHE_MS && n === 0) {
      setState({ key, data: c.data as D, error: null });
      return;
    }
    setState({ key, data: null, error: null });
    const ctrl = new AbortController();
    loadRef.current(ctrl.signal).then(
      (data) => {
        if (ctrl.signal.aborted) return;
        cache.set(key, { at: Date.now(), data });
        setState({ key, data, error: null });
      },
      (error) => {
        if (ctrl.signal.aborted || (error instanceof SpotifyApiError && error.code === "aborted")) return;
        mlog("splib: load failed", { key, error: error instanceof SpotifyApiError ? error.code : String(error) }, "warn");
        music.toast(spotifyErrorText(error, t), "error");
        setState({ key, data: null, error });
      }
    );
    return () => ctrl.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, n]);
  const retry = useCallback(() => {
    cache.delete(key);
    setN((x) => x + 1);
  }, [key]);
  const cur = state.key === key ? state : { data: fresh, error: null };
  return { data: cur.data, error: cur.error, retry };
}

/** Tests / sign-out: forget what was read. */
export function forgetSpotifyLibraryCache(): void {
  cache.clear();
}

function Loading() {
  const { t } = useT();
  return (
    <div className="spl-loading" role="status">
      <IconSpinner size={22} title={t("music.loading")} />
    </div>
  );
}

function ErrorBox({ error, retry }: { error: unknown; retry: () => void }) {
  const { t } = useT();
  return (
    <div className="mp-note mt-err" role="alert">
      {spotifyErrorText(error, t)}{" "}
      <button className="mt-pill mt-pill--sm" onClick={retry}>
        {t("music.retry")}
      </button>
    </div>
  );
}

// ---- Attribution bits ------------------------------------------------------------------

function FromSpotify() {
  const { t } = useT();
  return (
    <span className="spl-from">{t("spl.fromSpotify")}</span>
  );
}

function OpenOnSpotify({ url, label, big }: { url: string; label: string; big?: boolean }) {
  const { t } = useT();
  return (
    <a
      className={big ? "mt-pill mt-pill--sm spl-open" : "mt-iconbtn spl-openicon"}
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={`${t("spl.openOn")}: ${label}`}
      title={t("spl.openOn")}
      onClick={(e) => e.stopPropagation()}
    >
      {big ? (
        <>
          {t("spl.openOn")} <IconExternal size={13} />
        </>
      ) : (
        <IconExternal size={16} />
      )}
    </a>
  );
}

// ---- The page --------------------------------------------------------------------------

const SECS: { sec: SpLibSec; key: string }[] = [
  { sec: "playlists", key: "spl.secPlaylists" },
  { sec: "liked", key: "spl.secLiked" },
  { sec: "albums", key: "spl.secAlbums" },
  { sec: "artists", key: "spl.secArtists" },
  { sec: "recent", key: "spl.secRecent" },
  { sec: "search", key: "spl.secSearch" },
];

export function SpotifyLibrary({ view, go, onAdd, onImport, importBusy }: SpotifyLibraryProps) {
  const { t } = useT();
  const auth = useSpotifyAuth();
  const sec: SpLibSec = view.sec ?? "playlists";
  const ctx: Ctx = { go, onAdd, onImport, sec };

  useEffect(() => {
    if (auth.status === "out") cache.clear();
  }, [auth.status]);
  // Leaving the library forgets what was opened inside it: coming back by a
  // link, a reload or the browser's own history starts "Indietro" afresh.
  useEffect(() => () => openedHere.clear(), []);

  const hero = (
    <div className="mt-hero mt-hero--artist spl-hero">
      <span className="mt-hero__img spl-hero__mark" aria-hidden="true">
        <IconNote size={56} />
      </span>
      <div className="mt-hero__text">
        <small>
          <SpotifyCredit />
        </small>
        <h1>{t("spl.title")}</h1>
        <p className="mt-hint" style={{ margin: 0 }}>
          {t("spl.intro")}
        </p>
      </div>
    </div>
  );

  if (!spotifyLoginAvailable())
    return (
      <div className="mt-page spl">
        {hero}
        <p className="mt-hint">{t("spl.noClient")}</p>
      </div>
    );

  if (auth.status !== "in")
    return (
      <div className="mt-page spl">
        {hero}
        <div className="spl-signin">
          <p>{t(auth.status === "error" ? "sp.loginFailed" : "spl.signIn")}</p>
          <button
            type="button"
            className="mt-pill mt-pill--solid"
            disabled={auth.status === "busy" || importBusy}
            aria-describedby="spl-signin-note"
            onClick={() => {
              mlog("splib: sign in");
              markLibraryReturn();
              void beginSpotifyLogin();
            }}
          >
            {auth.status === "busy" ? <IconSpinner size={16} /> : <IconUser size={16} />} {t(auth.status === "busy" ? "sp.loggingIn" : "sp.login")}
          </button>
          {/* Signing in leaves the page: say so (and wait for an import running now). */}
          <p id="spl-signin-note" className="mt-hint spl-signin__note">
            {t(importBusy ? "ux.music.splibWaitImport" : "ux.music.splibLeaveNote")}
          </p>
        </div>
      </div>
    );

  return (
    <div className="mt-page spl">
      {!view.open && hero}
      <div className="spl-bar">
        <span className="mt-hint spl-attrib">{t("spl.attrib")}</span>
        <span className="mt-hint">
          <IconUser size={13} /> {t("sp.connected")} ·{" "}
          <button type="button" className="mt-link" onClick={signOutSpotify}>
            {t("sp.logout")}
          </button>
        </span>
      </div>
      <div className="mt-chips spl-tabs" role="tablist" aria-label={t("spl.sections")}>
        {SECS.map((s) => (
          <button
            key={s.sec}
            role="tab"
            aria-selected={sec === s.sec && !view.open}
            className={`mt-chip${sec === s.sec ? " is-on" : ""}`}
            onClick={() => go({ kind: "splib", sec: s.sec })}
          >
            {t(s.key)}
          </button>
        ))}
      </div>
      <div className="spl-body" role="tabpanel">
        {view.open ? (
          view.open.type === "artist" ? (
            <ArtistView key={view.open.id} id={view.open.id} ctx={ctx} />
          ) : (
            <ListView key={view.open.type + view.open.id} type={view.open.type} id={view.open.id} ctx={ctx} />
          )
        ) : sec === "playlists" ? (
          <PlaylistsSec ctx={ctx} />
        ) : sec === "liked" ? (
          <LikedSec ctx={ctx} />
        ) : sec === "albums" ? (
          <AlbumsSec ctx={ctx} />
        ) : sec === "artists" ? (
          <ArtistsSec ctx={ctx} />
        ) : sec === "recent" ? (
          <RecentSec ctx={ctx} />
        ) : (
          <SearchSec ctx={ctx} />
        )}
      </div>
    </div>
  );
}

interface Ctx {
  go: Go;
  onAdd: SpotifyLibraryProps["onAdd"];
  onImport: SpotifyLibraryProps["onImport"];
  sec: SpLibSec;
}

/**
 * Items opened from inside the library while it stays open ("album:<id>"…):
 * only those go back with history.back(). One reached any other way (a shared
 * link, a reload, the return from Spotify's sign-in) goes to its section, so
 * "Indietro" never leaves the app or lands on Spotify's pages.
 */
const openedHere = new Set<string>();
const openKey = (type: string, id: string) => `${type}:${id}`;

const openItem = (ctx: Ctx, it: SpItem) => {
  openedHere.add(openKey(it.kind, it.id));
  ctx.go({ kind: "splib", sec: ctx.sec, open: { type: it.kind, id: it.id } });
};

// ---- Cards (playlists, albums, artists) -------------------------------------------------

const ItemCard = memo(function ItemCard({ it, ctx }: { it: SpItem; ctx: Ctx }) {
  const { t } = useT();
  const count = typeof it.count === "number" ? t("mt.songs").replace("{n}", String(it.count)) : "";
  const tag = it.kind === "playlist" ? (it.mine ? t("spl.mine") : it.collaborative ? t("spl.collab") : "") : "";
  return (
    <div className="mt-card spl-card">
      <button type="button" className="spl-card__main" onClick={() => openItem(ctx, it)} aria-label={t("spl.open", { p: it.name })}>
        <div className="mt-card__art">
          <Cover src={it.cover} className={`mt-card__img${it.kind === "artist" ? " mt-card__img--round" : ""} spl-card__img`} />
        </div>
        <b>{it.name}</b>
        <small>{[it.kind === "artist" ? t("spl.artist") : it.sub, count, tag].filter(Boolean).join(" · ")}</small>
      </button>
      <div className="spl-card__foot">
        <FromSpotify />
        <OpenOnSpotify url={it.url} label={it.name} />
      </div>
    </div>
  );
});

function Cards({ items, ctx }: { items: SpItem[]; ctx: Ctx }) {
  const { t } = useT();
  if (!items.length) return <p className="mt-hint">{t("spl.empty")}</p>;
  return (
    <div className="mt-cards spl-cards">
      {items.map((it) => (
        <ItemCard key={it.kind + it.id} it={it} ctx={ctx} />
      ))}
    </div>
  );
}

// ---- Songs ------------------------------------------------------------------------------

const fmt = (ms: number) => {
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

/** Songs matched once for "+" (by Spotify id), so a second "+" opens at once. */
const matched = new Map<string, Track | null>();

const SongRow = memo(function SongRow({ tr, n, ctx }: { tr: SpTrack; n: number; ctx: Ctx }) {
  const { t } = useT();
  const [busy, setBusy] = useState(false);
  const add = async (anchor: HTMLElement) => {
    if (busy) return;
    const known = matched.get(tr.id);
    if (known) return ctx.onAdd(known, anchor);
    setBusy(true);
    mlog("splib: + song, finding it on YouTube", { spotify: tr.id });
    const [m] = await matchSpotify([songOf(tr)], () => {}, () => false);
    setBusy(false);
    const track = m ? { ...m, spotify: tr.id } : null;
    if (track) matched.set(tr.id, track);
    mlog("splib: + song matched", { spotify: tr.id, youtube: track?.id ?? null });
    if (!track) return music.toast(t("spl.notFound", { s: tr.name }), "error");
    if (anchor.isConnected) ctx.onAdd(track, anchor);
  };
  return (
    <div className="mt-trow spl-row" role="listitem">
      <span className="mt-trow__n">{n}</span>
      <div className="mt-trow__main">
        <span>
          <b>{tr.name}</b>
          <small>{[tr.artists, tr.album].filter(Boolean).join(" · ")}</small>
        </span>
      </div>
      <FromSpotify />
      <span className="spl-row__time">{tr.ms ? fmt(tr.ms) : ""}</span>
      <OpenOnSpotify url={tr.url} label={tr.name} />
      <button
        type="button"
        className="mt-iconbtn"
        aria-label={busy ? t("spl.finding", { s: tr.name }) : t("mt.addTo")}
        title={t("mt.addTo")}
        aria-haspopup="menu"
        aria-busy={busy}
        onClick={(e) => {
          e.stopPropagation();
          void add(e.currentTarget);
        }}
      >
        {busy ? <IconSpinner size={17} /> : <IconPlus size={17} />}
      </button>
    </div>
  );
});

function Songs({ tracks, ctx }: { tracks: SpTrack[]; ctx: Ctx }) {
  const { t } = useT();
  if (!tracks.length) return <p className="mt-hint">{t("spl.empty")}</p>;
  return (
    <div className="spl-songs" role="list">
      {tracks.map((tr, i) => (
        <SongRow key={tr.id + "#" + i} tr={tr} n={i + 1} ctx={ctx} />
      ))}
    </div>
  );
}

function ImportButton({ name, list, url, ctx }: { name: string; list: SpotifyList; url: string; ctx: Ctx }) {
  const { t } = useT();
  const [started, setStarted] = useState(false);
  return (
    <button
      type="button"
      className="mt-pill mt-pill--solid spl-import"
      disabled={!list.songs.length || started}
      onClick={() => {
        setStarted(true);
        const full = t("spl.sourceName", { name });
        mlog("splib: import into the team library", { name: full, songs: list.songs.length });
        music.toast(t("spl.importStarted", { p: full }));
        ctx.onImport(list, full, url);
      }}
    >
      {started ? <IconSpinner size={16} /> : <IconPlus size={16} />} {t("spl.import")}
    </button>
  );
}

/**
 * "Importa nella libreria del team", apart from the Spotify art above it: the
 * import finds each song on YouTube, and the team playlist it makes carries no
 * Spotify cover art or mark (the note says so).
 */
function ImportPanel({ children, ...p }: { name: string; list: SpotifyList; url: string; ctx: Ctx; children?: ReactNode }) {
  const { t } = useT();
  return (
    <section className="spl-importbox" aria-label={t("spl.import")}>
      <div className="mt-actions">
        <ImportButton {...p} />
        {children}
      </div>
      <p className="mt-hint spl-importbox__note">{t("spl.importNote")}</p>
    </section>
  );
}

// ---- Sections -----------------------------------------------------------------------------

function PlaylistsSec({ ctx }: { ctx: Ctx }) {
  const r = useSp("playlists", (s) => myPlaylists(s));
  if (r.error) return <ErrorBox error={r.error} retry={r.retry} />;
  if (!r.data) return <Loading />;
  return <Cards items={r.data} ctx={ctx} />;
}

function AlbumsSec({ ctx }: { ctx: Ctx }) {
  const r = useSp("albums", (s) => savedAlbums(s));
  if (r.error) return <ErrorBox error={r.error} retry={r.retry} />;
  if (!r.data) return <Loading />;
  return <Cards items={r.data} ctx={ctx} />;
}

function ArtistsSec({ ctx }: { ctx: Ctx }) {
  const r = useSp("artists", (s) => followedArtists(s));
  if (r.error) return <ErrorBox error={r.error} retry={r.retry} />;
  if (!r.data) return <Loading />;
  return <Cards items={r.data} ctx={ctx} />;
}

function LikedSec({ ctx }: { ctx: Ctx }) {
  const { t } = useT();
  const [prog, setProg] = useState<{ n: number; m?: number }>({ n: 0 });
  const r = useSp("liked", (s) => likedTracks(s, (n, m) => setProg({ n, m })));
  if (r.error) return <ErrorBox error={r.error} retry={r.retry} />;
  if (!r.data)
    return prog.m ? (
      <div className="mt-progress" role="progressbar" aria-valuemin={0} aria-valuemax={Math.min(prog.m, LIKED_CAP)} aria-valuenow={prog.n} aria-valuetext={`${prog.n}/${Math.min(prog.m, LIKED_CAP)}`}>
        <div className="mt-progress__label">
          {t("spl.secLiked")} · {prog.n}/{Math.min(prog.m, LIKED_CAP)}
        </div>
        <div className="mt-progress__bar">
          <span style={{ width: `${(prog.n / Math.min(prog.m, LIKED_CAP)) * 100}%` }} />
        </div>
      </div>
    ) : (
      <Loading />
    );
  const name = t("spl.secLiked");
  const list = importListOf({ kind: "liked", name, owner: "Spotify" }, r.data.tracks);
  return (
    <>
      <ImportPanel name={name} list={list} url="https://open.spotify.com/collection/tracks" ctx={ctx}>
        <span className="mt-hint">{t("mt.songs").replace("{n}", String(r.data.total))}</span>
      </ImportPanel>
      {r.data.capped && <p className="mt-hint">{t("spl.capped", { n: r.data.tracks.length, m: r.data.total })}</p>}
      <Songs tracks={r.data.tracks} ctx={ctx} />
    </>
  );
}

function RecentSec({ ctx }: { ctx: Ctx }) {
  const { t } = useT();
  const r = useSp("recent", (s) => recentlyPlayed(s));
  if (r.error) return <ErrorBox error={r.error} retry={r.retry} />;
  if (!r.data) return <Loading />;
  const name = t("spl.secRecent");
  return (
    <>
      <ImportPanel name={name} list={importListOf({ kind: "recent", name, owner: "Spotify" }, r.data)} url="" ctx={ctx}>
        <span className="mt-hint">{t("spl.recentNote")}</span>
      </ImportPanel>
      <Songs tracks={r.data} ctx={ctx} />
    </>
  );
}

// Search: the last query and results stay while you open an album and come back.
let lastSearch: { q: string; page: SearchPage; offsets: Record<SearchType, number> } | null = null;

function SearchSec({ ctx }: { ctx: Ctx }) {
  const { t } = useT();
  const [q, setQ] = useState(lastSearch?.q ?? "");
  const [res, setRes] = useState(lastSearch);
  const [busy, setBusy] = useState<SearchType | "all" | null>(null);
  const ctrl = useRef<AbortController | null>(null);
  useEffect(() => () => ctrl.current?.abort(), []);

  const run = async (more?: SearchType) => {
    const words = more ? res?.q ?? "" : q.trim();
    if (!words) return;
    ctrl.current?.abort();
    const c = new AbortController();
    ctrl.current = c;
    setBusy(more ?? "all");
    const offset = more && res ? res.offsets[more] + 10 : 0;
    try {
      const page = await searchSpotify(words, more ? [more] : ["track", "album", "playlist"], offset, c.signal);
      if (c.signal.aborted) return;
      let next: NonNullable<typeof lastSearch>;
      if (more && res) {
        const key = more === "track" ? "tracks" : more === "album" ? "albums" : "playlists";
        const old = res.page[key];
        const add = page[key];
        next = {
          q: words,
          page: { ...res.page, [key]: { items: [...(old?.items ?? []), ...(add?.items ?? [])], more: !!add?.more } },
          offsets: { ...res.offsets, [more]: offset },
        };
      } else next = { q: words, page, offsets: { track: 0, album: 0, playlist: 0 } };
      lastSearch = next;
      setRes(next);
    } catch (e) {
      if (c.signal.aborted || (e instanceof SpotifyApiError && e.code === "aborted")) return;
      music.toast(spotifyErrorText(e, t), "error");
    } finally {
      if (ctrl.current === c) setBusy(null);
    }
  };

  const moreBtn = (type: SearchType, has?: boolean) =>
    has ? (
      <button type="button" className="mt-pill mt-pill--sm spl-more" disabled={busy === type} onClick={() => void run(type)}>
        {busy === type && <IconSpinner size={14} />} {t("spl.more")}
      </button>
    ) : null;

  return (
    <>
      <form
        className="mt-search mt-search--static"
        role="search"
        onSubmit={(e) => {
          e.preventDefault();
          void run();
        }}
      >
        <span aria-hidden="true" className="mt-search__icon">
          <IconSearch size={20} />
        </span>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("spl.searchPh")} aria-label={t("spl.searchPh")} />
        <button type="submit" className="mt-pill mt-pill--solid" disabled={!q.trim() || busy === "all"}>
          {busy === "all" ? <IconSpinner size={16} title={t("music.loading")} /> : t("mt.search")}
        </button>
      </form>
      {res && (
        <>
          <h2 className="mt-h2 mt-h2--small">{t("spl.tracks")}</h2>
          <Songs tracks={res.page.tracks?.items ?? []} ctx={ctx} />
          {moreBtn("track", res.page.tracks?.more)}
          <h2 className="mt-h2 mt-h2--small">{t("spl.albums")}</h2>
          <Cards items={res.page.albums?.items ?? []} ctx={ctx} />
          {moreBtn("album", res.page.albums?.more)}
          <h2 className="mt-h2 mt-h2--small">{t("spl.playlists")}</h2>
          <Cards items={res.page.playlists?.items ?? []} ctx={ctx} />
          {moreBtn("playlist", res.page.playlists?.more)}
        </>
      )}
    </>
  );
}

// ---- One playlist / album, one artist ------------------------------------------------------

function BackLink({ ctx, here }: { ctx: Ctx; here: string }) {
  const { t } = useT();
  return (
    <button
      type="button"
      className="mt-link"
      onClick={() => {
        const inside = openedHere.has(here);
        mlog("splib: back", { from: here, how: inside ? "history" : "section" });
        if (inside) {
          openedHere.delete(here);
          history.back();
        } else ctx.go({ kind: "splib", sec: ctx.sec });
      }}
    >
      <IconBack size={15} /> {t("spl.back")}
    </button>
  );
}

function ListView({ type, id, ctx }: { type: "playlist" | "album"; id: string; ctx: Ctx }) {
  const { t } = useT();
  const here = openKey(type, id);
  const r = useSp<ListResult>(`${type}:${id}`, (s) => (type === "album" ? albumTracks(id, s) : playlistTracks(id, s)));
  if (r.error)
    return (
      <>
        <BackLink ctx={ctx} here={here} />
        <ErrorBox error={r.error} retry={r.retry} />
      </>
    );
  if (!r.data)
    return (
      <>
        <BackLink ctx={ctx} here={here} />
        <Loading />
      </>
    );
  const { item } = r.data;
  const ok = r.data.status === "ok" ? r.data : null;
  const count = ok ? ok.total : item.count;
  return (
    <>
      <BackLink ctx={ctx} here={here} />
      <div className="mt-hero mt-hero--artist spl-hero">
        <Cover src={item.cover} className="mt-hero__img" />
        <div className="mt-hero__text">
          <small>
            {t(type === "album" ? "sp.album" : "sp.playlist")}
            {item.mine ? ` · ${t("spl.mine")}` : item.collaborative ? ` · ${t("spl.collab")}` : ok ? "" : ` · ${t("spl.detailsOnly")}`}
          </small>
          <h1 className={`mt-clamp${titleCls(item.name)}`} title={item.name}>
            {item.name}
          </h1>
          <small>{[item.sub, typeof count === "number" ? t("mt.songs").replace("{n}", String(count)) : ""].filter(Boolean).join(" · ")}</small>
          <div className="spl-hero__attr">
            <FromSpotify />
            <OpenOnSpotify url={item.url} label={item.name} big />
          </div>
        </div>
      </div>
      {ok ? (
        <>
          <ImportPanel name={item.name} list={importListOf(item, ok.tracks)} url={item.url} ctx={ctx} />
          {ok.capped && <p className="mt-hint">{t("spl.capped", { n: ok.tracks.length, m: ok.total })}</p>}
          <Songs tracks={ok.tracks} ctx={ctx} />
        </>
      ) : (
        <div className="mt-hint spl-meta" role="note">
          <p style={{ margin: "0 0 6px" }}>{t("spl.metaOnly")}</p>
          <p style={{ margin: "0 0 8px" }}>{t("sp.pasteHow")}</p>
          <button type="button" className="mt-pill mt-pill--sm" onClick={() => ctx.go({ kind: "spotify" })}>
            {t("spl.pasteGo")}
          </button>
        </div>
      )}
    </>
  );
}

function ArtistView({ id, ctx }: { id: string; ctx: Ctx }) {
  const { t } = useT();
  const here = openKey("artist", id);
  const r = useSp(`artist:${id}`, (s) => artistAlbums(id, s));
  if (r.error)
    return (
      <>
        <BackLink ctx={ctx} here={here} />
        <ErrorBox error={r.error} retry={r.retry} />
      </>
    );
  if (!r.data)
    return (
      <>
        <BackLink ctx={ctx} here={here} />
        <Loading />
      </>
    );
  const a = r.data.artist;
  return (
    <>
      <BackLink ctx={ctx} here={here} />
      {a && (
        <div className="mt-hero mt-hero--artist spl-hero">
          <Cover src={a.cover} className="mt-hero__img spl-round" />
          <div className="mt-hero__text">
            <small>{t("spl.artist")}</small>
            <h1 className={`mt-clamp${titleCls(a.name)}`} title={a.name}>
              {a.name}
            </h1>
            <div className="spl-hero__attr">
              <FromSpotify />
              <OpenOnSpotify url={a.url} label={a.name} big />
            </div>
          </div>
        </div>
      )}
      <h2 className="mt-h2 mt-h2--small">{t("spl.albums")}</h2>
      {r.data.albums.length ? <Cards items={r.data.albums} ctx={ctx} /> : <p className="mt-hint">{t("spl.noAlbums")}</p>}
    </>
  );
}
