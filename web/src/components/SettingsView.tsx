import { useEffect, useRef, useState } from "react";
import type { Board, Op } from "../lib/types";
import { DEFAULT_LOGIN_DAYS } from "../lib/constants";
import { changeTeamPassword, signOutDevice, outcomeKey } from "../lib/auth";
import { useT } from "../lib/i18n";
import { ConfirmInline } from "./ConfirmInline";
import {
  processImage,
  ImageError,
  LOGO_ACCEPT,
  FAVICON_ACCEPT,
  INPUT_MAX_MB,
} from "../lib/image";

interface Props {
  board: Board;
  send: (op: Op, onError?: (message: string) => void) => void;
}

type SaveStatus = "idle" | "saved" | "failed";

// Feedback next to the button that saved. send() is optimistic and only
// reports failure, so "Saved" shows at once and turns into the red "Not
// saved" message if the server later refuses the write.
function useSaveStatus(send: Props["send"]) {
  const [status, setStatus] = useState<SaveStatus>("idle");
  const timer = useRef<ReturnType<typeof setTimeout>>();
  useEffect(() => () => clearTimeout(timer.current), []);
  const run = (ops: Op[]) => {
    clearTimeout(timer.current);
    setStatus("saved");
    let failed = false;
    for (const op of ops)
      send(op, () => {
        failed = true;
        clearTimeout(timer.current);
        setStatus("failed");
      });
    timer.current = setTimeout(() => {
      if (!failed) setStatus("idle");
    }, 2000);
  };
  return { status, run, reset: () => setStatus("idle") };
}

function SaveNote({ status }: { status: SaveStatus }) {
  const { t } = useT();
  return (
    <span role="status" aria-live="polite" className="text-[12px]">
      {status === "saved" && <span className="text-[#065F46]">{t("settings.saved")}</span>}
      {status === "failed" && <span className="text-[#C81E1E]">{t("notes.failed")}</span>}
    </span>
  );
}

const capLabel = "text-[11px] uppercase tracking-wide text-[#6B6B6B]";

