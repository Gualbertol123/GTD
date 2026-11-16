// Spotify → YouTube matching (netlify/lib/songMatch.mts, matchSong in
// netlify/lib/ytjs.mts). The candidates are real YouTube.js answers (search
// results seen from a server in Nov 2026), trimmed to the fields used.

import { afterEach, describe, expect, it, vi } from "vitest";
import { bestMatch, fold, oneEdit, parseSpotify, queries, scoreCandidate, titleWords, type MatchCandidate } from "../../../netlify/lib/songMatch.mts";

// ---- YouTube.js node shapes --------------------------------------------------

const text = (t: string) => ({ text: t, toString: () => t });
const mmss = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;

/** A YouTube.js `Video` node (yt.search(q, { type: "video" }).videos). */
function videoNode(id: string, title: string, channel: string, seconds: number, badge?: "artist" | "verified") {
  const style = badge === "artist" ? "BADGE_STYLE_TYPE_VERIFIED_ARTIST" : badge === "verified" ? "BADGE_STYLE_TYPE_VERIFIED" : null;
  return {
    type: "Video",
    video_id: id,
    title: text(title),
    author: { name: channel, badges: style ? [{ style }] : [], is_verified: badge === "verified", is_verified_artist: badge === "artist" },
    duration: { text: mmss(seconds), seconds },
    length_text: text(mmss(seconds)),
  };
}

/** A `LockupView` node (YouTube's newer search layout, served to some requests). */
function lockupNode(id: string, title: string, channel: string, seconds: number) {
  return {
    type: "LockupView",
    content_id: id,
    content_type: "VIDEO",
    metadata: { title: text(title), metadata: { metadata_rows: [{ metadata_parts: [{ text: text(channel) }, { text: text("1,2 Mln di visualizzazioni") }] }] } },
    duration: { text: mmss(seconds), seconds },
  };
}

/** A YouTube Music song (`MusicResponsiveListItem`, item_type "song"), as yt.music.search(q, { type: "song" }) gives it. */
function songNode(id: string, title: string, artists: string[], seconds: number) {
  return {
    type: "MusicResponsiveListItem",
    item_type: "song",
    id,
    title,
    artists: artists.map((name) => ({ name, channel_id: "UC" + "x".repeat(22) })),
    album: { name: "Album", id: "MPREb_x" },
    duration: { text: mmss(seconds), seconds },
  };
}

/** The same results as candidates (what matchSong scores). */
const cand = (id: string, title: string, channel: string, seconds: number, extra: Partial<MatchCandidate> = {}, rank = 0): MatchCandidate => ({
  id,
  title,
  channel,
  ms: seconds * 1000,
  source: "video",
  rank,
  ...extra,
});

// "Queen Bohemian Rhapsody": real results, in YouTube's order.
const BOHEMIAN: MatchCandidate[] = [
  cand("fJ9rUzIMcZQ", "Queen – Bohemian Rhapsody (Official Video Remastered)", "Queen Official", 360, { verifiedArtist: true }, 0),
  cand("vbvyNnw8Qjg", "Queen - Bohemian Rhapsody (Live Aid 1985)", "Live Aid e Queen Official", 165, {}, 1),
  cand("5zLnaNY58j8", "Queen - Bohemian Rhapsody (Lyrics)", "7clouds Rock", 355, { verified: true }, 2),
  cand("8ydY8-Uzah8", "Queen - Bohemian Rhapsody Performed in 42 Styles", "Anthony Vincent", 501, {}, 3),
  cand("PadKCVBIN94", "Queen - Bohemian Rhapsody 1981 Live Video Full HD", "NEA ZIXNH", 316, {}, 4),
  cand("kRaOkE00001", "Bohemian Rhapsody (Karaoke Version)", "Sing King", 355, {}, 5),
];

// ---- Normalization -------------------------------------------------------------

