// Strings added by the usability review, one small file per area (so area
// fixes never edit the same file), merged into the main dictionaries.

import { UX_BOARD_EN, UX_BOARD_IT } from "./i18n.ux.board";
import { UX_PROJECTS_EN, UX_PROJECTS_IT } from "./i18n.ux.projects";
import { UX_WEEKLY_EN, UX_WEEKLY_IT } from "./i18n.ux.weekly";
import { UX_REPORT_EN, UX_REPORT_IT } from "./i18n.ux.report";
import { UX_PRODUCTS_EN, UX_PRODUCTS_IT } from "./i18n.ux.products";
import { UX_CALENDAR_EN, UX_CALENDAR_IT } from "./i18n.ux.calendar";
import { UX_SHELL_EN, UX_SHELL_IT } from "./i18n.ux.shell";
import { UX_MOBILE_EN, UX_MOBILE_IT } from "./i18n.ux.mobile";
import { UX_MUSIC_EN, UX_MUSIC_IT } from "./i18n.ux.music";

export const UX_IT: Record<string, string> = {
  ...UX_BOARD_IT,
  ...UX_PROJECTS_IT,
  ...UX_WEEKLY_IT,
  ...UX_REPORT_IT,
  ...UX_PRODUCTS_IT,
  ...UX_CALENDAR_IT,
  ...UX_SHELL_IT,
  ...UX_MOBILE_IT,
  ...UX_MUSIC_IT,
};

export const UX_EN: Record<string, string> = {
  ...UX_BOARD_EN,
  ...UX_PROJECTS_EN,
  ...UX_WEEKLY_EN,
  ...UX_REPORT_EN,
  ...UX_PRODUCTS_EN,
  ...UX_CALENDAR_EN,
  ...UX_SHELL_EN,
  ...UX_MOBILE_EN,
  ...UX_MUSIC_EN,
};