export function SettingsView({ board, send }: Props) {
  const { t } = useT();
  const savedDays = board.loginDays ?? DEFAULT_LOGIN_DAYS;
  const [days, setDays] = useState(String(savedDays));
  const [imgErr, setImgErr] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<null | "logo" | "favicon" | "logout">(null);
  const logoSave = useSaveStatus(send);
  const faviconSave = useSaveStatus(send);
  const daysSave = useSaveStatus(send);

  const logoInput = useRef<HTMLInputElement>(null);
  const faviconInput = useRef<HTMLInputElement>(null);

  const upload = async (file: File | undefined, kind: "logo" | "favicon") => {
    if (!file) return;
    setImgErr(null);
    try {
      const dataUrl = await processImage(file, kind);
      if (kind === "logo") logoSave.run([{ type: "setBranding", logoUrl: dataUrl }]);
      else faviconSave.run([{ type: "setBranding", faviconUrl: dataUrl }]);
    } catch (e) {
      setImgErr(e instanceof ImageError && e.code === "big" ? t("settings.imageTooBig") : t("settings.imageBad"));
    }
  };

  const normDays = Math.max(1, Math.min(365, parseInt(days, 10) || DEFAULT_LOGIN_DAYS));
  const daysUnchanged = normDays === savedDays;

  const input =
    "w-full h-10 rounded-lg bg-[#F5F3EF] border border-[#E8E6E1] px-3 text-[13px] field";
  const saveBtn = "h-10 px-5 rounded-full bg-[#0A1931] text-[#C9A96E] text-[12px] font-semibold shrink-0";
  const smallBtn = "h-9 px-4 rounded-full text-[12px] font-semibold border";

  return (
    <div className="max-w-[640px] mx-auto space-y-4">
      <h2 className="font-trajan text-[16px] uppercase tracking-widest text-[#0A1931]">{t("settings.title")}</h2>

      {/* Branding */}
      <section className="bg-white rounded-[14px] border border-[#E8E6E1] p-5 space-y-4">
        <h3 className="font-trajan text-[11px] uppercase tracking-widest text-[#7A5F30]">
          {t("settings.branding")}
        </h3>

        {/* Logo */}
        <div className="flex items-center gap-4">
          <div className="w-14 h-14 rounded-full border-2 border-[#C9A96E] flex items-center justify-center overflow-hidden bg-[#0A1931] shrink-0">
            {board.logoUrl ? (
              <img src={board.logoUrl} alt={t("settings.logo")} className="w-full h-full object-contain" />
            ) : (
              <span className="font-trajan text-[#C9A96E] text-[18px]">G</span>
            )}
          </div>
          <div className="min-w-0">
            <div className="text-[12px] font-semibold text-[#0A1931]">{t("settings.logo")}</div>
            <div className="text-[11px] text-[#6B6B6B]">{t("settings.logoHint", { mb: INPUT_MAX_MB })}</div>
            <div className="flex items-center gap-2 mt-2 flex-wrap">
              <input ref={logoInput} type="file" accept={LOGO_ACCEPT} hidden onChange={(e) => upload(e.target.files?.[0], "logo")} />
              <button onClick={() => logoInput.current?.click()} className={`${smallBtn} bg-[#0A1931] text-[#C9A96E] border-[#0A1931]`}>
                {t("settings.upload")}
              </button>
              {board.logoUrl && (confirm === "logo" ? (
                <ConfirmInline
                  text={t("ux.shell.confirmRemoveLogo")}
                  onYes={() => {
                    setConfirm(null);
                    logoSave.run([{ type: "setBranding", logoUrl: null }]);
                  }}
                  onNo={() => setConfirm(null)}
                />
              ) : (
                <button onClick={() => setConfirm("logo")} className={`${smallBtn} bg-white text-[#C81E1E] border-[#FECACA]`}>
                  {t("settings.remove")}
                </button>
              ))}
              <SaveNote status={logoSave.status} />
            </div>
          </div>
        </div>

        {/* Favicon */}
        <div className="flex items-center gap-4">
          <div className="w-14 h-14 rounded-lg border border-[#E8E6E1] flex items-center justify-center overflow-hidden bg-[#F5F3EF] shrink-0">
            {board.faviconUrl ? (
              <img src={board.faviconUrl} alt={t("settings.favicon")} className="w-8 h-8 object-contain" />
            ) : (
              <span className="text-ink-3 text-[10px]">—</span>
            )}
          </div>
          <div className="min-w-0">
            <div className="text-[12px] font-semibold text-[#0A1931]">{t("settings.favicon")}</div>
            <div className="text-[11px] text-[#6B6B6B]">{t("settings.faviconHint", { mb: INPUT_MAX_MB })}</div>
            <div className="flex items-center gap-2 mt-2 flex-wrap">
              <input ref={faviconInput} type="file" accept={FAVICON_ACCEPT} hidden onChange={(e) => upload(e.target.files?.[0], "favicon")} />
              <button onClick={() => faviconInput.current?.click()} className={`${smallBtn} bg-[#0A1931] text-[#C9A96E] border-[#0A1931]`}>
                {t("settings.upload")}
              </button>
              {board.faviconUrl && (confirm === "favicon" ? (
                <ConfirmInline
                  text={t("ux.shell.confirmRemoveFavicon")}
                  onYes={() => {
                    setConfirm(null);
                    faviconSave.run([{ type: "setBranding", faviconUrl: null }]);
                  }}
                  onNo={() => setConfirm(null)}
                />
              ) : (
                <button onClick={() => setConfirm("favicon")} className={`${smallBtn} bg-white text-[#C81E1E] border-[#FECACA]`}>
                  {t("settings.remove")}
                </button>
              ))}
              <SaveNote status={faviconSave.status} />
            </div>
          </div>
        </div>

        {imgErr && <div role="alert" className="text-[11px] text-[#C81E1E]">{imgErr}</div>}
      </section>

      <SubtitleSection board={board} send={send} input={input} saveBtn={saveBtn} />

      {/* Access */}
      <section className="bg-white rounded-[14px] border border-[#E8E6E1] p-5 space-y-3">
        <h3 className="font-trajan text-[11px] uppercase tracking-widest text-[#7A5F30]">{t("settings.access")}</h3>
        <TeamPasswordForm input={input} saveBtn={saveBtn} />
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (daysUnchanged) return;
            setDays(String(normDays));
            daysSave.run([{ type: "setAccess", loginDays: normDays }]);
          }}
        >
          <label htmlFor="settings-login-days" className={capLabel}>{t("settings.loginDuration")}</label>
          <div className="flex items-center gap-2 mt-1 flex-wrap sm:flex-nowrap">
            <input
              id="settings-login-days"
              type="number"
              min={1}
              max={365}
              value={days}
              onChange={(e) => {
                setDays(e.target.value);
                daysSave.reset();
              }}
              className={input}
            />
            <button
              type="submit"
              disabled={daysUnchanged}
              title={daysUnchanged ? t("ux.shell.unchanged") : undefined}
              className={`${saveBtn} disabled:opacity-50`}
            >
              {t("settings.save")}
            </button>
          </div>
          <div className="mt-1 min-h-[18px]"><SaveNote status={daysSave.status} /></div>
        </form>

        {confirm === "logout" ? (
          <ConfirmInline
            text={t("ux.shell.confirmLogout")}
            onYes={async () => {
              await signOutDevice();
              window.location.reload();
            }}
            onNo={() => setConfirm(null)}
          />
        ) : (
          <button
            onClick={() => setConfirm("logout")}
            className="h-10 px-4 rounded-full text-[12px] font-semibold text-[#C81E1E] border border-[#FECACA]"
          >
            {t("settings.logoutNow")}
          </button>
        )}
      </section>

      <p className="text-[11px] text-[#6B6B6B]">{t("settings.migrationNote")}</p>
    </div>
  );
}

