// Music strings for the "core" area (lib/music.ts, MusicPlayer.tsx). Same keys
// in both languages (i18n test).

export const CORE_IT: Record<string, string> = {
  "music.slowNetwork": "Connessione lenta: riprendo il brano dallo stesso punto…",
  "music.noConnection": "Sei offline: il brano riparte appena torna la connessione.",
  "music.lastSong": "È l'ultimo brano della coda (attiva Ripeti per ricominciare).",
  "music.loading": "Caricamento",
  "music.seek": "Posizione nel brano",
  "music.retry": "Riprova",
  // Shown with YouTube's frame (needsTap): a tap inside it always starts the music.
  "music.tapToPlay": "La riproduzione non è partita: tocca il video per avviare.",
  "music.stalled": "YouTube non riesce a caricare il brano: tocca il video per avviare.",
  "music.tapToUnmute": "YouTube ha tolto l'audio: tocca il video per riattivarlo.",
  "music.playerError": "Il lettore di YouTube non riesce a riprodurre qui.",
  "music.noPlayable": "Nessun brano di questa coda si può riprodurre qui.",
  "music.endUnavailable": "Brano non riproducibile qui, e la coda è finita.",
  "music.radioLoading": "Radio in caricamento: intanto suona questo brano.",
  "music.err.login": "Accedi di nuovo per usare la musica.",
  "music.err.offline": "Sei offline: controlla la connessione e riprova.",
  "music.err.timeout": "YouTube non ha risposto in tempo: riprova.",
  "music.err.noFunctions": "Le funzioni della musica non sono attive qui (sviluppo locale).",
  "music.err.notFound": "Non trovato.",
  "music.err.unavailable": "YouTube non risponde in questo momento: riprova tra poco.",
  "music.err.server": "Qualcosa non ha funzionato: riprova.",
};

export const CORE_EN: Record<string, string> = {
  "music.slowNetwork": "Slow connection: picking the song up from the same point…",
  "music.noConnection": "You're offline: the song goes on as soon as the connection is back.",
  "music.lastSong": "This is the last song in the queue (turn on Repeat to start over).",
  "music.loading": "Loading",
  "music.seek": "Seek",
  "music.retry": "Retry",
  "music.tapToPlay": "Playback didn't start: tap the video to start.",
  "music.stalled": "YouTube can't load the song: tap the video to start.",
  "music.tapToUnmute": "YouTube muted the sound: tap the video to turn it on.",
  "music.playerError": "YouTube's player can't play here.",
  "music.noPlayable": "None of the songs in this queue can play here.",
  "music.endUnavailable": "That song can't play here, and the queue has ended.",
  "music.radioLoading": "Loading the radio: this song plays meanwhile.",
  "music.err.login": "Sign in again to use music.",
  "music.err.offline": "You're offline: check the connection and try again.",
  "music.err.timeout": "YouTube didn't answer in time: try again.",
  "music.err.noFunctions": "The music functions aren't running here (local development).",
  "music.err.notFound": "Not found.",
  "music.err.unavailable": "YouTube isn't answering right now: try again shortly.",
  "music.err.server": "Something went wrong: try again.",
};
