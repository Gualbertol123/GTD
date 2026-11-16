import { useEffect, useMemo, useRef, useState } from "react";
import { useT } from "../lib/i18n";
import {
  allIds,
  changeNotesKeys,
  countLeaves,
  countTagged,
  filterIndex,
  glossary,
  marginSteps,
  PRODUCTS_SECTION,
  sections,
  TAGS,
  type Tag,
  type TreeNode,
  type TreeSection,
} from "../lib/productTree";
import { IconChevronRight, IconClose } from "./MusicIcons";

// The consolidated ISP product taxonomy (dicui2.xlsx) as a browsable tree,
// with an overview graphic explaining how the pieces fit together.
//
// Read-only reference data: nothing here touches the board, Supabase or any Op.
// It uses only the utility classes the rest of the app already uses, so the
// Liquid Glass skin picks it up with no CSS of its own. The few tints that must
// NOT become a glass panel (chips, hit rows) use a class glass.css does not map,
// plus an arbitrary `html[data-skin=glass]` variant for the glass colour — never
// a backdrop-filter, since they sit inside panels that already blur.

/** A warm tint that is not a glass panel: no material, sheen or blur. */
const WARM_TINT =
  "bg-[#FAF3E6] [html[data-skin=glass]_&]:[background-color:color-mix(in_srgb,var(--ios-orange)_12%,transparent)]";

/** Chip colours per tag. V keeps the Classic gold but gets its own glass tint. */
const TAG_STYLE: Record<Tag, string> = {
  V:
    "tag-v bg-[#FAF3E6] text-gold-dark border-[#C9A96E]/40 " +
    "[html[data-skin=glass]_&]:[background-color:color-mix(in_srgb,var(--ios-orange)_16%,transparent)] " +
    "[html[data-skin=glass]_&]:[border-color:color-mix(in_srgb,var(--ios-orange)_36%,transparent)] " +
    "[html[data-skin=glass]_&]:text-[#A84B00] " +
    "[html[data-skin=glass][data-appearance=dark]_&]:[color:var(--ios-orange)]",
  NPL: "bg-[#FEF2F2] text-[#DC2626] border-[#FECACA]",
  C: "bg-[#ECFDF5] text-[#065F46] border-[#A7F3D0]",
};

const TAG_LABEL: Record<Tag, string> = { V: "V", NPL: "NPL", C: "C" };

/** How many products carry each tag overall, for the legend. */
const GLOBAL_TAG_COUNTS = Object.fromEntries(
  TAGS.map((tg) => [tg, countTagged(sections.find((s) => s.id === PRODUCTS_SECTION)!.roots, tg)])
) as Record<Tag, number>;

/** Glossary meaning and margin-note translations; the source labels stay English. */
const MARGIN_NOTE_KEY: Record<string, string> = {
  "by product": "ux.products.margin.byProduct",
  "and excl. Waivers": "ux.products.margin.exclWaivers",
};

const focusRing =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#C9A96E]";

function TagChip({ tag }: { tag: Tag }) {
  return (
    <span
      className={`tag-chip shrink-0 text-[9px] font-semibold tracking-wide px-1.5 py-px rounded-full border ${TAG_STYLE[tag]}`}
    >
      {TAG_LABEL[tag]}
    </span>
  );
}

/** The expand/collapse chevron: one SVG, rotated when open. */
function Chevron({ open, size = 12 }: { open: boolean; size?: number }) {
  return (
    <IconChevronRight
      size={size}
      className={`transition-transform duration-150 ${open ? "rotate-90" : ""}`}
    />
  );
}

/** A small arrow for the overview map; points down on phones, right on desktop. */
function ArrowIcon({ className = "" }: { className?: string }) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={className}
    >
      <path d="M5 12h14" />
      <path d="m13 6 6 6-6 6" />
    </svg>
  );
}

/** Rows open on first paint: the roots and their direct children. */
function defaultOpen(section: TreeSection): Set<string> {
  const open = new Set<string>();
  section.roots.forEach((r) => {
    open.add(r.id);
    r.children?.forEach((c) => open.add(c.id));
  });
  return open;
}

