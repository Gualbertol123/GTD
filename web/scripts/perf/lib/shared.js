// Deterministic fake catalogue, shared VERBATIM by Node (mocks.mjs evaluates
// this file) and the browser (prepended to the fake YouTube IFrame API).
// Plain script: no import/export. Every song's title, artist, length,
// buffering time and "can it play here" follow from its 11-char id alone, so
// the fake player and the fake server functions always agree.

function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

var B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/** An 11-char YouTube-like id from any seed string. */
function vid(seed) {
  let out = "";
  let h = fnv1a(seed);
  for (let i = 0; out.length < 11; i++) {
    h = fnv1a(seed + ":" + i + ":" + h);
    out += B64[h & 63] + B64[(h >>> 6) & 63];
  }
  return out.slice(0, 11);
}

var ADJ = ["Notte", "Cuore", "Estate", "Luce", "Vento", "Mare", "Fuoco", "Stella", "Sogno", "Strada", "Pioggia", "Cielo", "Alba", "Ombra", "Città", "Lacrime", "Bacio", "Tempo", "Amore", "Silenzio"];
var NOUN = ["infinita", "d'oro", "lontana", "perfetta", "nuova", "di vetro", "selvaggia", "segreta", "blu", "latina", "eterna", "senza fine", "di carta", "rossa", "gentile", "ribelle", "sincera", "felice", "fragile", "magica"];
var ARTISTS_F = ["Tiziano Ferro", "Enrique Iglesias", "Ricky Martin", "Laura Pausini", "Eros Ramazzotti", "Elisa", "Annalisa", "Mahmood", "Rosalía", "Shakira", "Marco Mengoni", "Elodie", "Jovanotti", "Alvaro Soler", "Bad Bunny", "Giorgia"];

/** A song title: "<Word> <word> [abcd]" (the bracket = the id's first 4 chars, so titles are unique). */
function titleFor(id) {
  const h = fnv1a("t:" + id);
  return ADJ[h % 20] + " " + NOUN[(h >>> 5) % 20] + " [" + id.slice(0, 4) + "]";
}
function artistFor(id) {
  return ARTISTS_F[(fnv1a("a:" + id) >>> 3) % ARTISTS_F.length];
}
/** Song length, 150–259 s. */
function durationFor(id) {
  return 150 + (fnv1a("d:" + id) % 110);
}
/** Buffering before PLAYING, 1000–2000 ms. */
function bufferFor(id) {
  return 1000 + (fnv1a("b:" + id) % 1001);
}
/** ~1 in 8 videos refuse to play embedded (onError 150). */
function isBad(id) {
  return fnv1a("e:" + id) % 8 === 0;
}
/** A song title in this catalogue? */
var SONG_TITLE_RE = /\[[\w-]{4}\]$/;
