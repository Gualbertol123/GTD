// -----------------------------------------------------------------------------
// The music player's icons: one outline set (24×24, round caps, currentColor),
// drawn to sit inside the Liquid Glass buttons (styles/musicTab.css,
// styles/music.css). Replaces the emoji and text symbols the player used.
// -----------------------------------------------------------------------------

import type { ReactNode } from "react";

type P = { size?: number; className?: string; title?: string };

function Svg({ size = 18, className, title, children, fill }: P & { children: ReactNode; fill?: boolean }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={fill ? "currentColor" : "none"}
      stroke={fill ? "none" : "currentColor"}
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={`mi${className ? " " + className : ""}`}
      aria-hidden={title ? undefined : true}
      role={title ? "img" : undefined}
    >
      {title && <title>{title}</title>}
      {children}
    </svg>
  );
}

export const IconPlay = (p: P) => (
  <Svg {...p} fill>
    <path d="M8 5.6v12.8a1 1 0 0 0 1.52.85l10.2-6.4a1 1 0 0 0 0-1.7L9.52 4.75A1 1 0 0 0 8 5.6z" />
  </Svg>
);
export const IconPause = (p: P) => (
  <Svg {...p} fill>
    <rect x="6" y="5" width="4" height="14" rx="1.3" />
    <rect x="14" y="5" width="4" height="14" rx="1.3" />
  </Svg>
);
export const IconPrev = (p: P) => (
  <Svg {...p} fill>
    <path d="M18 6.3v11.4a.9.9 0 0 1-1.38.76L8.4 13.2V18a1 1 0 1 1-2 0V6a1 1 0 1 1 2 0v4.8l8.22-5.26A.9.9 0 0 1 18 6.3z" />
  </Svg>
);
export const IconNext = (p: P) => (
  <Svg {...p} fill>
    <path d="M6 6.3v11.4a.9.9 0 0 0 1.38.76l8.22-5.26V18a1 1 0 1 0 2 0V6a1 1 0 1 0-2 0v4.8L7.38 5.54A.9.9 0 0 0 6 6.3z" />
  </Svg>
);
export const IconShuffle = (p: P) => (
  <Svg {...p}>
    <path d="M16 3h5v5" />
    <path d="M4 20 21 3" />
    <path d="M21 16v5h-5" />
    <path d="m15 15 6 6" />
    <path d="m4 4 5 5" />
  </Svg>
);
export const IconRepeat = (p: P) => (
  <Svg {...p}>
    <path d="m17 2 4 4-4 4" />
    <path d="M3 11v-1a4 4 0 0 1 4-4h14" />
    <path d="m7 22-4-4 4-4" />
    <path d="M21 13v1a4 4 0 0 1-4 4H3" />
  </Svg>
);
export const IconVolume = (p: P) => (
  <Svg {...p}>
    <path d="M11 5 6 9H3v6h3l5 4z" />
    <path d="M15.5 8.5a5 5 0 0 1 0 7" />
    <path d="M18.5 5.5a9 9 0 0 1 0 13" />
  </Svg>
);
export const IconMute = (p: P) => (
  <Svg {...p}>
    <path d="M11 5 6 9H3v6h3l5 4z" />
    <path d="m22 9-6 6" />
    <path d="m16 9 6 6" />
  </Svg>
);
export const IconHome = (p: P) => (
  <Svg {...p}>
    <path d="M3 10.5 12 3l9 7.5" />
    <path d="M5 9v11a1 1 0 0 0 1 1h4v-6h4v6h4a1 1 0 0 0 1-1V9" />
  </Svg>
);
export const IconSearch = (p: P) => (
  <Svg {...p}>
    <circle cx="11" cy="11" r="7" />
    <path d="m20 20-3.5-3.5" />
  </Svg>
);
export const IconImport = (p: P) => (
  <Svg {...p}>
    <path d="M12 3v12" />
    <path d="m7 10 5 5 5-5" />
    <path d="M5 21h14" />
  </Svg>
);
export const IconLink = (p: P) => (
  <Svg {...p}>
    <path d="M10 13a5 5 0 0 0 7.07 0l3-3a5 5 0 0 0-7.07-7.07l-1.5 1.5" />
    <path d="M14 11a5 5 0 0 0-7.07 0l-3 3a5 5 0 0 0 7.07 7.07l1.5-1.5" />
  </Svg>
);
export const IconNote = (p: P) => (
  <Svg {...p}>
    <path d="M9 18V5l12-2v13" />
    <circle cx="6" cy="18" r="3" />
    <circle cx="18" cy="16" r="3" />
  </Svg>
);
export const IconTrend = (p: P) => (
  <Svg {...p}>
    <path d="m3 17 6-6 4 4 8-8" />
    <path d="M15 7h6v6" />
  </Svg>
);
export const IconRadio = (p: P) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="2" />
    <path d="M16.24 7.76a6 6 0 0 1 0 8.48" />
    <path d="M7.76 16.24a6 6 0 0 1 0-8.48" />
    <path d="M19.07 4.93a10 10 0 0 1 0 14.14" />
    <path d="M4.93 19.07a10 10 0 0 1 0-14.14" />
  </Svg>
);
export const IconClose = (p: P) => (
  <Svg {...p}>
    <path d="M18 6 6 18" />
    <path d="m6 6 12 12" />
  </Svg>
);
export const IconChevronDown = (p: P) => (
  <Svg {...p}>
    <path d="m6 9 6 6 6-6" />
  </Svg>
);
export const IconChevronRight = (p: P) => (
  <Svg {...p}>
    <path d="m9 6 6 6-6 6" />
  </Svg>
);
export const IconBack = (p: P) => (
  <Svg {...p}>
    <path d="M19 12H5" />
    <path d="m12 19-7-7 7-7" />
  </Svg>
);
export const IconExpand = (p: P) => (
  <Svg {...p}>
    <path d="M15 3h6v6" />
    <path d="M9 21H3v-6" />
    <path d="M21 3l-7 7" />
    <path d="M3 21l7-7" />
  </Svg>
);
export const IconSwap = (p: P) => (
  <Svg {...p}>
    <path d="m16 3 4 4-4 4" />
    <path d="M20 7H4" />
    <path d="m8 21-4-4 4-4" />
    <path d="M4 17h16" />
  </Svg>
);
export const IconUp = (p: P) => (
  <Svg {...p}>
    <path d="M12 19V5" />
    <path d="m5 12 7-7 7 7" />
  </Svg>
);
export const IconDown = (p: P) => (
  <Svg {...p}>
    <path d="M12 5v14" />
    <path d="m19 12-7 7-7-7" />
  </Svg>
);
export const IconPlus = (p: P) => (
  <Svg {...p}>
    <path d="M12 5v14" />
    <path d="M5 12h14" />
  </Svg>
);
export const IconCheck = (p: P) => (
  <Svg {...p}>
    <path d="M20 6 9 17l-5-5" />
  </Svg>
);
/** A person (sign in to an account). */
export const IconUser = (p: P) => (
  <Svg {...p}>
    <circle cx="12" cy="8" r="4" />
    <path d="M4 20.5c1.2-3.6 4.3-5.5 8-5.5s6.8 1.9 8 5.5" />
  </Svg>
);
export const IconExternal = (p: P) => (
  <Svg {...p}>
    <path d="M15 3h6v6" />
    <path d="M10 14 21 3" />
    <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
  </Svg>
);
export const IconCopy = (p: P) => (
  <Svg {...p}>
    <rect x="9" y="9" width="12" height="12" rx="2" />
    <path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1" />
  </Svg>
);
export const IconQueue = (p: P) => (
  <Svg {...p}>
    <path d="M3 6h13" />
    <path d="M3 12h13" />
    <path d="M3 18h8" />
    <path d="M18 15v6" />
    <path d="M15 18h6" />
  </Svg>
);
export const IconPlayNext = (p: P) => (
  <Svg {...p}>
    <path d="M3 6h11" />
    <path d="M3 12h7" />
    <path d="M3 18h7" />
    <path d="M14 11.5v7l6-3.5z" fill="currentColor" stroke="none" />
  </Svg>
);
export const IconTrash = (p: P) => (
  <Svg {...p}>
    <path d="M3 6h18" />
    <path d="M8 6V4h8v2" />
    <path d="M19 6l-1 14a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1L5 6" />
  </Svg>
);
export const IconMore = (p: P) => (
  <Svg {...p} fill>
    <circle cx="5" cy="12" r="1.8" />
    <circle cx="12" cy="12" r="1.8" />
    <circle cx="19" cy="12" r="1.8" />
  </Svg>
);
export const IconVideo = (p: P) => (
  <Svg {...p}>
    <rect x="2" y="5" width="14" height="14" rx="2" />
    <path d="m16 10 6-3v10l-6-3" />
  </Svg>
);
export const IconBars = (p: P) => (
  <Svg {...p}>
    <path d="M6 18V10" />
    <path d="M12 18V6" />
    <path d="M18 18v-5" />
  </Svg>
);
/** A turning ring (styles/music.css .mi-spin): something is loading. Never a "…" text. */
export const IconSpinner = (p: P) => (
  <Svg {...p} className={`mi-spin${p.className ? " " + p.className : ""}`}>
    <circle cx="12" cy="12" r="9.5" opacity="0.25" />
    <path d="M12 2.5a9.5 9.5 0 0 1 9.5 9.5" />
  </Svg>
);
/** A drawn check in a ring: a list that is in the team library. */
export const IconCheckCircle = (p: P) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="9.5" />
    <path d="m7.5 12.3 3 3 6-6.3" />
  </Svg>
);
/** A triangle with "!": incomplete (songs missing). */
export const IconAlert = (p: P) => (
  <Svg {...p}>
    <path d="M10.3 4.2 2.6 17.6A2 2 0 0 0 4.3 20.6h15.4a2 2 0 0 0 1.7-3L13.7 4.2a2 2 0 0 0-3.4 0z" />
    <path d="M12 9.5v4.2" />
    <path d="M12 17h.01" />
  </Svg>
);
/** A ring with a cross: something failed. */
export const IconError = (p: P) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="9.5" />
    <path d="m9 9 6 6" />
    <path d="m15 9-6 6" />
  </Svg>
);
/** An empty dashed ring: still to add. */
export const IconPending = (p: P) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="9.5" strokeDasharray="3 3" />
  </Svg>
);
