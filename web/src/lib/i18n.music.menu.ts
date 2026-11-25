// Music strings for the "menu" area (components/SongMenu.tsx). Same keys in
// both languages (i18n test).

export const MENU_IT: Record<string, string> = {
  "sm.more": "Altre azioni",
  "sm.created": "Playlist «{p}» creata",
  "sm.removed": "Tolto dalla playlist",
  "sm.copyHint": "Copia questo link:",
  "sm.addFail": "Non aggiunto a «{p}»",
  "sm.createFail": "Playlist «{p}» non salvata",
  "sm.removeFail": "Non tolto dalla playlist",
  "sm.failWhy": "{what}: {why}",
  "sm.why.offline": "sei offline, riprova",
  "sm.why.forbidden": "non hai il permesso",
  "sm.why.missingTable": "manca la migrazione 018 del database",
  "sm.why.notFound": "la playlist non esiste più",
  "sm.why.server": "errore del server, riprova",
  "sm.radioSave": "Salva radio come playlist",
  "sm.radioSaving": "Creo la playlist radio…",
  "sm.radioSaved": "Playlist «{p}» salvata ({n} brani), aggiornata ogni giorno",
  "sm.radioSavedPlain": "Playlist «{p}» salvata ({n} brani). Per aggiornarla ogni giorno serve la migrazione 021 del database",
  "sm.radioSaveFail": "Playlist radio non creata",
};

export const MENU_EN: Record<string, string> = {
  "sm.more": "More actions",
  "sm.created": "Playlist “{p}” created",
  "sm.removed": "Removed from the playlist",
  "sm.copyHint": "Copy this link:",
  "sm.addFail": "Not added to “{p}”",
  "sm.createFail": "Playlist “{p}” not saved",
  "sm.removeFail": "Not removed from the playlist",
  "sm.failWhy": "{what}: {why}",
  "sm.why.offline": "you're offline, try again",
  "sm.why.forbidden": "you don't have permission",
  "sm.why.missingTable": "database migration 018 is missing",
  "sm.why.notFound": "the playlist no longer exists",
  "sm.why.server": "server error, try again",
  "sm.radioSave": "Save radio as playlist",
  "sm.radioSaving": "Creating the radio playlist…",
  "sm.radioSaved": "Playlist “{p}” saved ({n} songs), updated every day",
  "sm.radioSavedPlain": "Playlist “{p}” saved ({n} songs). Updating it every day needs database migration 021",
  "sm.radioSaveFail": "Radio playlist not created",
};