describe("parseSpotify", () => {
  it("drops remaster suffixes and keeps the title", () => {
    for (const t of ["Bohemian Rhapsody - Remastered 2011", "Bohemian Rhapsody - 2011 Remaster", "Bohemian Rhapsody (Remastered)", "Bohemian Rhapsody - Remaster"]) {
      const s = parseSpotify(t, "Queen", 354320);
      expect(s.core).toBe("Bohemian Rhapsody");
      expect(s).toMatchObject({ live: false, remix: false, edit: false, hint: "", artists: ["Queen"] });
    }
  });

  it("moves feat. / with / con into the artists", () => {
    expect(parseSpotify("2 GIORNI DI FILA (feat. Sfera Ebbasta, ANNA)", "Geolier, Sfera Ebbasta, ANNA")).toMatchObject({
      core: "2 GIORNI DI FILA",
      artists: ["Geolier", "Sfera Ebbasta", "ANNA"],
    });
    expect(parseSpotify("Canto d’amore (con Marco Mengoni)", "Angelina Mango").artists).toEqual(["Angelina Mango", "Marco Mengoni"]);
    expect(parseSpotify("Girl, so confusing featuring lorde", "Charli xcx")).toMatchObject({ core: "Girl, so confusing", artists: ["Charli xcx", "lorde"] });
    expect(parseSpotify("Belly (feat. Bossman Birdie, Frisco, JME & Queenie)", "Skepta").artists).toEqual(["Skepta", "Bossman Birdie", "Frisco", "JME", "Queenie"]);
  });

  it("drops soundtrack, mono and edit notes; keeps the hints that change the recording", () => {
    expect(parseSpotify('Holding Out for a Hero - From "Footloose" Soundtrack', "Bonnie Tyler").core).toBe("Holding Out for a Hero");
    expect(parseSpotify('Mrs. Robinson - From "The Graduate" Soundtrack', "Simon & Garfunkel")).toMatchObject({ core: "Mrs. Robinson", artists: ["Simon", "Garfunkel"] });
    expect(parseSpotify("God Only Knows - Mono / Remastered", "The Beach Boys").core).toBe("God Only Knows");
    expect(parseSpotify("About A Girl - Live", "Nirvana")).toMatchObject({ core: "About A Girl", live: true, hint: "live" });
    expect(parseSpotify("Pós - Ao Vivo", "Felipe e Rodrigo")).toMatchObject({ core: "Pós", live: true });
    expect(parseSpotify("Nothing Arrived - Live from Spotify London", "Villagers")).toMatchObject({ core: "Nothing Arrived", live: true });
    expect(parseSpotify("Cheerleader (Felix Jaehn Remix) - Radio Edit", "OMI, felix jaehn")).toMatchObject({
      core: "Cheerleader",
      remix: true,
      edit: true,
      hint: "Felix Jaehn Remix",
    });
    expect(parseSpotify("Rathinamo - Female Version", "Saurav Srisan").hint).toBe("female version");
    expect(parseSpotify("You And I - Moon And Stars / Acoustic", "Valerie June")).toMatchObject({ core: "You And I", acoustic: true });
  });

  it("keeps a dash that is part of the title, and drops subtitles in brackets", () => {
    expect(parseSpotify("NEON - Le Ali", "Marracash, Elisa").core).toBe("NEON - Le Ali");
    expect(parseSpotify('Veezha Veera (From "OM Chapter 1: Udhiram - The Blood Wood") [Tamil]', "Sai Abhyankkar").core).toBe("Veezha Veera");
    expect(parseSpotify("Rocket Man (I Think It's Going To Be A Long, Long Time)", "Elton John").core).toBe("Rocket Man");
    expect(parseSpotify("(We're Gonna) Rock Around The Clock", "Bill Haley & His Comets").core).toBe("Rock Around The Clock");
  });

  it("strips invisible marks and quotes; a title that is all brackets survives", () => {
    expect(parseSpotify("‎Good Night Good Dream", "Nerd Connection").core).toBe("Good Night Good Dream");
    expect(parseSpotify('"Heroes" - 2017 Remaster', "David Bowie").core).toBe("Heroes");
    expect(parseSpotify("(Untitled)", "Sigur Rós").core).toBe("Untitled");
  });

  it("ignores version words in titles, unless nothing else is left", () => {
    expect(titleWords("Wonderwall (Official Video) Remastered")).toEqual(["wonderwall"]);
    expect(titleWords("With")).toEqual(["with"]);
    expect(titleWords("Felicità")).toEqual(["felicita"]);
    expect(titleWords("체포하겠어")).toEqual(["체포하겠어"]);
    expect(titleWords("ブルーアンバー")).toEqual(["ブルーアンバー"]);
    expect(fold("Måneskin – ZITTI E BUONI!")).toBe("maneskin zitti e buoni");
  });
});

