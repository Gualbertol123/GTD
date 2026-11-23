import { useEffect, useMemo, useState } from "react";
import type { Board, Op, Reflection } from "../lib/types";
import { useT, localeCode, type Lang } from "../lib/i18n";
import { useMe } from "../lib/identity";
import { toISODate } from "../lib/dates";
import { reflectionLogin, reflectionChangePassword, outcomeKey } from "../lib/auth";
import { PersonalNotes } from "./PersonalNotes";
import {
  readReviewedToday,
  writeReviewedToday,
  isReflAuthed,
  setReflAuth,
  clearReflAuth,
  reflAuthValue,
  readPref,
  writePref,
} from "../lib/prefs";

// --- Drafts --------------------------------------------------------------------
// Today's unsaved diary text, kept in memory only (never in localStorage: the
// diary has its own password because devices are shared). Survives switching
// pane or tab; gone on reload, on save, and on either logout.
type DraftFields = { done: string; well: string; improve: string; learning: string };
const drafts = new Map<string, DraftFields>();
export function clearReflDrafts(member?: string): void {
  if (!member) return drafts.clear();
  for (const k of [...drafts.keys()]) if (k.endsWith(`::${member}`)) drafts.delete(k);
}

// --- Who logged in with the initial password (this tab only) -------------------
const INITIAL_KEY = "gtd-refl-initial";
function readInitial(): string[] {
  try {
    const v = JSON.parse(sessionStorage.getItem(INITIAL_KEY) ?? "[]");
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}
function markInitial(member: string, on: boolean): void {
  try {
    const set = new Set(readInitial());
    if (on) set.add(member);
    else set.delete(member);
    sessionStorage.setItem(INITIAL_KEY, JSON.stringify([...set]));
  } catch {
    /* storage blocked: no banner */
  }
}

// --- How long the diary stays open here: the duration picked, next to the expiry
// the prefs keep (older logins have no entry: the date is still shown).
const DAYS_KEY = "gtd-refl-days";
function readDaysMap(): Record<string, number | "never"> {
  try {
    const v = JSON.parse(localStorage.getItem(DAYS_KEY) ?? "{}");
    return v && typeof v === "object" ? v : {};
  } catch {
    return {};
  }
}
function writeDays(member: string, days: number | "never" | null): void {
  try {
    const m = readDaysMap();
    if (days === null) delete m[member];
    else m[member] = days;
    localStorage.setItem(DAYS_KEY, JSON.stringify(m));
  } catch {
    /* storage blocked */
  }
}
function rememberAuth(member: string, days: number | "never"): void {
  setReflAuth(member, days);
  writeDays(member, days);
}
function forgetAuth(member: string): void {
  clearReflAuth(member);
  writeDays(member, null);
  clearReflDrafts(member);
  markInitial(member, false);
}

// Small outline icons (currentColor), sized to the text beside them.
function Icon({ d, size = 14 }: { d: React.ReactNode; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8}
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false"
      className="inline-block align-[-2px] shrink-0">
      {d}
    </svg>
  );
}
const ICON_BOOK = (
  <>
    <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20V3H6.5A2.5 2.5 0 0 0 4 5.5z" />
    <path d="M4 19.5A2.5 2.5 0 0 0 6.5 22H20v-5" />
  </>
);
const ICON_REVIEW = (
  <>
    <path d="M3 12a9 9 0 1 0 3-6.7L3 8" />
    <path d="M3 3v5h5" />
    <path d="M12 7v5l3 2" />
  </>
);
const ICON_SHUFFLE = (
  <>
    <path d="M16 3h5v5" />
    <path d="M4 20 21 3" />
    <path d="M21 16v5h-5" />
    <path d="m15 15 6 6" />
    <path d="M4 4l5 5" />
  </>
);

function isoMinus(iso: string, days: number): string {
  const d = new Date(iso);
  d.setDate(d.getDate() - days);
  return toISODate(d);
}

function dayLabel(iso: string, lang: Lang, t: (k: string, v?: Record<string, string | number>) => string): string {
  const today = toISODate(new Date());
  if (iso === today) return t("reflection.today");
  if (iso === isoMinus(today, 1)) return t("review.yesterday");
  return new Date(iso).toLocaleDateString(localeCode(lang));
}

const field =
  "w-full rounded-lg bg-[#F5F3EF] border border-[#E8E6E1] p-2 text-[12px] field resize-none";
