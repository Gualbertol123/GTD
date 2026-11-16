import { describe, expect, it } from "vitest";
import { classify, group, hasViews, onTopic, parseSortPrefs, parseViews, primaryOfficial, sortTracks, type RawResult, type TrackKind } from "../musicSort";

// Real results from YouTube.js (yt.search(q, { type: "video" }), lang it /
// location IT, November 2026): title, author.name, the badges
// (BADGE_STYLE_TYPE_VERIFIED_ARTIST = ♪ "Canale ufficiale dell'artista",
// BADGE_STYLE_TYPE_VERIFIED = ✓ "Verificato") and view_count, in YouTube's order.
type Row = [title: string, channel: string, badge: "A" | "V" | "", views: number];

const DESPACITO: Row[] = [
  ["Luis Fonsi - Despacito ft. Daddy Yankee", "Luis Fonsi", "A", 9175434113],
  ["Luis Fonsi ‒ Despacito (Lyrics / Lyric Video) ft. Daddy Yankee", "Taz Network", "V", 80233394],
  ["Justin Bieber - Despacito (Lyrics / Letra) ft. Luis Fonsi & Daddy Yankee", "7clouds", "V", 117327264],
  ["Luis Fonsi - Despacito (Letra / Lyrics) ft. Daddy Yankee", "Musica Milagrosa", "", 8984973],
  ["Despacito | Latin Afro House Remix | Club DJ Mix | Groovy Beats", "Groovy Beat", "A", 2964786],
  ["Luis Fonsi, Daddy Yankee - Despacito (Audio) ft. Justin Bieber", "Luis Fonsi", "A", 694226111],
  ["Luis Fonsi, Despacito ft,Daddy Yankee (Official Video)", "DJ DY", "A", 76666936],
  ["Erika Ender - Despacito (Ao Vivo)", "ONErpm", "V", 7158667],
  ["[4K 원테이크] 포레스텔라 - DESPACITO [불후의 명곡2 전설을 노래하다/Immortal Songs 2] | KBS 230715 방송", "KBS 레전드 케이팝", "", 37705174],
  ["Erika Ender & Roberto Carlos - Despacito (En Vivo)", "Erika Ender", "A", 108069181],
  ["Luis Fonsi Despacito ft. Daddy Yankee (audio)", "Luis Fonsi", "A", 2662655],
  ["Incredible Spanish Guitar Rendition Of Despacito By Imad Fares | Luis Fonsi Cover", "Imad Fares", "A", 53646154],
  ["#Despacito - Facundo Pisoli / Luis Fonsi / Sax", "Facundo Pisoli", "V", 88849294],
  ["Luis Fonsi: Despacito", "The Tonight Show Starring Jimmy Fallon", "V", 20065095],
  ["Despacito - Luis Fonsi (ft. Daddy Yankee) - Marlon Alves Dance MAs", "Marlon Alves Music", "A", 124659490],
];

const SERE_NERE: Row[] = [
  ["Tiziano Ferro - Sere Nere", "Tiziano Ferro", "A", 25046727],
  ["Tiziano Ferro - Sere Nere (Testo/Lyrics)", "7clouds Italy", "", 162127],
  ["Tiziano Ferro - Sere nere (Live @ San Siro 2015)", "Unique Voice", "", 789746],
  ["Tiziano Ferro - Sere nere (Live in Rome 2009) DVD", "kworb123", "", 196803],
  ["Tiziano ferro - Sere nere", "Italianmelodies", "", 2610021],
  ['Tommaso e Lorenza emozionano con "Sere Nere" di Tiziano Ferro | The Voice Generations Finale', "The Voice of Italy", "V", 55069],
  ["Tiziano Ferro Sere Nere + testo", "Musica per tutti", "", 1502511],
  ["Tiziano Ferro - Rosso Relativo (Official Video)", "Tiziano Ferro", "A", 8726478],
  ["Sere Nere (De Tardes) - Tiziano Ferro  LIVE", "DARIVEAN", "", 35956],
  ["Tiziano Ferro  - Sere Nere (Versione Karaoke Academy Italia)", "Karaoke Academy", "V", 777710],
  ["TIZIANO FERRO - Sere nere (Video con Testo)", "VIBELIST - Musica Italiana", "", 2447],
  ["sere nere ma è drill", "dielit", "", 672395],
];

