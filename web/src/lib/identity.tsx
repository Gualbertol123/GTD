import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { readMe, writeMe } from "./prefs";
import { spotifyOwnerChanged } from "./spotifyAuth";

// "Who am I" — a single identity remembered in THIS browser (localStorage) and
// shared across the app: the Daily Reflection author, the default owner for new
// tasks, etc. It's a personal per-device preference, not board data.
interface IdentityCtx {
  me: string;
  setMe: (name: string) => void;
}

const Ctx = createContext<IdentityCtx | null>(null);

export function IdentityProvider({ children }: { children: React.ReactNode }) {
  const [me, setMeState] = useState<string>(() => readMe());
  const setMe = useCallback((name: string) => {
    setMeState(name);
    writeMe(name);
    // A Spotify sign-in belongs to the person, on this device: switch to theirs.
    spotifyOwnerChanged();
  }, []);
  // The name changed in another tab of this browser: this tab shows it too, and its Spotify
  // session follows (spotifyAuth hears the same event; calling it again does nothing new).
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key !== null && e.key !== "gtd-me") return;
      setMeState(readMe());
      spotifyOwnerChanged();
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);
  const value = useMemo(() => ({ me, setMe }), [me, setMe]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useMe(): IdentityCtx {
  const c = useContext(Ctx);
  if (!c) throw new Error("useMe must be used within IdentityProvider");
  return c;
}
