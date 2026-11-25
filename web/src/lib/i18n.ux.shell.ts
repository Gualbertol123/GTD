// Usability-review strings for the "shell" area. Same keys in both languages (i18n test).

export const UX_SHELL_IT: Record<string, string> = {
  // The pre-login hint no longer hands out the initial diary password.
  "reflAuth.hint": "Prima volta? Chiedi la password iniziale a un amministratore.",
  "ux.shell.skipToContent": "Vai al contenuto",
  "save.failed": "Non salvato: {msg}. La bacheca mostra di nuovo ciò che è salvato.",
  // An edit made offline is refused before it changes anything (optimisticSend.ts).
  "save.offline": "Modifica non fatta: sei offline. Rifalla quando torni online.",
  // The same, after a screen's own "Non salvato:" (phone sheets, project page).
  "save.offlineReason": "sei offline, quindi la modifica non è stata fatta. Rifalla quando torni online.",
  // The loading screen when the app opens with no network (the cached shell).
  "app.offline": "Sei offline. La bacheca si apre da sola appena torna la connessione.",
  "app.unreachable": "Il server non risponde. Riprova da solo tra poco.",
  "ux.shell.tabsNav": "Sezioni",
  "ux.shell.close": "Chiudi",
  "ux.shell.renameBoard": "Rinomina la bacheca",
  "ux.shell.editSubtitle": "Modifica il sottotitolo",
  "ux.shell.unsavedDraft": "Bozza non salvata",
  "ux.shell.sure": "Sicuro?",
  "ux.shell.confirmLogout": "Uscire da questo dispositivo? Servirà di nuovo la password del team.",
  "ux.shell.confirmRemoveLogo": "Rimuovere il logo per tutto il team?",
  "ux.shell.confirmRemoveFavicon": "Rimuovere la favicon per tutto il team?",
  "ux.shell.changeInitial": "Stai usando la password iniziale: chiunque la conosce può aprire il tuo diario. Cambiala qui sotto.",
  "ux.shell.rememberUntil": "Aperto su questo dispositivo fino al {date}",
  "ux.shell.rememberForever": "Aperto su questo dispositivo finché non esci",
  "ux.shell.rememberPick": "Scegli…",
  "ux.shell.unchanged": "Nessuna modifica da salvare",
};

export const UX_SHELL_EN: Record<string, string> = {
  "save.failed": "Not saved: {msg}. The board shows what is saved again.",
  "save.offline": "Change not made: you are offline. Make it again once you are back online.",
  "save.offlineReason": "you are offline, so the change was not made. Make it again once you are back online.",
  "reflAuth.hint": "First time? Ask an admin for the initial password.",
  "app.offline": "You are offline. The board opens by itself as soon as the connection is back.",
  "app.unreachable": "The server is not answering. It tries again by itself shortly.",
  "ux.shell.skipToContent": "Skip to content",
  "ux.shell.tabsNav": "Sections",
  "ux.shell.close": "Close",
  "ux.shell.renameBoard": "Rename the board",
  "ux.shell.editSubtitle": "Edit the subtitle",
  "ux.shell.unsavedDraft": "Unsaved draft",
  "ux.shell.sure": "Sure?",
  "ux.shell.confirmLogout": "Log out this device? You will need the team password again.",
  "ux.shell.confirmRemoveLogo": "Remove the logo for the whole team?",
  "ux.shell.confirmRemoveFavicon": "Remove the favicon for the whole team?",
  "ux.shell.changeInitial": "You are using the initial password: anyone who knows it can open your diary. Change it below.",
  "ux.shell.rememberUntil": "Open on this device until {date}",
  "ux.shell.rememberForever": "Open on this device until you log out",
  "ux.shell.rememberPick": "Choose…",
  "ux.shell.unchanged": "Nothing to save",
};