describe("queries", () => {
  it("artist + title first, then title + artists, then the title alone", () => {
    expect(queries(parseSpotify("Bohemian Rhapsody - Remastered 2011", "Queen"))).toEqual(["Queen Bohemian Rhapsody", "Bohemian Rhapsody Queen", "Bohemian Rhapsody"]);
    expect(queries(parseSpotify("Come As You Are - Live", "Nirvana"))).toEqual(["Nirvana Come As You Are live", "Come As You Are Nirvana live", "Come As You Are live"]);
    expect(queries(parseSpotify("2 GIORNI DI FILA (feat. Sfera Ebbasta, ANNA)", "Geolier"))).toEqual([
      "Geolier 2 GIORNI DI FILA",
      "2 GIORNI DI FILA Geolier Sfera Ebbasta ANNA",
      "2 GIORNI DI FILA",
    ]);
  });
});

// ---- Scoring and the threshold ---------------------------------------------------

describe("scoreCandidate / bestMatch", () => {
  const bohemian = parseSpotify("Bohemian Rhapsody - Remastered 2011", "Queen", 354320);

  it("YouTube Music's official audio, same length, wins over the music video", () => {
    const topic = cand("eTopic00001", "Bohemian Rhapsody (Remastered 2011)", "Queen - Topic", 355, { source: "music", artists: ["Queen"] }, 0);
    const best = bestMatch(bohemian, [...BOHEMIAN, topic]);
    expect(best?.c.id).toBe("eTopic00001");
    expect(best?.r).toMatchObject({ sure: true, confidence: 1 });
  });

  it("without it: the official video, never live, the 42-styles cover or karaoke", () => {
    const best = bestMatch(bohemian, BOHEMIAN);
    expect(["fJ9rUzIMcZQ", "5zLnaNY58j8"]).toContain(best?.c.id);
    expect(scoreCandidate(bohemian, BOHEMIAN[5]).accept).toBe(false); // karaoke
    expect(scoreCandidate(bohemian, BOHEMIAN[1]).score).toBeLessThan(scoreCandidate(bohemian, BOHEMIAN[0]).score); // Live Aid
    expect(scoreCandidate(bohemian, BOHEMIAN[4]).score).toBeLessThan(scoreCandidate(bohemian, BOHEMIAN[0]).score);
  });

  it("live asked for: the live recording, not the studio video", () => {
    const s = parseSpotify("Come As You Are - Live", "Nirvana", 253906);
    const list = [
      cand("z9LiPuVRyU8", "Nirvana - Come As You Are (Live On MTV Unplugged, 1993 / Unedited)", "Nirvana", 276, { verifiedArtist: true }, 0),
      cand("NJqQf5DObtY", "Nirvana - Come As You Are (Live at Reading 1992)", "Nirvana", 216, { verifiedArtist: true }, 2),
      cand("vabnZ9-ex7o", "Nirvana - Come As You Are (Official Music Video)", "Nirvana", 225, { verifiedArtist: true }, 4),
      cand("EU-Hd_dsg4c", "Nirvana - Come As You Are (Live On MTV Unplugged, 1993 / Rehearsal)", "Nirvana", 283, { verifiedArtist: true }, 5),
    ];
    expect(bestMatch(s, list)?.c.id).toBe("z9LiPuVRyU8");
  });

  it("studio asked for: not a live one", () => {
    const s = parseSpotify("Cherry Wine", "Hozier", 240147);
    const studio = cand("SdSCCwtNEjA", "Hozier - Cherry Wine", "HozierVEVO", 254, {}, 1);
    const live = cand("liveliveliv", "Hozier - Cherry Wine (Live)", "HozierVEVO", 240, {}, 0);
    expect(bestMatch(s, [live, studio])?.c.id).toBe("SdSCCwtNEjA");
  });

  it("below the threshold: another artist's song of the same name is not found", () => {
    const s = parseSpotify("Epiphany", "Copenhagen Jazzexperience, Claus Waidtløw, Jacob Christoffersen", 213823);
    const list = [
      cand("BnEgnrUCXPY", "The Yussef Dayes Experience - Live From Malibu", "Yussef Dayes", 1996, { verifiedArtist: true }, 0),
      cand("vbBVrfkFe2I", 'Trent Reznor and Atticus Ross - Epiphany (From "Soul")', "DisneyMusicVEVO", 238, { verified: true }, 1),
      cand("Yj7CUS2we7A", "FKJ’s Full Set at Seoul Jazz Festival 2024/06/01 [4K]", "RecmRoom", 5060, {}, 5),
    ];
    expect(bestMatch(s, list)).toBeNull();
  });

  it("below the threshold: a fan's concert recording minutes longer", () => {
    const s = parseSpotify("Dime Si Eres Tú", "Melissa Aldana", 239610);
    const fan = cand("fanconcert1", "Dime si eres tú. Melissa Aldana. Bs.As. 20 de octubre de 2026", "Osvaldo Andrés García", 580);
    expect(scoreCandidate(s, fan).accept).toBe(false);
  });

  it("titles in another script: found by the words, or by the artist's own upload of the same length", () => {
    const illit = parseSpotify("체포하겠어", "ILLIT", 181911);
    const mv = cand("V2V9-9VhYJo", "ILLIT (아일릿) '체포하겠어 (You’re Under Arrest)’ Official MV", "HYBE LABELS", 190, { verified: true });
    expect(scoreCandidate(illit, mv)).toMatchObject({ accept: true, titleHit: 1, artistHit: 1 });

    const adult = parseSpotify("The Adult I Dreamed Of", "머무르", 207428);
    const own = cand("GxChUrrY4bc", "꿈꾸던 어른이 되었나요?", "머무르 MEOMURU", 206);
    const subs = cand("YBJszJ3kIcQ", "머무르(MEOMURU) -꿈꾸던 어른이 되었나요?(The Adult I Dreamed Of？) [韓繁中字]", "Pointone", 205);
    expect(scoreCandidate(adult, own).accept).toBe(true);
    expect(scoreCandidate(adult, subs).accept).toBe(true);
    // Another script but not the artist's channel, or not the same length: no.
    expect(scoreCandidate(adult, cand("other000001", "꿈꾸던 어른이 되었나요?", "노래방", 206)).accept).toBe(false);
    expect(scoreCandidate(adult, cand("other000002", "꿈꾸던 어른이 되었나요?", "머무르 MEOMURU", 260)).accept).toBe(false);
  });

  it("a word one letter off still counts", () => {
    expect(oneEdit("bbbbbooter", "bbbbooter")).toBe(true);
    expect(oneEdit("kitten", "sittin")).toBe(false);
    const s = parseSpotify("BBBBBOOTER", "Booter Bee", 117551);
    const mv = cand("JreryY6WnIo", "BOOTER BEE - BBBBOOTER [Official Music Video] #TheBuzz", "Booter Bee", 134, { verifiedArtist: true });
    const reaction = cand("w4tvycjcdTc", "BOOTER BEE - BBBOOTER [Video Musicale Ufficiale] #TheBuzz (REACTION)", "Walkz", 470);
    expect(bestMatch(s, [reaction, mv])?.c.id).toBe("JreryY6WnIo");
  });

  it("an artist named differently: the whole title to the second still counts, with less confidence", () => {
    const s = parseSpotify("Young and Foolish", "Chad Lefkowitz-Brown", 492272);
    const r = scoreCandidate(s, cand("ykgGtQdGwd0", "Young and Foolish - Chad LB Quartet", "Chad LB", 492));
    expect(r).toMatchObject({ accept: true, artistHit: 0, titleHit: 1 });
    expect(r.confidence).toBeLessThan(0.75);
    // A few seconds off, it is just another "Young and Foolish".
    expect(scoreCandidate(s, cand("ykgGtQdGwd1", "Young and Foolish", "Someone Trio", 300)).accept).toBe(false);
  });

  it("confidence: 1 for the same recording, lower for a longer music video, a remix not asked for…", () => {
    const s = parseSpotify("Blinding Lights", "The Weeknd", 200040);
    const audio = scoreCandidate(s, cand("audio000001", "The Weeknd - Blinding Lights (Official Audio)", "TheWeekndVEVO", 201));
    const video = scoreCandidate(s, cand("video000001", "The Weeknd - Blinding Lights (Official Video)", "TheWeekndVEVO", 262));
    const remix = scoreCandidate(s, cand("remix000001", "The Weeknd - Blinding Lights (Chromatics Remix)", "TheWeekndVEVO", 200));
    expect(audio.confidence).toBe(1);
    expect(video.confidence).toBeLessThan(audio.confidence);
    expect(video.accept).toBe(true);
    expect(remix.score).toBeLessThan(audio.score);
    expect(remix.confidence).toBeLessThan(0.75);
  });

  it("no length from Spotify: title and artist still decide", () => {
    const s = parseSpotify("Albachiara", "Vasco Rossi", 0);
    const r = scoreCandidate(s, cand("albachiara1", "Vasco Rossi - Albachiara (Official Video)", "VascoRossiVEVO", 260));
    expect(r).toMatchObject({ accept: true, delta: null });
  });
});