const label = "font-trajan text-[10px] uppercase tracking-wide text-[#A8A29E] mb-1 block";

type Pane = "diary" | "notes";

interface Props {
  board: Board;
  members: string[];
  send: (op: Op, onError?: (message: string) => void) => void;
}

const DURATIONS: { k: string; days: number | "never" }[] = [
  { k: "reflAuth.d1", days: 1 },
  { k: "reflAuth.d7", days: 7 },
  { k: "reflAuth.d30", days: 30 },
  { k: "reflAuth.d365", days: 365 },
  { k: "reflAuth.never", days: "never" },
];

function RememberSelect({
  value,
  onChange,
}: {
  value: number | "never" | null;
  onChange: (v: number | "never") => void;
}) {
  const { t } = useT();
  return (
    <label className="inline-flex items-center gap-2 flex-wrap text-[11px] text-[#8A8A8A]">
      {t("reflAuth.remember")}
      <select
        value={value === null ? "" : String(value)}
        onChange={(e) => onChange(e.target.value === "never" ? "never" : Number(e.target.value))}
        className="h-8 rounded-full bg-[#F5F3EF] border border-[#E8E6E1] px-3 text-[12px] text-[#0A1931] field"
      >
        {value === null && <option value="" disabled>{t("ux.shell.rememberPick")}</option>}
        {DURATIONS.map((d) => (
          <option key={d.k} value={String(d.days)}>{t(d.k)}</option>
        ))}
      </select>
    </label>
  );
}

export function DailyReflection({ board, members, send }: Props) {
  const { t, lang } = useT();
  const { me, setMe } = useMe();
  const today = toISODate(new Date());
  const [tick, setTick] = useState(0);
  // Which half of this tab you are looking at. Remembered per browser: the
  // notes used to sit under everything else, which made them a scroll away.
  const [pane, setPane] = useState<Pane>(() =>
    readPref("reflpane") === "notes" ? "notes" : "diary"
  );
  const pickPane = (next: Pane) => {
    setPane(next);
    writePref("reflpane", next);
  };
  const bump = () => setTick((n) => n + 1);

  const authed = !!me && isReflAuthed(me);

  if (!authed) {
    return (
      <ReflectionLogin
        members={members}
        onAuthed={(user) => {
          setMe(user);
          bump();
        }}
      />
    );
  }

  const noteCount = (board.personalNotes ?? []).filter((n) => n.member === me).length;
  const id = `${today}::${me}`;
  const existing = board.reflections.find((r) => r.id === id) ?? null;

  return (
    <div className="space-y-4" data-t={tick}>
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <h3 className="font-trajan text-[12px] uppercase tracking-widest text-[#C9A96E]">
          {t("reflAuth.title")} · {me}
        </h3>
        <button
          onClick={() => {
            forgetAuth(me);
            bump();
          }}
          className="h-8 px-4 rounded-full text-[12px] font-semibold text-[#8A8A8A] border border-[#E8E6E1] hover:border-[#DC2626] hover:text-[#DC2626]"
        >
          {t("reflAuth.logout")}
        </button>
      </div>

      {/* One click between the two halves, so neither is a scroll away. */}
      <div className="flex gap-1.5">
        {(["diary", "notes"] as Pane[]).map((key) => {
          const on = pane === key;
          const count = key === "notes" ? noteCount : 0;
          return (
            <button
              key={key}
              onClick={() => pickPane(key)}
              aria-pressed={on}
              className="tab h-9 px-4 text-[11px] font-semibold uppercase tracking-wide"
            >
              {t(key === "diary" ? "reflection.paneDiary" : "reflection.paneNotes")}
              {count > 0 && <span className="tab__count">{count}</span>}
            </button>
          );
        })}
      </div>

      {pane === "diary" ? (
        <>
          <ReflectionForm key={id} id={id} me={me} date={today} existing={existing} send={send} />

          <SpacedReview me={me} today={today} reflections={board.reflections} />

          <RecentList reflections={board.reflections} member={me} lang={lang} />
        </>
      ) : (
        <PersonalNotes board={board} me={me} send={send} />
      )}

      <AccountSection me={me} onChanged={bump} />
    </div>
  );
}