/** Marks the matched substring inside a label without breaking the text flow. */
function Highlight({ text, query }: { text: string; query: string }) {
  const q = query.trim();
  if (!q) return <>{text}</>;
  const at = text.toLowerCase().indexOf(q.toLowerCase());
  if (at < 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, at)}
      <mark className="bg-[#FEF3C7] text-[#92400E] rounded-sm">
        {text.slice(at, at + q.length)}
      </mark>
      {text.slice(at + q.length)}
    </>
  );
}

// -----------------------------------------------------------------------------
// Where the user was: kept across a remount (leaving the tab and pressing Back,
// or leaving Altro > Prodotti on the phone) without touching the hash route.
// -----------------------------------------------------------------------------

interface SavedState {
  sectionId: string;
  query: string;
  tag: Tag | null;
  open: string[];
}

const SAVE_KEY = "gtd-products-view";
const HOWTO_KEY = "gtd-products-howto";
let saved: SavedState | null = null;

function loadSaved(): SavedState | null {
  if (saved) return saved;
  try {
    const raw = sessionStorage.getItem(SAVE_KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as Partial<SavedState>;
    if (!v || !sections.some((s) => s.id === v.sectionId)) return null;
    saved = {
      sectionId: v.sectionId as string,
      query: typeof v.query === "string" ? v.query : "",
      tag: v.tag && (TAGS as readonly string[]).includes(v.tag) ? (v.tag as Tag) : null,
      open: Array.isArray(v.open) ? v.open.filter((x) => typeof x === "string") : [],
    };
    return saved;
  } catch {
    return null;
  }
}

function storeSaved(next: SavedState) {
  saved = next;
  try {
    sessionStorage.setItem(SAVE_KEY, JSON.stringify(next));
  } catch {
    /* private mode or storage blocked: the module copy still covers a remount */
  }
}

function readHowTo(): boolean {
  try {
    const v = localStorage.getItem(HOWTO_KEY);
    return v === null ? true : v === "open";
  } catch {
    return true;
  }
}

function writeHowTo(open: boolean) {
  try {
    localStorage.setItem(HOWTO_KEY, open ? "open" : "closed");
  } catch {
    /* ignore */
  }
}

/**
 * Where the sticky control bar stops: just under the app header when that
 * header is itself sticky (the Glass skin), 8px from the top otherwise.
 * Re-measured on resize and when the skin or appearance changes.
 */
function useStickyTop(): number {
  const [top, setTop] = useState(8);
  useEffect(() => {
    const measure = () => {
      const header = document.querySelector("header");
      const pos = header ? getComputedStyle(header).position : "static";
      const h =
        header && (pos === "sticky" || pos === "fixed") ? header.getBoundingClientRect().height : 0;
      setTop(Math.round(h) + 8);
    };
    measure();
    window.addEventListener("resize", measure);
    const mo = new MutationObserver(measure);
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-skin", "data-appearance"] });
    return () => {
      window.removeEventListener("resize", measure);
      mo.disconnect();
    };
  }, []);
  return top;
}

// -----------------------------------------------------------------------------
// The overview graphic: who is reported, on what products, into which template.
// Built from the data itself, so it cannot drift from the tree below it.
// -----------------------------------------------------------------------------

function MapCard({
  step,
  title,
  sub,
  chips,
  foot,
}: {
  step: string;
  title: string;
  sub: string;
  chips: React.ReactNode;
  foot: string;
}) {
  return (
    <div className="flex-1 flex flex-col rounded-[12px] border border-[#E8E6E1] bg-[#F5F3EF] p-3">
      <div className="flex items-center gap-2">
        <span className="w-5 h-5 rounded-full bg-[#0A1931] text-[#C9A96E] text-[10px] font-semibold flex items-center justify-center">
          {step}
        </span>
        <span className="font-trajan text-[11px] uppercase tracking-widest text-[#0A1931]">
          {title}
        </span>
      </div>
      <p className="text-[11px] text-[#6B6B6B] mt-2">{sub}</p>
      <div className="flex flex-wrap gap-1 mt-2">{chips}</div>
      <p className="text-[10px] text-[#6B6B6B] mt-auto pt-2">{foot}</p>
    </div>
  );
}

function MapArrow({ label }: { label: string }) {
  return (
    <div className="flex md:flex-col items-center justify-center gap-1.5 md:w-[86px] shrink-0">
      <span className="text-[#C9A96E] leading-none">
        <ArrowIcon className="rotate-90 md:rotate-0" />
      </span>
      <span className="text-[10px] text-[#8A8A8A] md:text-center leading-tight">{label}</span>
    </div>
  );
}

function OverviewMap() {
  const { t } = useT();
  const productSection = sections.find((s) => s.id === PRODUCTS_SECTION)!;
  const productCount = productSection.roots.reduce((n, r) => n + countLeaves(r), 0);

  const chip = "text-[10px] px-2 py-0.5 rounded-full bg-[#EFECE6] text-[#6B6B6B]";
  const feedArrow = (
    <span className="inline-block align-middle mx-1 text-[#C9A96E]">
      <ArrowIcon className="w-3 h-3" />
    </span>
  );

  return (
    <div>
      <div className="flex flex-col md:flex-row items-stretch gap-2">
        <MapCard
          step="1"
          title={t("tree.mapWho")}
          sub={t("tree.mapWhoSub")}
          foot={t("tree.mapWhoFoot")}
          chips={["CORP", "SME", "FI", "SB", "PRAGUE"].map((s) => (
            <span key={s} className={chip}>
              {s}
            </span>
          ))}
        />
        <MapArrow label={t("tree.mapArrow1")} />
        <MapCard
          step="2"
          title={t("tree.mapWhat")}
          sub={t("tree.mapWhatSub", { n: productCount })}
          foot={t("tree.mapWhatFoot")}
          chips={productSection.roots.map((r) => (
            <span key={r.id} className={chip}>
              {r.label}
            </span>
          ))}
        />
        <MapArrow label={t("tree.mapArrow2")} />
        <MapCard
          step="3"
          title={t("tree.mapWhere")}
          sub={t("tree.mapWhereSub")}
          foot={t("tree.mapWhereFoot")}
          chips={
            <>
              <span className={chip}>
                A_L <TagChipInline tags={["V", "NPL"]} />
              </span>
              <span className={chip}>
                COMM <TagChipInline tags={["C"]} />
              </span>
            </>
          }
        />
      </div>

      {/* What each template feeds */}
      <div className={`mt-3 rounded-[12px] border border-[#C9A96E]/40 px-3 py-2 ${WARM_TINT}`}>
        <p className="text-[11px] text-[#6B6B6B]">
          <span className="font-semibold text-[#0A1931]">A_L</span>
          {feedArrow}
          {t("tree.mapFeedAL")}
          {"  ·  "}
          <span className="font-semibold text-[#0A1931]">COMM</span>
          {feedArrow}
          {t("tree.mapFeedComm")}
        </p>
      </div>
    </div>
  );
}

function TagChipInline({ tags }: { tags: Tag[] }) {
  return (
    <span className="inline-flex gap-1 ml-1 align-middle">
      {tags.map((tg) => (
        <TagChip key={tg} tag={tg} />
      ))}
    </span>
  );
}

// -----------------------------------------------------------------------------

export function ProductTreeView() {
  const { t } = useT();
  const initial = useMemo(() => loadSaved(), []);
  const [sectionId, setSectionId] = useState(initial?.sectionId ?? PRODUCTS_SECTION);
  const [query, setQuery] = useState(initial?.query ?? "");
  const [tag, setTag] = useState<Tag | null>(initial?.tag ?? null);
  const [open, setOpen] = useState<Set<string>>(() =>
    initial
      ? new Set(initial.open)
      : defaultOpen(sections.find((s) => s.id === PRODUCTS_SECTION)!)
  );
  const [howTo, setHowTo] = useState(readHowTo);
  const inputRef = useRef<HTMLInputElement>(null);
  const stickyTop = useStickyTop();

  useEffect(() => {
    storeSaved({ sectionId, query, tag, open: [...open] });
  }, [sectionId, query, tag, open]);

  // The explainer opens on the first visit only; afterwards it stays as the user left it.
  useEffect(() => {
    try {
      if (localStorage.getItem(HOWTO_KEY) === null) writeHowTo(false);
    } catch {
      /* ignore */
    }
  }, []);

  const section = sections.find((s) => s.id === sectionId) ?? sections[0];
  const taggable = section.id === PRODUCTS_SECTION;
  const activeTag = taggable ? tag : null;

  const { keep, hits, active } = useMemo(
    () => filterIndex(section.roots, query, activeTag),
    [section, query, activeTag]
  );

  // Matches per section too: the tree on screen is one of three, and a search
  // that finds nothing here may well have found something next door.
  const hitsBySection = useMemo(() => {
    const out: Record<string, number> = {};
    sections.forEach((s) => {
      out[s.id] = filterIndex(s.roots, query, null).hits.size;
    });
    return out;
  }, [query]);

  const searching = query.trim().length > 0;

  // Tag counts follow the search, so the chips say what a tag filter would give.
  const tagCounts = useMemo(() => {
    const productRoots = sections.find((s) => s.id === PRODUCTS_SECTION)!.roots;
    const leafIds = new Set<string>();
    const walk = (n: TreeNode) => {
      if (!n.children?.length) leafIds.add(n.id);
      n.children?.forEach(walk);
    };
    productRoots.forEach(walk);
    return Object.fromEntries(
      TAGS.map((tg) => {
        if (!query.trim()) return [tg, countTagged(productRoots, tg)];
        let n = 0;
        filterIndex(productRoots, query, tg).hits.forEach((id) => {
          if (leafIds.has(id)) n += 1;
        });
        return [tg, n];
      })
    ) as Record<Tag, number>;
  }, [query]);

  const pickSection = (id: string) => {
    const next = sections.find((s) => s.id === id);
    if (!next) return;
    setSectionId(id);
    setTag(null);
    setOpen(defaultOpen(next));
  };

  const toggle = (id: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const expandAll = () => setOpen(new Set(allIds(section.roots)));
  const collapseAll = () => setOpen(new Set());

  const clearSearch = () => {
    setQuery("");
    inputRef.current?.focus();
  };

  // A branch whose own label matched the search shows its whole content: the
  // user asked for that family, not for nothing beneath it.
  const showsAllBelow = (id: string) => searching && activeTag === null && hits.has(id);

  // While filtering, every branch on the way to a match is forced open so no
  // match can hide behind a closed parent.
  const isOpen = (id: string, underHit: boolean) =>
    active && !underHit ? keep.has(id) : open.has(id);

  /** Leaves under a node that pass the current filter. */
  const visibleLeaves = (node: TreeNode): number => {
    if (showsAllBelow(node.id)) return countLeaves(node);
    if (!node.children?.length) return keep.has(node.id) ? 1 : 0;
    return node.children.reduce((n, c) => n + visibleLeaves(c), 0);
  };

  /** "3/9" while filtering (when some are hidden), the plain total otherwise. */
  const badge = (node: TreeNode, underHit: boolean) => {
    const total = countLeaves(node);
    if (!active || underHit) return { text: String(total), shown: total, total };
    const shown = visibleLeaves(node);
    if (shown === 0 || shown === total) return { text: String(total), shown: total, total };
    return { text: `${shown}/${total}`, shown, total };
  };

  const renderNodes = (nodes: TreeNode[], depth: number, underHit: boolean) => {
    const visible = active && !underHit ? nodes.filter((nd) => keep.has(nd.id)) : nodes;
    if (!visible.length) return null;
    return (
      <ul
        className={
          depth === 0 ? "space-y-px" : "space-y-px ml-[9px] pl-3 border-l border-[#E8E6E1]"
        }
      >
        {visible.map((node) => {
          const kids = node.children ?? [];
          const branch = kids.length > 0;
          const expanded = branch && isOpen(node.id, underHit);
          const hit = hits.has(node.id);
          const childrenUnderHit = underHit || showsAllBelow(node.id);
          const content = (
            <div className="min-w-0 flex-1 flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
              <span
                className={`text-[13px] ${
                  branch ? "font-semibold text-[#0A1931]" : "text-[#0A1931]"
                }`}
              >
                <Highlight text={node.label} query={query} />
              </span>
              {node.note && (
                <span className="text-[11px] text-[#8A8A8A]">
                  <Highlight text={node.note} query={query} />
                </span>
              )}
              {node.tags && (
                <span className="inline-flex gap-1">
                  {node.tags.map((tg) => (
                    <TagChip key={tg} tag={tg} />
                  ))}
                </span>
              )}
            </div>
          );
          const b = branch ? badge(node, underHit) : null;
          return (
            <li key={node.id}>
              <div className={`rounded-lg ${hit ? WARM_TINT : ""}`}>
                {branch ? (
                  <button
                    type="button"
                    onClick={() => toggle(node.id)}
                    aria-expanded={expanded}
                    className={`w-full text-left flex items-center gap-2 rounded-lg px-2 py-[5px] min-h-[44px] md:min-h-[32px] hover:bg-black/[0.03] ${focusRing}`}
                  >
                    <span className="shrink-0 w-[18px] h-[18px] rounded-md bg-[#F5F3EF] text-[#6B6B6B] flex items-center justify-center">
                      <Chevron open={expanded} />
                    </span>
                    {content}
                    {b && (
                      <span
                        className="shrink-0 text-[10px] font-semibold tabular-nums px-1.5 py-0.5 rounded-full bg-[#EFECE6] text-[#6B6B6B]"
                        title={
                          b.shown !== b.total
                            ? t("ux.products.visibleOf", { n: b.shown, total: b.total })
                            : undefined
                        }
                      >
                        {b.text}
                      </span>
                    )}
                  </button>
                ) : (
                  <div className="flex items-start gap-2 px-2 py-[5px]">
                    <span className="shrink-0 mt-[1px] w-[18px] h-[18px] flex items-center justify-center">
                      <span className="w-[5px] h-[5px] rounded-full bg-[#C9A96E]" />
                    </span>
                    {content}
                  </div>
                )}
              </div>
              {expanded && renderNodes(kids, depth + 1, childrenUnderHit)}
            </li>
          );
        })}
      </ul>
    );
  };

  const elsewhere = searching
    ? sections.filter((s) => s.id !== section.id && (hitsBySection[s.id] ?? 0) > 0)
    : [];
  const visibleRoots = active ? section.roots.filter((r) => keep.has(r.id)) : section.roots;
  const nothingAnywhere = searching && Object.values(hitsBySection).every((n) => n === 0);

  const pill = (on: boolean) =>
    on ? "bg-[#0A1931] text-[#C9A96E] border-[#0A1931]" : "bg-white text-[#0A1931] border-[#E8E6E1]";

  return (
    <div className="max-w-[900px] mx-auto space-y-4">
      <div>
        <h2 className="font-trajan text-[16px] uppercase tracking-widest text-[#0A1931]">
          {t("tree.title")}
        </h2>
        <p className="text-[12px] text-[#6B6B6B] mt-2">{t("tree.intro")}</p>
        <p className="text-[11px] text-[#6B6B6B] mt-1">{t("tree.source")}</p>
      </div>

      {/* Section picker, search and tag filter — first, so a search is one tap away */}
      <div
        className="rounded-[14px] border border-[#E3DFD7] bg-[#EFECE6] p-3 space-y-3 md:!sticky md:z-10"
        style={{ top: stickyTop }}
      >
        <div className="flex flex-wrap gap-2">
          {sections.map((s) => {
            const isActive = s.id === section.id;
            const total = s.roots.reduce((n, r) => n + countLeaves(r), 0);
            const found = hitsBySection[s.id] ?? 0;
            const empty = searching && found === 0;
            const countText = searching
              ? found === 1
                ? t("tree.inSection1")
                : t("tree.inSection", { n: found })
              : t("tree.leaves", { n: total });
            return (
              <button
                key={s.id}
                type="button"
                onClick={() => pickSection(s.id)}
                aria-pressed={isActive}
                aria-label={t("ux.products.sectionCount", { name: t(s.labelKey), count: countText })}
                title={searching ? countText : undefined}
                className={`h-9 px-4 rounded-full text-[11px] font-semibold uppercase tracking-wide border ${pill(
                  isActive
                )} ${empty && !isActive ? "opacity-40" : ""} ${focusRing}`}
              >
                {t(s.labelKey)}
                <span className={`ml-1.5 tabular-nums ${isActive ? "" : "opacity-60"}`}>
                  {searching ? found : total}
                </span>
              </button>
            );
          })}
        </div>

        <p className="text-[11px] text-[#6B6B6B]">{t(section.blurbKey)}</p>

        <div className="flex flex-wrap items-center gap-2">
          <div role="search" className="relative flex-1 min-w-[200px]">
            <input
              ref={inputRef}
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape" && query) {
                  e.preventDefault();
                  e.stopPropagation();
                  setQuery("");
                }
              }}
              aria-label={t("ux.products.searchLabel")}
              placeholder={t("ux.products.searchPlaceholder")}
              className="w-full h-9 rounded-full bg-white border border-[#E8E6E1] pl-3 pr-10 text-[12px] outline-none focus:border-[#C9A96E] appearance-none [&::-webkit-search-cancel-button]:hidden [&::-webkit-search-decoration]:hidden"
            />
            {searching && (
              <button
                type="button"
                onClick={clearSearch}
                aria-label={t("ux.products.clearSearch")}
                title={t("ux.products.clearSearch")}
                className={`absolute right-1 top-1/2 -translate-y-1/2 w-7 h-7 rounded-full flex items-center justify-center text-[#8A8A8A] hover:text-[#0A1931] ${focusRing}`}
              >
                <IconClose size={14} />
              </button>
            )}
          </div>
          {/* Filtered branches are forced open, so these only make sense unfiltered */}
          {!active && (
            <div className="flex flex-nowrap gap-2">
              <button
                type="button"
                onClick={expandAll}
                className={`h-9 px-3 rounded-full bg-white border border-[#E8E6E1] text-[11px] text-[#0A1931] whitespace-nowrap ${focusRing}`}
              >
                {t("tree.expand")}
              </button>
              <button
                type="button"
                onClick={collapseAll}
                className={`h-9 px-3 rounded-full bg-white border border-[#E8E6E1] text-[11px] text-[#0A1931] whitespace-nowrap ${focusRing}`}
              >
                {t("tree.collapse")}
              </button>
            </div>
          )}
        </div>

        {taggable && (
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[11px] text-[#6B6B6B]">{t("tree.tagFilter")}</span>
            <button
              type="button"
              onClick={() => setTag(null)}
              aria-pressed={tag === null}
              className={`h-7 px-3 rounded-full text-[11px] border ${pill(tag === null)} ${focusRing}`}
            >
              {t("tree.tagAll")}
            </button>
            {TAGS.map((tg) => (
              <button
                key={tg}
                type="button"
                onClick={() => setTag(tag === tg ? null : tg)}
                aria-pressed={tag === tg}
                aria-label={t("ux.products.tagFilterCount", { tag: TAG_LABEL[tg], n: tagCounts[tg] })}
                className={`h-7 px-3 rounded-full text-[11px] border ${pill(tag === tg)} ${focusRing}`}
              >
                {TAG_LABEL[tg]}
                <span className={`ml-1.5 tabular-nums ${tag === tg ? "" : "opacity-60"}`}>
                  {tagCounts[tg]}
                </span>
              </button>
            ))}
          </div>
        )}

        {searching && (visibleRoots.length > 0 || elsewhere.length > 0) && (
          <p className="text-[11px] text-[#6B6B6B]" aria-live="polite">
            {visibleRoots.length > 0 &&
              (hits.size === 1 ? t("tree.match1") : t("tree.matches", { n: hits.size }))}
            {elsewhere.length > 0 && (
              <>
                {visibleRoots.length > 0 && " · "}
                {t("tree.alsoIn")}{" "}
                {elsewhere.map((s, i) => (
                  <span key={s.id}>
                    {i > 0 && ", "}
                    <button
                      type="button"
                      onClick={() => pickSection(s.id)}
                      className={`underline text-[#0A1931] rounded ${focusRing}`}
                    >
                      {t(s.labelKey)} ({hitsBySection[s.id]})
                    </button>
                  </span>
                ))}
              </>
            )}
          </p>
        )}
      </div>

      {/* How to read it: the map and the tag legend. Open on the first visit only. */}
      <details
        open={howTo}
        onToggle={(e) => {
          const next = e.currentTarget.open;
          if (next !== howTo) {
            setHowTo(next);
            writeHowTo(next);
          }
        }}
        className="group bg-white rounded-[14px] border border-[#E8E6E1]"
      >
        <summary
          className={`list-none [&::-webkit-details-marker]:hidden cursor-pointer select-none flex items-center gap-2 px-4 py-3 min-h-[44px] rounded-[14px] ${focusRing}`}
        >
          <span className="text-[#8A8A8A]">
            <Chevron open={howTo} />
          </span>
          <span className="font-trajan text-[11px] uppercase tracking-widest text-[#8A8A8A]">
            {t("tree.mapTitle")}
          </span>
          {!howTo && (
            <span className="text-[11px] text-[#8A8A8A] truncate">
              · {t("ux.products.howToReadHint")}
            </span>
          )}
        </summary>
        <div className="px-4 pb-4 space-y-4">
          <OverviewMap />

          {/* Tag legend — what the chips on every product mean */}
          <div>
            <h3 className="font-trajan text-[11px] uppercase tracking-widest text-[#8A8A8A]">
              {t("tree.tagLegend")}
            </h3>
            <dl className="mt-3 space-y-1.5">
              {TAGS.map((tg) => (
                <div key={tg} className="flex items-baseline gap-2 text-[12px]">
                  <dt className="shrink-0 w-10">
                    <TagChip tag={tg} />
                  </dt>
                  <dd className="text-[#6B6B6B]">
                    {t(`tree.tag${tg}Desc`)}
                    <span className="text-[#8A8A8A]">
                      {" · "}
                      {t("tree.tagCount", { n: GLOBAL_TAG_COUNTS[tg] })}
                    </span>
                  </dd>
                </div>
              ))}
            </dl>
          </div>
        </div>
      </details>

      {/* The trees — one panel per root */}
      {visibleRoots.length === 0 ? (
        <div className="bg-white rounded-[14px] border border-[#E8E6E1] p-6 text-center">
          <p className="text-[13px] text-[#6B6B6B]">
            {searching ? t("ux.products.noResultFor", { q: query.trim() }) : t("tree.noMatch")}
          </p>
          {searching && nothingAnywhere && (
            <p className="text-[11px] text-[#6B6B6B] mt-2 max-w-[460px] mx-auto">
              {t("ux.products.searchHint")}
            </p>
          )}
          <div className="mt-4 flex flex-wrap justify-center gap-2">
            {searching && (
              <button
                type="button"
                onClick={clearSearch}
                className={`h-9 px-4 rounded-full bg-white border border-[#E8E6E1] text-[11px] text-[#0A1931] ${focusRing}`}
              >
                {t("ux.products.clearSearch")}
              </button>
            )}
            {activeTag !== null && (
              <button
                type="button"
                onClick={() => setTag(null)}
                className={`h-9 px-4 rounded-full bg-white border border-[#E8E6E1] text-[11px] text-[#0A1931] ${focusRing}`}
              >
                {t("ux.products.removeTag")}
              </button>
            )}
          </div>
        </div>
      ) : (
        visibleRoots.map((root) => {
          const branch = !!root.children?.length;
          const rootHit = hits.has(root.id);
          const expanded = branch && isOpen(root.id, false);
          const b = badge(root, false);
          const header = (
            <>
              <span className="font-trajan text-[11px] uppercase tracking-widest text-[#0A1931]">
                <Highlight text={root.label} query={query} />
              </span>
              {root.note && (
                <span className="text-[11px] text-[#8A8A8A]">
                  <Highlight text={root.note} query={query} />
                </span>
              )}
              {root.tags && (
                <span className="inline-flex gap-1">
                  {root.tags.map((tg) => (
                    <TagChip key={tg} tag={tg} />
                  ))}
                </span>
              )}
              <span
                className="ml-auto shrink-0 text-[10px] font-semibold tabular-nums px-2 py-0.5 rounded-full bg-[#EFECE6] text-[#6B6B6B]"
                title={
                  b.shown !== b.total
                    ? t("ux.products.visibleOf", { n: b.shown, total: b.total })
                    : undefined
                }
              >
                {b.total === 1 ? t("tree.leaves1") : t("tree.leaves", { n: b.text })}
              </span>
            </>
          );
          return (
            <div
              key={root.id}
              className="bg-white rounded-[14px] border border-[#E8E6E1] overflow-hidden"
            >
              {branch ? (
                <button
                  type="button"
                  onClick={() => toggle(root.id)}
                  aria-expanded={expanded}
                  className={`w-full flex flex-wrap items-center gap-x-2 gap-y-1 px-4 py-3 min-h-[44px] text-left ${
                    rootHit ? WARM_TINT : ""
                  } ${focusRing} focus-visible:ring-inset`}
                >
                  <span className="text-[#8A8A8A] w-3 flex items-center">
                    <Chevron open={expanded} />
                  </span>
                  {header}
                </button>
              ) : (
                <div
                  className={`w-full flex flex-wrap items-center gap-x-2 gap-y-1 px-4 py-3 min-h-[44px] ${
                    rootHit ? WARM_TINT : ""
                  }`}
                >
                  <span className="w-3 flex items-center justify-center">
                    <span className="w-[5px] h-[5px] rounded-full bg-[#C9A96E]" />
                  </span>
                  {header}
                </div>
              )}
              {expanded ? (
                <div className="px-3 pb-3 pt-1 border-t border-[#E8E6E1]">
                  {renderNodes(root.children!, 0, showsAllBelow(root.id))}
                </div>
              ) : null}
            </div>
          );
        })
      )}

      {/* The margin cascade is a sequence, not a tree */}
      {section.id === "frame" && !active && (
        <div className="rounded-[14px] border border-[#C9A96E]/40 bg-[#FBF6EC] p-4">
          <h3 className="font-trajan text-[11px] uppercase tracking-widest text-[#0A1931]">
            {t("tree.margin")}
          </h3>
          <p className="text-[11px] text-[#6B6B6B] mt-1 mb-3">{t("tree.marginBlurb")}</p>
          <ol className="space-y-1">
            {marginSteps.map((step, i) => (
              <li key={i} className="flex items-baseline gap-2">
                <span
                  className={`shrink-0 w-4 text-[12px] font-semibold ${
                    step.op === "=" ? "text-[#065F46]" : "text-[#DC2626]"
                  }`}
                >
                  {step.op}
                </span>
                <span
                  className={`text-[12px] ${
                    step.op === "=" ? "font-semibold text-[#0A1931]" : "text-[#6B6B6B]"
                  }`}
                >
                  {step.label}
                </span>
                {step.note && (
                  <span className="text-[11px] text-[#8A8A8A]">
                    ({MARGIN_NOTE_KEY[step.note] ? t(MARGIN_NOTE_KEY[step.note]) : step.note})
                  </span>
                )}
              </li>
            ))}
          </ol>
        </div>
      )}

      {/* Abbreviations + what was changed versus the raw sheets */}
      <div className="grid gap-4 md:grid-cols-2">
        <div className="bg-white rounded-[14px] border border-[#E8E6E1] p-4">
          <h3 className="font-trajan text-[11px] uppercase tracking-widest text-[#8A8A8A]">
            {t("tree.glossary")}
          </h3>
          <dl className="mt-3 space-y-1.5">
            {glossary.map(([abbr, meaning]) => {
              const key = `ux.products.gloss.${abbr}`;
              const local = t(key);
              return (
                <div key={abbr} className="flex gap-2 text-[12px]">
                  <dt className="shrink-0 w-12 font-semibold text-[#0A1931]">{abbr}</dt>
                  <dd className="text-[#6B6B6B]">{local === key ? meaning : local}</dd>
                </div>
              );
            })}
          </dl>
        </div>
        <div className="bg-white rounded-[14px] border border-[#E8E6E1] p-4">
          <h3 className="font-trajan text-[11px] uppercase tracking-widest text-[#8A8A8A]">
            {t("tree.changes")}
          </h3>
          <ul className="mt-3 space-y-2">
            {changeNotesKeys.map((key) => (
              <li key={key} className="flex gap-2 text-[12px] text-[#6B6B6B]">
                <span className="shrink-0 mt-[7px] w-[5px] h-[5px] rounded-full bg-[#C9A96E]" />
                <span>{t(key)}</span>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}
