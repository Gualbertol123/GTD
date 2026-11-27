// The three choosers made consistent (UX_AUDIT.md §3, "Chooser consistency"):
// priority as pills everywhere, the multi-person picker on a project's new
// task, ‹ › for the report's week. Same keys in both languages (i18n test).

export const UX_CHOOSERS_IT: Record<string, string> = {
  "chooser.prioAll": "Tutte",
  "chooser.prioFilter": "Filtra per priorità",
  "chooser.reportCustom": "Personalizzato",
  "chooser.reportCustomHint": "Scegli le date «Dal» e «Al»; ‹ › tornano alle settimane.",
};

export const UX_CHOOSERS_EN: Record<string, string> = {
  "chooser.prioAll": "All",
  "chooser.prioFilter": "Filter by priority",
  "chooser.reportCustom": "Custom",
  "chooser.reportCustomHint": "Pick the “From” and “To” dates; ‹ › go back to weeks.",
};
