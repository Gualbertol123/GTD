// -----------------------------------------------------------------------------
// Pure helpers for the MUSIC tab (components/MusicTab.tsx), kept apart so they
// can be unit-tested without React.
//
//   the tab's page ⇄ the URL hash sub-route (#/music/playlist/<id>, …)
//   stable row keys for song lists that may hold the same song twice
//   country names for the charts, one Intl formatter per language
// -----------------------------------------------------------------------------

export type View =
  | { kind: "home" }
  | { kind: "search"; q?: string }
  | { kind: "import" }
  | { kind: "spotify" }
  | { kind: "yt"; list: string }
  | { kind: "artist"; name: string }
  | { kind: "martist"; id: string; name: string }
  | { kind: "playlist"; id: string };

const enc = encodeURIComponent;
function dec(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/**
 * The hash sub-route for a page ("" = Home). Each part is encoded on its own,
 * so a name with a "/" survives (history.ts encodes the whole sub once more).
 */
export function viewSub(v: View): string {
  switch (v.kind) {
    case "home":
      return "";
    case "search":
      return v.q?.trim() ? `search/${enc(v.q.trim())}` : "search";
    case "import":
      return "import";
    case "spotify":
      return "spotify";
    case "yt":
      return `yt/${enc(v.list)}`;
    case "artist":
      return `artist/${enc(v.name)}`;
    case "martist":
      return `martist/${enc(v.id)}/${enc(v.name)}`;
    case "playlist":
      return `playlist/${enc(v.id)}`;
  }
}

/** The page for a hash sub-route; anything unknown is Home. */
export function parseView(sub: string | undefined | null): View {
  if (!sub) return { kind: "home" };
  const [kind, a, b] = sub.split("/");
  switch (kind) {
    case "search":
      return a ? { kind: "search", q: dec(a) } : { kind: "search" };
    case "import":
      return { kind: "import" };
    case "spotify":
      return { kind: "spotify" };
    case "yt":
      return a ? { kind: "yt", list: dec(a) } : { kind: "import" };
    case "artist":
      return a ? { kind: "artist", name: dec(a) } : { kind: "home" };
    case "martist":
      return a ? { kind: "martist", id: dec(a), name: b ? dec(b) : "" } : { kind: "home" };
    case "playlist":
      return a ? { kind: "playlist", id: dec(a) } : { kind: "home" };
    default:
      return { kind: "home" };
  }
}

/**
 * React keys for a song list: the id plus how many times it came before
 * ("abc#0", "abc#1"). A key stays the same when other rows move or go, and
 * stays unique when a list holds the same song twice.
 */
export function rowKeys(items: { id: string }[]): string[] {
  const seen = new Map<string, number>();
  return items.map((t) => {
    const n = seen.get(t.id) ?? 0;
    seen.set(t.id, n + 1);
    return `${t.id}#${n}`;
  });
}

const regionNames = new Map<string, Intl.DisplayNames | null>();

/** A country's name in the UI language ("ZZ" = the world). One formatter per language. */
export function countryName(code: string, lang: string, world: string): string {
  if (code === "ZZ") return world;
  let f = regionNames.get(lang);
  if (f === undefined) {
    try {
      f = new Intl.DisplayNames([lang], { type: "region" });
    } catch {
      f = null;
    }
    regionNames.set(lang, f);
  }
  try {
    return f?.of(code) ?? code;
  } catch {
    return code;
  }
}

/** Is this result a failure? (the music helpers answer `{ error }`). */
export function isFail(r: unknown): r is { error: string } {
  return !!r && typeof r === "object" && typeof (r as { error?: unknown }).error === "string";
}
