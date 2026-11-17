import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useT } from "../lib/i18n";
import { mlog, music } from "../lib/music";
import { osOf, outputsOf, systemPickerUrl, type Output, type OutKind } from "../lib/audioOutput";
import "../styles/audioOut.css";

// -----------------------------------------------------------------------------
// "Uscita audio" (player bar, ♪ panel): the computer's outputs, the one in
// use, live changes, and the system's own picker (lib/audioOutput.ts says why
// the page itself can't move YouTube's / Spotify's audio).
// -----------------------------------------------------------------------------

function Ico({ kind, size = 18 }: { kind: OutKind | "out"; size?: number }) {
  const p = { width: size, height: size, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.8, strokeLinecap: "round" as const, strokeLinejoin: "round" as const, "aria-hidden": true, className: "mi" };
  if (kind === "headphones")
    return (
      <svg {...p}>
        <path d="M4 15v-3a8 8 0 0 1 16 0v3" />
        <rect x="3" y="14" width="4" height="6" rx="1.5" />
        <rect x="17" y="14" width="4" height="6" rx="1.5" />
      </svg>
    );
  if (kind === "bluetooth")
    return (
      <svg {...p}>
        <path d="m7 7 10 10-5 4V3l5 4L7 17" />
      </svg>
    );
  if (kind === "speaker")
    return (
      <svg {...p}>
        <rect x="6" y="3" width="12" height="18" rx="2.5" />
        <circle cx="12" cy="14" r="3" />
        <path d="M12 7h.01" />
      </svg>
    );
  // The button: a speaker with an arrow out.
  return (
    <svg {...p}>
      <path d="M10 6 6 9H3v6h3l4 3z" />
      <path d="M14 12h7" />
      <path d="m18 9 3 3-3 3" />
    </svg>
  );
}

/** The outputs, followed live (devicechange), with a pill when one connects or the one in use changes. */
function useOutputs(watch: boolean) {
  const [list, setList] = useState<Output[] | null>(null);
  const [inUse, setInUse] = useState<string | null>(null);
  const [supported] = useState(() => typeof navigator !== "undefined" && !!navigator.mediaDevices?.enumerateDevices);
  const prev = useRef<{ ids: Set<string>; inUse: string | null } | null>(null);
  const { t } = useT();

  const read = useCallback(async () => {
    if (!supported) return;
    try {
      const r = outputsOf(await navigator.mediaDevices.enumerateDevices());
      setList(r.outputs);
      setInUse(r.inUse);
      const was = prev.current;
      if (was) {
        const added = r.outputs.find((o) => o.label && !was.ids.has(o.id));
        if (r.inUse && was.inUse && r.inUse !== was.inUse) music.toast(t("ux.music.outNow", { d: r.inUse }));
        else if (added) music.toast(t("ux.music.outAdded", { d: added.label }));
      }
      prev.current = { ids: new Set(r.outputs.map((o) => o.id)), inUse: r.inUse };
      mlog("audio outputs", { n: r.outputs.length, inUse: r.inUse, named: r.outputs.some((o) => o.label) });
    } catch (e) {
      mlog("audio outputs: not readable", { error: String(e) }, "warn");
      setList([]);
    }
  }, [supported, t]);

  useEffect(() => {
    if (!watch || !supported) return;
    void read();
    const md = navigator.mediaDevices;
    md.addEventListener?.("devicechange", read);
    return () => md.removeEventListener?.("devicechange", read);
  }, [watch, supported, read]);

  /** Chrome / Edge give names only once the page may use a microphone: asked once, nothing is recorded. */
  const askNames = useCallback(async () => {
    try {
      const s = await navigator.mediaDevices.getUserMedia({ audio: true });
      s.getTracks().forEach((tr) => tr.stop());
    } catch (e) {
      mlog("audio outputs: names refused", { error: String(e) });
    }
    await read();
  }, [read]);

  return { list, inUse, supported, askNames };
}

export function AudioOutputButton({ className = "mt-iconbtn" }: { className?: string }) {
  const { t } = useT();
  const [open, setOpen] = useState(false);
  const btn = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; bottom: number } | null>(null);
  const os = osOf();
  const link = systemPickerUrl(os);
  // Followed while the button is on screen, so a pill tells when the output changes.
  const { list, inUse, supported, askNames } = useOutputs(true);

  useLayoutEffect(() => {
    if (!open || !btn.current) return;
    const r = btn.current.getBoundingClientRect();
    const w = 320;
    setPos({ left: Math.max(8, Math.min(window.innerWidth - w - 8, r.right - w)), bottom: window.innerHeight - r.top + 8 });
  }, [open]);

  useEffect(() => {
    if (!open) return;
    panel.current?.querySelector<HTMLElement>("button, a[href]")?.focus();
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        setOpen(false);
        btn.current?.focus();
      }
    };
    const down = (e: PointerEvent) => {
      if (!panel.current?.contains(e.target as Node) && !btn.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("keydown", key);
    document.addEventListener("pointerdown", down);
    return () => {
      document.removeEventListener("keydown", key);
      document.removeEventListener("pointerdown", down);
    };
  }, [open]);

  const named = !!list?.some((o) => o.label);
  return (
    <>
      <button
        ref={btn}
        className={className}
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={t("ux.music.out")}
        title={inUse ? `${t("ux.music.out")}: ${inUse}` : t("ux.music.out")}
      >
        <Ico kind="out" />
      </button>
      {open &&
        pos &&
        createPortal(
          <div ref={panel} className="ao-panel" role="dialog" aria-label={t("ux.music.out")} style={{ left: pos.left, bottom: pos.bottom }}>
            <div className="ao-head">
              <b>{t("ux.music.out")}</b>
              {inUse && <span className="ao-now">{t("ux.music.outInUse", { d: inUse })}</span>}
            </div>
            {supported && list && list.length > 0 && (
              <ul className="ao-list">
                {list.map((o, i) => (
                  <li key={o.id} className={o.active ? "is-on" : ""} aria-current={o.active || undefined}>
                    <Ico kind={o.kind} size={16} />
                    <span className="ao-name">{o.label || t("ux.music.outUnnamed", { n: i + 1 })}</span>
                    {o.active && <span className="ao-tag">{t("ux.music.outActive")}</span>}
                  </li>
                ))}
              </ul>
            )}
            {supported && list && !named && list.length > 0 && (
              <div className="ao-names">
                <button className="ao-link" onClick={() => void askNames()}>
                  {t("ux.music.outShowNames")}
                </button>
                <small>{t("ux.music.outNamesNote")}</small>
              </div>
            )}
            {(!supported || (list && list.length === 0)) && <p className="ao-note">{t("ux.music.outNoList")}</p>}
            {link ? (
              <a className="ao-primary" href={link} onClick={() => mlog("audio outputs: system picker", { os })}>
                <Ico kind="out" size={16} /> {t("ux.music.outChange")}
              </a>
            ) : null}
            <p className="ao-note">{t(os === "windows" ? "ux.music.outTipWin" : os === "mac" ? "ux.music.outTipMac" : "ux.music.outTipOther")}</p>
            <p className="ao-fine">{t("ux.music.outWhy")}</p>
          </div>,
          document.body
        )}
    </>
  );
}