// The header subtitle in both languages (also editable in the header itself).
function SubtitleSection({ board, send, input, saveBtn }: { board: Board; send: Props["send"]; input: string; saveBtn: string }) {
  const { t } = useT();
  const [it, setIt] = useState(board.subtitleIt ?? "");
  const [en, setEn] = useState(board.subtitleEn ?? "");
  const save = useSaveStatus(send);
  const ops: Op[] = [];
  if (it.trim() !== (board.subtitleIt ?? "").trim()) ops.push({ type: "setSubtitle", lang: "it", text: it.trim() });
  if (en.trim() !== (board.subtitleEn ?? "").trim()) ops.push({ type: "setSubtitle", lang: "en", text: en.trim() });

  return (
    <section className="bg-white rounded-[14px] border border-[#E8E6E1] p-5">
      <h3 className="font-trajan text-[11px] uppercase tracking-widest text-[#7A5F30] mb-3">
        {t("settings.subtitleSection")}
      </h3>
      <form
        className="space-y-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (ops.length) save.run(ops);
        }}
      >
        <div>
          <label htmlFor="settings-sub-it" className={capLabel}>{t("settings.subtitleIt")}</label>
          <input id="settings-sub-it" value={it} placeholder={t("app.subtitle")}
            onChange={(e) => { setIt(e.target.value); save.reset(); }} className={`${input} mt-1`} />
        </div>
        <div>
          <label htmlFor="settings-sub-en" className={capLabel}>{t("settings.subtitleEn")}</label>
          <input id="settings-sub-en" value={en} placeholder={t("app.subtitle")}
            onChange={(e) => { setEn(e.target.value); save.reset(); }} className={`${input} mt-1`} />
        </div>
        <div className="flex items-center gap-3 pt-1">
          <button type="submit" disabled={ops.length === 0} title={ops.length === 0 ? t("ux.shell.unchanged") : undefined}
            className={`${saveBtn} disabled:opacity-50`}>
            {t("settings.save")}
          </button>
          <SaveNote status={save.status} />
        </div>
      </form>
    </section>
  );
}

// Change the shared team password (Supabase Auth). Needs the current one; on
// success every other device is logged out and must use the new password.
// Forgotten? An admin resets it from Supabase (README → Security → Admin).
function TeamPasswordForm({ input, saveBtn }: { input: string; saveBtn: string }) {
  const { t } = useT();
  const [cur, setCur] = useState("");
  const [np, setNp] = useState("");
  const [np2, setNp2] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; key: string; detail?: string } | null>(null);

  const submit = async () => {
    if (busy || !cur || !np || !np2) return;
    if (np.length < 12) return setMsg({ ok: false, key: "settings.pwdTooShort" });
    if (np !== np2) return setMsg({ ok: false, key: "settings.pwdMismatch" });
    setBusy(true);
    setMsg(null);
    const out = await changeTeamPassword(cur, np);
    setBusy(false);
    if (out.result === "ok") {
      setCur("");
      setNp("");
      setNp2("");
      setMsg({ ok: true, key: "settings.pwdChanged" });
    } else {
      const key =
        out.result === "wrong" ? "settings.pwdWrongCurrent"
        : out.result === "invalid" ? "settings.pwdRejected" // Supabase's own rule, e.g. its minimum length
        : outcomeKey(out.result);
      setMsg({ ok: false, key, detail: out.detail });
    }
  };

  const onChange = (set: (v: string) => void) => (e: React.ChangeEvent<HTMLInputElement>) => {
    set(e.target.value);
    setMsg(null);
  };

  const cap = "text-[10px] uppercase tracking-wide text-ink-3";

  return (
    <form
      className="block"
      aria-labelledby="team-pwd-title"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <span id="team-pwd-title" className={capLabel}>{t("settings.teamPassword")}</span>
      <div className="space-y-2 mt-1">
        <div>
          <label htmlFor="team-pwd-cur" className={cap}>{t("settings.pwdCurrent")}</label>
          <input id="team-pwd-cur" type="password" autoComplete="current-password" value={cur} onChange={onChange(setCur)}
            className={`${input} mt-0.5`} />
        </div>
        <div>
          <label htmlFor="team-pwd-new" className={cap}>{t("settings.pwdNew")}</label>
          <input id="team-pwd-new" type="password" autoComplete="new-password" value={np} onChange={onChange(setNp)}
            className={`${input} mt-0.5`} />
        </div>
        <div>
          <label htmlFor="team-pwd-new2" className={cap}>{t("settings.pwdConfirm")}</label>
          <div className="flex gap-2 mt-0.5">
            <input id="team-pwd-new2" type="password" autoComplete="new-password" value={np2} onChange={onChange(setNp2)}
              className={input} />
            <button type="submit" disabled={busy || !cur || !np || !np2} className={`${saveBtn} disabled:opacity-60`}>
              {busy ? "…" : t("settings.save")}
            </button>
          </div>
        </div>
      </div>
      <p className="text-[11px] text-ink-3 mt-1">{t("settings.pwdHint")}</p>
      {msg && (
        <p role={msg.ok ? "status" : "alert"} className={`text-[12px] mt-1 ${msg.ok ? "text-[#065F46]" : "text-[#C81E1E]"}`}>
          {t(msg.key)}
          {msg.detail && <span className="block opacity-70 mt-0.5 text-[11px]">{msg.detail}</span>}
        </p>
      )}
    </form>
  );
}