const BLINDING: Row[] = [
  ["The Weeknd - Blinding Lights (Official Video)", "The Weeknd", "A", 1083284978],
  ["The Weeknd - Blinding Lights (Official Audio)", "The Weeknd", "A", 885433085],
  ["The Weeknd - Blinding Lights (Lyrics)", "7clouds", "V", 158633962],
  ["The Weeknd - Blinding Lights (Live On The 2020 MTV VMAs)", "The Weeknd", "A", 51074532],
  ["Blinding Lights by The Weeknd", "ButenkoDV", "", 20573707],
  ["The Weeknd - Blinding Lights (Extended 20 Minute Loop)", "IDMaxDi", "", 41277363],
  ["the weeknd - blinding lights (slowed + reverb)", "PLAYYYPRETEND", "", 26805589],
  ["The Weeknd ft. ROSALÍA - Blinding Lights [Remix] (Official Lyric Video)", "The Weeknd", "A", 51868877],
  ['The Weeknd: "Blinding Lights"', "The Late Show with Stephen Colbert", "V", 3802015],
  ["The Weeknd - Blinding Lights (10 Minutes Version)", "Music Beat", "", 43568357],
  ["X Ambassadors - Blinding Lights (The Weeknd Cover)", "X Ambassadors", "A", 10134733],
  ["BLINDING LIGHTS - THE WEEKND | DRUM COVER.", "El Estepario Siberiano", "V", 9946288],
];

const BOHEMIAN: Row[] = [
  ["Queen – Bohemian Rhapsody (Official Video Remastered)", "Queen Official", "A", 2117196723],
  ["Queen - Bohemian Rhapsody (Lyrics)", "7clouds Rock", "V", 7240628],
  ["Queen - Bohemian Rhapsody (Live Aid 1985)", "Live Aid e Queen Official", "", 316931754],
  ["The most INSANE Bohemian Rhapsody Flashmob you will ever see!!", "Julien Cohen", "", 48878100],
  ["Bohemian Rhapsody - We Will Rock You! (Rami Malek) | Netflix", "Still Watching Netflix", "V", 4600791],
  ["Bohemian Rhapsody | Trailer ufficiale [HD] | 20th Century FOX", "20th Century Studios", "V", 40971553],
  ["Queen - Bohemian Rhapsody (Karaoke Version)", "Sing King", "V", 57366071],
  ["Benson Boone with Special Guest Brian May - Bohemian Rhapsody (Live at Coachella 2025)", "Benson Boone", "A", 18643007],
];

const PAUSINI: Row[] = [
  ["Laura Pausini - La Solitudine (Official Video)", "laurapausinitv", "A", 100086510],
  ["La solitudine lyrics -Laura Pausini", "musicloverforevar", "", 5497122],
  ["Laura Pausini - La Solitudine (Remastered) [Audio HQ]", "GoldenMusic", "", 608683],
  ["Laura Pausini - La Solitudine (Official Audio)", "Laura Pausini Multimedia", "", 29254],
  ["Laura Pausini - La Solitudine • TopPop", "TopPop", "V", 101560],
  ["Laura Pausini - La solitudine (Live)", "laurapausinitv", "A", 261342],
];