// ---- YouTube.js answers → candidates, and the search cascade --------------------

describe("matchSong (YouTube.js mocked)", () => {
  afterEach(() => {
    vi.doUnmock("youtubei.js");
    vi.resetModules();
  });

  /** ytjs.mts with a fake Innertube whose answers come from `video` / `music` (by query). */
  async function load(video: (q: string) => any[] | Promise<any[]>, music: (q: string) => any[] | Promise<any[]> = () => []) {
    vi.resetModules();
    const calls: string[] = [];
    const yt = {
      search: vi.fn(async (q: string) => {
        calls.push(`video:${q}`);
        return { videos: await video(q) };
      }),
      music: {
        search: vi.fn(async (q: string) => {
          calls.push(`music:${q}`);
          const items = await music(q);
          return { contents: items.length ? [{ type: "MusicShelf", contents: items }] : [{ type: "ItemSection", contents: [{ type: "Message" }] }] };
        }),
      },
    };
    vi.doMock("youtubei.js", () => ({ Innertube: { create: async () => yt }, Log: { setLevel: () => {}, Level: { ERROR: 0 } } }));
    const mod = await import("../../../netlify/lib/ytjs.mts");
    return { mod, calls };
  }

  it("reads Video, LockupView and YouTube Music song nodes", async () => {
    const { mod } = await load(() => []);
    const v = mod.videoCandidates([videoNode("fJ9rUzIMcZQ", "Queen – Bohemian Rhapsody (Official Video Remastered)", "Queen Official", 360, "artist"), lockupNode("GxChUrrY4bc", "꿈꾸던 어른이 되었나요?", "머무르 MEOMURU", 205)]);
    expect(v).toEqual([
      { id: "fJ9rUzIMcZQ", title: "Queen – Bohemian Rhapsody (Official Video Remastered)", channel: "Queen Official", ms: 360000, verifiedArtist: true, verified: false, source: "video", rank: 0 },
      { id: "GxChUrrY4bc", title: "꿈꾸던 어른이 되었나요?", channel: "머무르 MEOMURU", ms: 205000, verifiedArtist: false, verified: false, source: "video", rank: 1 },
    ]);
    const m = mod.musicCandidates([{ type: "MusicShelf", contents: [songNode("eTopic00001", "Bohemian Rhapsody", ["Queen"], 355)] }]);
    expect(m).toEqual([{ id: "eTopic00001", title: "Bohemian Rhapsody", channel: "Queen - Topic", artists: ["Queen"], ms: 355000, source: "music", rank: 0 }]);
  });

  it("takes YouTube Music's official audio, with its confidence and length", async () => {
    const { mod } = await load(
      () => BOHEMIAN.map((c) => videoNode(c.id, c.title, c.channel, c.ms / 1000)),
      () => [songNode("eTopic00001", "Bohemian Rhapsody (Remastered 2011)", ["Queen"], 355)]
    );
    expect(await mod.matchSong("Bohemian Rhapsody - Remastered 2011", "Queen", 354320)).toEqual({
      id: "eTopic00001",
      title: "Bohemian Rhapsody (Remastered 2011)",
      channel: "Queen",
      thumb: "https://i.ytimg.com/vi/eTopic00001/mqdefault.jpg",
      confidence: 1,
      ms: 355000,
    });
  });

  it("stops at the first sure match; goes on down the cascade otherwise; null below the threshold", async () => {
    const { mod, calls } = await load((q) =>
      q === "Queen Bohemian Rhapsody" ? [videoNode("xG16sdjLtc0", "Queen - Bohemian Rhapsody (Remastered 2011)", "Queen - Topic", 355)] : []
    );
    expect((await mod.matchSong("Bohemian Rhapsody - Remastered 2011", "Queen", 354320))?.id).toBe("xG16sdjLtc0");
    expect(calls.filter((c) => c.startsWith("video:"))).toEqual(["video:Queen Bohemian Rhapsody"]);

    calls.length = 0;
    expect(await mod.matchSong("Epiphany", "Copenhagen Jazzexperience", 213823)).toBeNull();
    expect(calls.filter((c) => c.startsWith("video:"))).toEqual(["video:Copenhagen Jazzexperience Epiphany", "video:Epiphany Copenhagen Jazzexperience", "video:Epiphany"]);
  });

  it("stops asking YouTube Music after answers with no songs in a row", async () => {
    const { mod, calls } = await load(() => []);
    for (const t of ["a1", "b2", "c3", "d4", "e5", "f6"]) await mod.matchSong(`Song ${t}`, "Nobody", 200000);
    expect(calls.filter((c) => c.startsWith("music:"))).toHaveLength(4);
  });

  it("time running out with nothing found: TimeoutError (the song goes in `failed`)", async () => {
    const { mod } = await load(() => [videoNode("unrelated01", "Something else entirely", "Other", 100)]);
    const { TimeoutError } = await import("../../../netlify/lib/http.mts");
    await expect(mod.matchSong("Epiphany", "Copenhagen Jazzexperience", 213823, Date.now() + 1000)).rejects.toBeInstanceOf(TimeoutError);
  });

  it("a later search failing keeps the match found before; failing with nothing found throws", async () => {
    const ok = videoNode("vabnZ9-ex7o", "Nirvana - Come As You Are (Official Music Video)", "Nirvana", 225, "artist");
    const { mod } = await load((q) => {
      if (q.startsWith("Nirvana")) return [ok];
      throw new Error("403");
    });
    // The studio video is acceptable but not sure for a live song: the cascade goes on, YouTube fails, the video stays.
    const m = await mod.matchSong("Come As You Are - Live", "Nirvana", 253906);
    expect(m?.id).toBe("vabnZ9-ex7o");
    expect(m!.confidence).toBeLessThan(0.75);
    await expect(mod.matchSong("Nothing", "Nobody", 1000)).rejects.toThrow("403");
  });
});