function ReflectionLogin({
  members,
  onAuthed,
}: {
  members: string[];
  onAuthed: (user: string) => void;
}) {
  const { t } = useT();
  const { me } = useMe();
  const [user, setUser] = useState(me && members.includes(me) ? me : members[0] ?? "");
  const [pwd, setPwd] = useState("");
  const [remember, setRemember] = useState<number | "never">(30);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<{ key: string; detail?: string } | null>(null);

  // Checked by the database (reflection_login); passwords are stored there
  // as hashes and never sent to the browser.
  const submit = async () => {
    if (!user || !pwd || busy) return;
    setBusy(true);
    setErr(null);
    const out = await reflectionLogin(user, pwd);
    setBusy(false);
    if (out.result === "ok") {
      rememberAuth(user, remember);
      // Still on the initial password: ask to change it, once inside.
      markInitial(user, pwd === "password");
      onAuthed(user);
    } else {
      setErr({ key: outcomeKey(out.result), detail: out.detail });
    }
  };

  return (
    <div className="max-w-[420px] mx-auto mt-8 bg-white rounded-[16px] border border-[#E8E6E1] p-6">
      <div className="w-12 h-12 rounded-full bg-[#0A1931] text-[#C9A96E] flex items-center justify-center mx-auto">
        <Icon d={ICON_BOOK} size={22} />
      </div>
      <h3 className="font-trajan text-[14px] uppercase tracking-widest text-[#0A1931] mt-4 text-center">
        {t("reflAuth.title")}
      </h3>
      <p className="text-[12px] text-[#8A8A8A] mt-2 mb-4 text-center">{t("reflAuth.prompt")}</p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
      <div className="space-y-2">
        <label className="block">
          <span className="text-[11px] uppercase tracking-wide text-[#8A8A8A]">{t("reflAuth.user")}</span>
          <select
            value={user}
            onChange={(e) => {
              setUser(e.target.value);
              setErr(null);
            }}
            className="mt-1 w-full h-10 rounded-lg bg-[#F5F3EF] border border-[#E8E6E1] px-3 text-[13px] field"
          >
            {members.map((m) => (
              <option key={m} value={m}>{m}</option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="text-[11px] uppercase tracking-wide text-[#8A8A8A]">{t("reflAuth.password")}</span>
          <input
            type="password"
            value={pwd}
            autoFocus
            onChange={(e) => {
              setPwd(e.target.value);
              setErr(null);
            }}
            aria-invalid={!!err}
            className={`mt-1 w-full h-10 rounded-lg bg-[#F5F3EF] border px-3 text-[13px] border-[#E8E6E1] field`}
          />
        </label>
        {err && (
          <p role="alert" className="text-[11px] text-[#DC2626]">
            {t(err.key)}
            {err.detail && <span className="block opacity-70 mt-0.5">{err.detail}</span>}
          </p>
        )}
        <div className="pt-1">
          <RememberSelect value={remember} onChange={setRemember} />
        </div>
      </div>
      <button
        type="submit"
        disabled={busy || !pwd}
        className="mt-4 w-full h-10 rounded-full bg-[#0A1931] text-[#C9A96E] text-[13px] font-semibold disabled:opacity-60"
      >
        {busy ? t("auth.checking") : t("reflAuth.enter")}
      </button>
      </form>
      <p className="text-[11px] text-[#A8A29E] mt-3 text-center">{t("reflAuth.hint")}</p>
    </div>
  );
}

function AccountSection({ me, onChanged }: { me: string; onChanged: () => void }) {
  const { t, lang } = useT();
  const [cur, setCur] = useState("");
  const [np, setNp] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; key: string; detail?: string } | null>(null);
  const [initial, setInitial] = useState(() => readInitial().includes(me));
  // The duration actually chosen; unknown for logins made before it was kept.
  const [remember, setRemember] = useState<number | "never" | null>(() => {
    const v = reflAuthValue(me);
    if (v === "never") return "never";
    const d = readDaysMap()[me];
    return typeof d === "number" ? d : null;
  });
  const [exp, setExp] = useState(() => reflAuthValue(me));

  // Changing needs the current password: the server checks it, so a teammate
  // at an unlocked screen cannot quietly change someone else's.
  const change = async () => {
    if (busy || !cur || !np) return;
    if (np.length < 6) {
      setMsg({ ok: false, key: "authr.invalid" });
      return;
    }
    setBusy(true);
    setMsg(null);
    const out = await reflectionChangePassword(me, cur, np);
    setBusy(false);
    if (out.result === "ok") {
      setCur("");
      setNp("");
      setMsg({ ok: true, key: "reflAuth.changed" });
      if (np !== "password") {
        markInitial(me, false);
        setInitial(false);
      }
      onChanged();
      setTimeout(() => setMsg(null), 2500);
    } else {
      setMsg({ ok: false, key: out.result === "wrong" ? "reflAuth.wrongCurrent" : outcomeKey(out.result), detail: out.detail });
    }
  };

  const field =
    "w-full h-9 rounded-lg bg-[#F5F3EF] border border-[#E8E6E1] px-3 text-[13px] field";
  const cap = "text-[10px] uppercase tracking-wide text-[#A8A29E]";
  const until =
    exp === "never"
      ? t("ux.shell.rememberForever")
      : typeof exp === "number"
        ? t("ux.shell.rememberUntil", {
            date: new Date(exp).toLocaleDateString(localeCode(lang), { day: "numeric", month: "long", year: "numeric" }),
          })
        : null;

  return (
    <div className="bg-white rounded-[14px] border border-[#E8E6E1] p-4 space-y-3">
      {initial && (
        <div role="alert" className="rounded-lg border border-[#FECACA] bg-[#FEF2F2] px-3 py-2 text-[12px] font-semibold text-[#DC2626]">
          {t("ux.shell.changeInitial")}
        </div>
      )}
      <h4 id="refl-account-title" className="font-trajan text-[11px] uppercase tracking-widest text-[#8A8A8A]">
        {t("reflAuth.account")}
      </h4>
      <form
        aria-labelledby="refl-account-title"
        className="flex gap-2 flex-wrap items-end"
        onSubmit={(e) => {
          e.preventDefault();
          change();
        }}
      >
        <div className="flex-1 min-w-[160px]">
          <label htmlFor="refl-pwd-cur" className={cap}>{t("reflAuth.currentPassword")}</label>
          <input
            id="refl-pwd-cur"
            type="password"
            autoComplete="current-password"
            value={cur}
            onChange={(e) => {
              setCur(e.target.value);
              setMsg(null);
            }}
            className={`${field} mt-0.5`}
          />
        </div>
        <div className="flex-1 min-w-[160px]">
          <label htmlFor="refl-pwd-new" className={cap}>{t("reflAuth.newPassword")}</label>
          <input
            id="refl-pwd-new"
            type="password"
            autoComplete="new-password"
            value={np}
            onChange={(e) => {
              setNp(e.target.value);
              setMsg(null);
            }}
            className={`${field} mt-0.5`}
          />
        </div>
        <button
          type="submit"
          disabled={busy || !cur || !np}
          className="h-9 px-4 rounded-full bg-[#0A1931] text-[#C9A96E] text-[12px] font-semibold shrink-0 disabled:opacity-60"
        >
          {busy ? "…" : t("settings.save")}
        </button>
      </form>
      <p className="text-[11px] text-[#A8A29E]">{t("reflAuth.newHint")}</p>
      {msg && (
        <div role={msg.ok ? "status" : "alert"} className={`text-[12px] ${msg.ok ? "text-[#065F46]" : "text-[#DC2626]"}`}>
          {t(msg.key)}
          {msg.detail && <span className="block opacity-70 mt-0.5 text-[11px]">{msg.detail}</span>}
        </div>
      )}
      <div>
        <RememberSelect
          value={remember}
          onChange={(v) => {
            setRemember(v);
            rememberAuth(me, v);
            setExp(reflAuthValue(me));
          }}
        />
        {until && <p className="text-[11px] text-[#A8A29E] mt-1">{until}</p>}
      </div>
    </div>
  );
}

function ReflectionForm({
  id,
  me,
  date,
  existing,
  send,
}: {
  id: string;
  me: string;
  date: string;
  existing: Reflection | null;
  send: (op: Op, onError?: (message: string) => void) => void;
}) {
  const { t } = useT();
  const [fields, setFields] = useState<DraftFields>(
    () =>
      drafts.get(id) ?? {
        done: existing?.done ?? "",
        well: existing?.well ?? "",
        improve: existing?.improve ?? "",
        learning: existing?.learning ?? "",
      }
  );
  const [status, setStatus] = useState<"idle" | "saved" | "failed">("idle");

  const keys = ["done", "well", "improve", "learning"] as const;
  const dirty = keys.some((k) => fields[k].trim() !== (existing?.[k] ?? "").trim());

  // Keep the draft in memory while it differs from what is saved, so leaving
  // the pane or the tab does not lose it.
  useEffect(() => {
    if (dirty) drafts.set(id, fields);
    else drafts.delete(id);
  }, [id, fields, dirty]);

  // Closing or reloading the page with unsaved text: let the browser ask.
  useEffect(() => {
    if (!dirty) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [dirty]);

  // "Saved" shows at once (send is optimistic) and turns red if the server
  // refuses the write later.
  useEffect(() => {
    if (status !== "saved") return;
    const tm = setTimeout(() => setStatus("idle"), 1800);
    return () => clearTimeout(tm);
  }, [status]);

  const set = (k: keyof DraftFields) => (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const v = e.target.value;
    setFields((f) => ({ ...f, [k]: v }));
    if (status === "failed") setStatus("idle");
  };

  const save = () => {
    const now = Date.now();
    const reflection: Reflection = {
      id,
      member: me,
      date,
      done: fields.done.trim(),
      well: fields.well.trim(),
      improve: fields.improve.trim(),
      learning: fields.learning.trim(),
      updatedAt: now,
      createdAt: existing?.createdAt ?? now,
    };
    const kept = fields;
    drafts.delete(id);
    setStatus("saved");
    send({ type: "reflectionSave", reflection }, () => {
      // Refused: keep the text as an unsaved draft again.
      drafts.set(id, kept);
      setStatus("failed");
    });
  };

  const labels: Record<keyof DraftFields, string> = {
    done: t("reflection.done"),
    well: t("reflection.well"),
    improve: t("reflection.improve"),
    learning: t("reflection.learning"),
  };

  return (
    <div className="bg-[#FAF9F6] rounded-[12px] border border-[#E8E6E1] p-3 space-y-3">
      {existing && (
        <div className="text-[11px] text-[#8B6F3E]">{t("reflection.editingToday")}</div>
      )}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        {keys.map((k) => (
          <div key={k}>
            <label htmlFor={`refl-${k}`} className={label}>{labels[k]}</label>
            <textarea id={`refl-${k}`} rows={2} value={fields[k]} onChange={set(k)} className={field} />
          </div>
        ))}
      </div>
      <div className="flex items-center gap-3 flex-wrap">
        <button onClick={save} className="h-9 px-5 rounded-full bg-[#0A1931] text-[#C9A96E] text-[12px] font-semibold">
          {t("reflection.save")}
        </button>
        <span role="status" aria-live="polite" className="text-[12px]">
          {status === "failed" ? (
            <span className="text-[#DC2626]">{t("notes.failed")}</span>
          ) : status === "saved" ? (
            <span className="text-[#065F46]">{t("reflection.saved")}</span>
          ) : dirty ? (
            <span className="text-[#92400E]">{t("ux.shell.unsavedDraft")}</span>
          ) : null}
        </span>
      </div>
    </div>
  );
}

const OFFSETS = [1, 3, 7, 14, 30];

function SpacedReview({
  me,
  today,
  reflections,
}: {
  me: string;
  today: string;
  reflections: Reflection[];
}) {
  const { t, lang } = useT();
  const [reviewed, setReviewed] = useState<Set<string>>(() => readReviewedToday(today));
  const [randomId, setRandomId] = useState<string | null>(null);

  // Entries whose learning note is "due" at a spaced interval and not yet
  // reviewed today.
  const due = useMemo(() => {
    if (!me) return [];
    return OFFSETS.map((off) => ({ off, date: isoMinus(today, off) }))
      .map(({ off, date }) => ({
        off,
        date,
        r: reflections.find(
          (x) => x.member === me && x.date === date && (x.learning.trim() || x.improve.trim())
        ),
      }))
      .filter((x): x is { off: number; date: string; r: Reflection } => !!x.r && !reviewed.has(x.r.id));
  }, [me, today, reflections, reviewed]);

  const markReviewed = (rid: string) => {
    const next = new Set(reviewed);
    next.add(rid);
    setReviewed(next);
    writeReviewedToday(today, [...next]);
  };

  const pool = useMemo(
    () => reflections.filter((r) => r.member === me && r.learning.trim() && r.date !== today),
    [reflections, me, today]
  );
  const rollRandom = () => {
    if (pool.length === 0) return setRandomId(null);
    setRandomId(pool[Math.floor(Math.random() * pool.length)].id);
  };
  const randomR = randomId ? reflections.find((r) => r.id === randomId) : null;

  const daysAgo = (off: number) => (off === 1 ? t("review.yesterday") : t("review.daysAgo", { n: off }));

  return (
    <div className="bg-white rounded-[12px] border border-[#E8E6E1] p-3">
      <div className="flex items-center justify-between gap-2 flex-wrap mb-1">
        <h4 className="font-trajan text-[11px] uppercase tracking-widest text-[#8A8A8A]">
          <Icon d={ICON_REVIEW} /> {t("review.title")}
        </h4>
        {pool.length > 0 && (
          <button onClick={rollRandom} className="h-7 px-3 rounded-full text-[11px] font-semibold bg-[#F5F3EF] border border-[#E8E6E1] text-[#6B6B6B] hover:border-[#C9A96E]">
            <span className="inline-flex items-center gap-1.5"><Icon d={ICON_SHUFFLE} size={12} />{t("review.random")}</span>
          </button>
        )}
      </div>
      <p className="text-[11px] text-[#8A8A8A] mb-2">{t("review.hint")}</p>

      {randomR && (
        <div className="mb-2 rounded-lg border border-[#C9A96E]/50 bg-[#FBF6EC] p-2.5">
          <div className="text-[10px] uppercase tracking-wide text-[#8B6F3E] mb-1">
            {dayLabel(randomR.date, lang, t)}
          </div>
          <div className="text-[12px] text-[#0A1931] whitespace-pre-wrap">{randomR.learning}</div>
        </div>
      )}

      {due.length === 0 ? (
        <div className="text-[12px] text-[#A8A29E]">{t("review.none")}</div>
      ) : (
        <div className="space-y-2">
          {due.map(({ off, r }) => (
            <div key={r.id} className="rounded-lg border border-[#E8E6E1] bg-[#FAF9F6] p-2.5">
              <div className="flex items-center justify-between gap-2 mb-1">
                <span className="text-[10px] uppercase tracking-wide text-[#8A8A8A]">{daysAgo(off)}</span>
                <button
                  onClick={() => markReviewed(r.id)}
                  className="h-7 px-3 rounded-full text-[11px] font-semibold bg-[#0A1931] text-[#C9A96E]"
                >
                  {t("review.markReviewed")}
                </button>
              </div>
              {r.learning.trim() && (
                <div className="text-[12px] text-[#0A1931] whitespace-pre-wrap">{r.learning}</div>
              )}
              {r.improve.trim() && (
                <div className="text-[11px] text-[#92400E] mt-1 whitespace-pre-wrap">↻ {r.improve}</div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function RecentList({
  reflections,
  member,
  lang,
}: {
  reflections: Reflection[];
  member: string;
  lang: Lang;
}) {
  const { t } = useT();
  const recent = useMemo(
    () =>
      reflections
        .filter((r) => r.member === member)
        .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0))
        .slice(0, 14),
    [reflections, member]
  );

  if (recent.length === 0) {
    return <div className="text-[12px] text-[#A8A29E]">{t("reflection.none")}</div>;
  }

  const row = (label: string, text: string, color: string) =>
    text.trim() ? (
      <div className="flex gap-2">
        <span className={`w-[104px] shrink-0 text-[9px] font-semibold uppercase tracking-wide pt-0.5 ${color}`}>
          {label}
        </span>
        <span className="flex-1 min-w-0 text-[12px] text-[#0A1931] whitespace-pre-wrap break-words">{text}</span>
      </div>
    ) : null;

  return (
    <div>
      <h4 className="font-trajan text-[11px] uppercase tracking-widest text-[#8A8A8A] mb-2">
        {t("reflection.recent")}
      </h4>
      <div className="space-y-2">
        {recent.map((r) => (
          <div key={r.id} className="rounded-lg border border-[#E8E6E1] bg-white p-2.5">
            <div className="flex items-center gap-2 mb-2">
              <span className="w-5 h-5 rounded-full bg-[#0A1931] text-white text-[9px] font-bold flex items-center justify-center">
                {r.member.charAt(0).toUpperCase()}
              </span>
              <span className="text-[12px] font-semibold text-[#0A1931]">{r.member}</span>
              <span className="text-[10px] text-[#A8A29E] ml-auto">{dayLabel(r.date, lang, t)}</span>
            </div>
            <div className="space-y-1.5">
              {row(t("reflection.done"), r.done, "text-[#065F46]")}
              {row(t("reflection.well"), r.well, "text-[#8B6F3E]")}
              {row(t("reflection.improve"), r.improve, "text-[#92400E]")}
              {row(t("reflection.learning"), r.learning, "text-[#3A5A8A]")}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