const PERFECT: Row[] = [
  ["Ed Sheeran - Perfect (Official Music Video)", "Ed Sheeran", "A", 4264066158],
  ["Ed Sheeran - Perfect", "LatinHype", "", 229052643],
  ["Ed Sheeran - Perfect Symphony [with Andrea Bocelli] (Official Music Video)", "Ed Sheeran e Andrea Bocelli", "A", 571124807],
  ["Ed Sheeran - Perfect [Official Lyric Video]", "Ed Sheeran", "A", 284711883],
  ["Ed Sheeran - Perfect Duet (with Beyoncé) [Official Audio]", "Ed Sheeran", "A", 247821676],
  ["Ed Sheeran - Perfect (Official Music Video)", "Bad Boy Edd", "", 240735],
  ["Ed Sheeran - Perfect // Sub Español + Lyrics // Video Oficial", "BrunoTraductor Official", "V", 962366],
  ["Ed Sheeran ft. Andrea Bocelli - Perfect Symphony (Remastered)", "Ed Sheeran - Fan", "", 1572395],
];

const raw = ([title, channel, badge]: Row): RawResult => ({ title, channel, verifiedArtist: badge === "A", verified: badge === "V" });
const kinds = (rows: Row[]) => rows.map((r) => classify(raw(r)).kind);
const tracks = (rows: Row[]) =>
  rows.map((r, rank) => {
    const c = classify(raw(r));
    return { id: `v${rank}`, title: r[0], channel: r[1], kind: c.kind, tag: c.tag, rank, views: r[3] };
  });

describe("classify: real YouTube.js results", () => {
  it("despacito: the artist's own video and audio are official; lyric channels, remixes, covers and TV are not", () => {
    const k: TrackKind[] = ["official", "cover", "cover", "cover", "cover", "audio", "other", "live", "cover", "live", "audio", "cover", "cover", "live", "cover"];
    expect(kinds(DESPACITO)).toEqual(k);
    // ✓ "Verificato" lyric channels are not the artist; the ♪ badge on a channel not named in the title (DJ DY) is not enough.
    expect(classify(raw(DESPACITO[1])).tag).toBe("lyrics");
    expect(classify(raw(DESPACITO[4])).tag).toBe("edit");
    expect(classify(raw(DESPACITO[11])).tag).toBe("cover");
  });

  it("sere nere (IT): testo, karaoke, The Voice and a drill edit are unofficial; live versions are live", () => {
    expect(kinds(SERE_NERE)).toEqual(["official", "cover", "live", "live", "other", "cover", "cover", "official", "live", "cover", "cover", "cover"]);
    expect(classify(raw(SERE_NERE[6])).tag).toBe("lyrics");
    expect(classify(raw(SERE_NERE[11])).tag).toBe("edit");
  });

  it("blinding lights: official video, then official audio; the artist's own remix stays official, other people's edits do not", () => {
    expect(kinds(BLINDING)).toEqual(["official", "audio", "cover", "live", "other", "cover", "cover", "official", "live", "cover", "cover", "cover"]);
  });

  it("bohemian rhapsody: 'Queen Official' is Queen; Netflix, trailers, flashmobs and karaoke are not", () => {
    expect(kinds(BOHEMIAN)).toEqual(["official", "cover", "live", "cover", "other", "cover", "cover", "live"]);
  });

  it("la solitudine: a channel with the artist's name glued or with a suffix ('laurapausinitv', '… Multimedia') is the artist", () => {
    expect(kinds(PAUSINI)).toEqual(["official", "cover", "other", "audio", "live", "live"]);
  });

  it("perfect: a re-upload titled '(Official Music Video)' and a fan channel are not official", () => {
    expect(kinds(PERFECT)).toEqual(["official", "other", "official", "official", "audio", "other", "cover", "cover"]);
    expect(classify(raw(PERFECT[7])).tag).toBe("unofficial");
  });

  it("'- Topic' and VEVO channels (YouTube's official audio and the label's channel)", () => {
    expect(classify({ title: "Sere nere", channel: "Tiziano Ferro - Topic" }).kind).toBe("audio");
    expect(classify({ title: "Despacito", channel: "LuisFonsiVEVO" }).kind).toBe("official");
    expect(classify({ title: "Luis Fonsi - Despacito (Live)", channel: "LuisFonsiVEVO" }).kind).toBe("live");
    expect(classify({ title: "Sere nere (Karaoke Version)", channel: "Sing2Music - Topic" }).kind).toBe("cover");
  });

  it("the Data API fallback (channel name and title only, no badges)", () => {
    expect(classify({ title: "The Weeknd - Blinding Lights (Official Video)", channel: "TheWeekndVEVO" }).kind).toBe("official");
    expect(classify({ title: "Tiziano Ferro - Sere Nere", channel: "Tiziano Ferro" }).kind).toBe("official");
    expect(classify({ title: "Tiziano Ferro - Sere Nere (Testo/Lyrics)", channel: "7clouds Italy" }).kind).toBe("cover");
    expect(classify({ title: "Ed Sheeran - Perfect", channel: "LatinHype" }).kind).toBe("other");
  });

  it("does not take a song's own words for a version ('Live Forever', 'Piano Man', 'Dance Monkey', '4 Minutes')", () => {
    expect(classify({ title: "Oasis - Live Forever (Official Video)", channel: "Oasis", verifiedArtist: true }).kind).toBe("official");
    expect(classify({ title: "Billy Joel - Piano Man (Official HD Video)", channel: "Billy Joel", verifiedArtist: true }).kind).toBe("official");
    expect(classify({ title: "TONES AND I - DANCE MONKEY (OFFICIAL VIDEO)", channel: "Tones And I", verifiedArtist: true }).kind).toBe("official");
    expect(classify({ title: "Madonna - 4 Minutes (feat. Justin Timberlake & Timbaland) [Official Video]", channel: "Madonna", verifiedArtist: true }).kind).toBe("official");
    expect(classify({ title: "Billy Idol - Rebel Yell (Official Music Video)", channel: "Billy Idol", verifiedArtist: true }).kind).toBe("official");
  });

  it("scores the official video above its audio, live, the rest and covers", () => {
    const s = (r: RawResult) => classify(r).score;
    const video = s(raw(BLINDING[0]));
    const audio = s(raw(BLINDING[1]));
    const live = s(raw(BLINDING[3]));
    expect(video).toBeGreaterThan(audio);
    expect(audio).toBeGreaterThan(live);
    expect(live).toBeGreaterThan(s(raw(BLINDING[4])));
    expect(s(raw(BLINDING[4]))).toBeGreaterThan(s(raw(BLINDING[2])));
  });
});

