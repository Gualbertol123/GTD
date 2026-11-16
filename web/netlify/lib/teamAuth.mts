// Shared by the server functions: is this request from a logged-in team
// account? The caller's Supabase access token is checked with the database's
// own is_team_member() — the same rule every table uses.
//
// A "yes" is remembered for up to 5 minutes per token (never past the token's
// own expiry), so a warm instance asks Supabase once, not on every click. Only
// a hash of the token is kept. Accepted trade-off: someone removed from the
// team keeps access for at most those 5 minutes.

import { createHash } from "node:crypto";

const SUPABASE_URL = process.env.VITE_SUPABASE_URL ?? process.env.SUPABASE_URL ?? "";
const SUPABASE_ANON_KEY = process.env.VITE_SUPABASE_ANON_KEY ?? process.env.SUPABASE_ANON_KEY ?? "";

const REMEMBER_MS = 5 * 60_000;
const MAX_TOKENS = 200;
const RPC_TIMEOUT_MS = 3000;

/** False when the server lacks the Supabase settings (a deploy problem). */
export function supabaseConfigured(): boolean {
  return !!SUPABASE_URL && !!SUPABASE_ANON_KEY;
}

/** "no": not logged in or not in the team. "unavailable": Supabase could not answer (down, slow, not set up). */
export type TeamCheck = "yes" | "no" | "unavailable";

/** token hash → until when the "yes" holds */
const members = new Map<string, number>();
/** token hash → the check on its way (two requests at once ask Supabase once) */
const pending = new Map<string, Promise<TeamCheck>>();

/** The JWT's exp (ms), read without verifying: only to never remember a "yes" past it. */
export function tokenExpiry(token: string): number {
  try {
    const payload = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8"));
    return typeof payload?.exp === "number" ? payload.exp * 1000 : Infinity;
  } catch {
    return Infinity;
  }
}

function remember(key: string, until: number) {
  members.delete(key);
  if (members.size >= MAX_TOKENS) {
    const now = Date.now();
    for (const [k, t] of members) if (t <= now) members.delete(k);
    while (members.size >= MAX_TOKENS) members.delete(members.keys().next().value!);
  }
  members.set(key, until);
}

async function ask(authorization: string): Promise<TeamCheck> {
  try {
    const res = await fetch(`${SUPABASE_URL.replace(/\/$/, "")}/rest/v1/rpc/is_team_member`, {
      method: "POST",
      headers: {
        apikey: SUPABASE_ANON_KEY,
        Authorization: authorization,
        "Content-Type": "application/json",
      },
      body: "{}",
      signal: AbortSignal.timeout(RPC_TIMEOUT_MS),
    });
    // 401 / 403: an expired or foreign token. 5xx / 429: Supabase's problem, not the user's.
    if (res.status === 401 || res.status === 403) return "no";
    if (!res.ok) return "unavailable";
    return (await res.json()) === true ? "yes" : "no";
  } catch {
    return "unavailable"; // timeout or network
  }
}

export async function checkTeam(authorization: string): Promise<TeamCheck> {
  const m = /^Bearer\s+(\S+)$/.exec(authorization);
  if (!m) return "no";
  if (!supabaseConfigured()) return "unavailable";
  const key = createHash("sha256").update(m[1]).digest("hex");
  const now = Date.now();
  const until = members.get(key);
  if (until !== undefined) {
    if (until > now) return "yes";
    members.delete(key);
  }
  let p = pending.get(key);
  if (!p) {
    p = ask(authorization).then((r) => {
      pending.delete(key);
      if (r === "yes") {
        const t = Math.min(Date.now() + REMEMBER_MS, tokenExpiry(m[1]));
        if (t > Date.now()) remember(key, t);
      }
      return r;
    });
    pending.set(key, p);
  }
  return p;
}

/** Kept for report-pdf: true only for a confirmed team member. */
export async function isTeamMember(authorization: string): Promise<boolean> {
  return (await checkTeam(authorization)) === "yes";
}

/** For tests. */
export function forgetMembers() {
  members.clear();
  pending.clear();
}