describe("sorting and hiding", () => {
  it("official first: official video, official audio, live, the rest, covers last; YouTube's order inside each group", () => {
    const list = tracks(BLINDING);
    const out = sortTracks(list, "official", "blinding lights").map((t) => t.rank);
    expect(out).toEqual([0, 7, 1, 3, 8, 4, 2, 5, 6, 9, 10, 11]);
    // The input is not changed.
    expect(list.map((t) => t.rank)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
  });

  it("an official video of another song from the same artist is not put first", () => {
    const list = tracks(SERE_NERE);
    expect(onTopic(list[7], "tiziano ferro sere nere")).toBe(false);
    expect(group(list[7], "tiziano ferro sere nere")).toBe(3);
    const out = sortTracks(list, "official", "tiziano ferro sere nere");
    expect(out[0].title).toBe("Tiziano Ferro - Sere Nere");
    expect(out.slice(1, 4).every((t) => t.kind === "live")).toBe(true);
    expect(out.findIndex((t) => t.rank === 7)).toBeGreaterThan(out.findIndex((t) => t.rank === 4));
  });

  it("relevance is YouTube's order, most viewed is by views", () => {
    const list = tracks(DESPACITO);
    const shuffled = [...list].reverse();
    expect(sortTracks(shuffled, "relevance").map((t) => t.rank)).toEqual(list.map((t) => t.rank));
    const views = sortTracks(list, "views").map((t) => t.views);
    expect(views).toEqual([...views].sort((a, b) => b - a));
  });

  it("most viewed falls back to official first without view counts (Data API)", () => {
    const list = tracks(BLINDING).map(({ views: _v, ...t }) => t);
    expect(hasViews(list)).toBe(false);
    expect(sortTracks(list, "views", "blinding lights")).toEqual(sortTracks(list, "official", "blinding lights"));
  });

  it("hide removes covers, karaoke, lyric uploads and edits, keeps official, live and the rest", () => {
    const out = sortTracks(tracks(DESPACITO), "official", "despacito", true);
    expect(out.every((t) => t.kind !== "cover")).toBe(true);
    expect(out.map((t) => t.kind)).toEqual(["official", "audio", "audio", "live", "live", "live", "other"]);
  });

  it("results without a kind (an older answer) keep their order", () => {
    const list = [{ id: "a", title: "x", channel: "y" }, { id: "b", title: "z", channel: "w" }];
    expect(sortTracks(list, "official", "q").map((t) => t.id)).toEqual(["a", "b"]);
  });

  it("the 'Ufficiale' badge goes to the first official result of the song, else its official audio", () => {
    expect(primaryOfficial(sortTracks(tracks(PAUSINI), "relevance"), "laura pausini la solitudine")).toBe("v0");
    const noVideo = tracks(PAUSINI).filter((t) => t.kind !== "official");
    expect(primaryOfficial(noVideo, "laura pausini la solitudine")).toBe("v3");
    expect(primaryOfficial(tracks(SERE_NERE).slice(1), "tiziano ferro sere nere")).toBe(null);
  });
});

describe("prefs and view counts", () => {
  it("reads the stored choice, defaulting to official first, not hidden", () => {
    expect(parseSortPrefs(null)).toEqual({ mode: "official", hide: false });
    expect(parseSortPrefs("{oops")).toEqual({ mode: "official", hide: false });
    expect(parseSortPrefs('{"mode":"views","hide":true}')).toEqual({ mode: "views", hide: true });
    expect(parseSortPrefs('{"mode":"weird","hide":"yes"}')).toEqual({ mode: "official", hide: false });
  });

  it("parses YouTube's view text in Italian and English", () => {
    expect(parseViews("9.175.434.113 visualizzazioni")).toBe(9175434113);
    expect(parseViews("1,234 views")).toBe(1234);
    expect(parseViews("Nessuna visualizzazione")).toBe(0);
    expect(parseViews("")).toBeUndefined();
  });
});

describe("YouTube's newer layout and other artists' 'official' videos", () => {
  it("parses the short view counts of the LockupView layout", () => {
    expect(parseViews("2,1 Mld")).toBe(2_100_000_000);
    expect(parseViews("25 Mln")).toBe(25_000_000);
    expect(parseViews("1.2M views")).toBe(1_200_000);
    expect(parseViews("870K")).toBe(870_000);
  });

  it("an 'Official Music Video' of the song by another act (KIDZ BOP) goes with the rest", () => {
    const rows: Row[] = [
      ["The Weeknd - Blinding Lights (Official Video)", "The Weeknd", "A", 1083289142],
      ["The Weeknd - Blinding Lights (Official Audio)", "The Weeknd", "A", 885433782],
      ["The Weeknd - Blinding Lights (Lyrics)", "7clouds", "V", 158634190],
      ["Blinding Lights by The Weeknd", "ButenkoDV", "", 20573756],
      ["KIDZ BOP Kids - Blinding Lights (Official Music Video)", "KIDZ BOP", "", 18617653],
      ["The Weeknd - Blinding Lights (Live On Jimmy Kimmel Live! / 2020)", "The Weeknd", "A", 15750565],
    ];
    const list = tracks(rows);
    expect(list[4].kind).toBe("official");
    expect(sortTracks(list, "official", "blinding lights").map((t) => t.rank)).toEqual([0, 1, 5, 3, 4, 2]);
  });
});
