import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { LangProvider } from "./lib/i18n";
import { IdentityProvider } from "./lib/identity";
import { AuthGate } from "./components/AuthGate";
import { initSkin } from "./lib/skin";
import { initPwa } from "./lib/pwa";
import { handleSpotifyCallback } from "./lib/spotifyAuth";
import "./index.css";
import "./styles/controls.css";
import "./styles/glass.css";

// Set the skin on <html> before React paints, so the first frame is correct.
initSkin();
// Installable app: service worker (code only, never data) + install prompt.
initPwa();
// Back from "Accedi con Spotify" (/callback?code&state): the address becomes
// /#/music/spotify before the router reads it, then the code is exchanged.
void handleSpotifyCallback();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <LangProvider>
      <IdentityProvider>
        <AuthGate>
          <App />
        </AuthGate>
      </IdentityProvider>
    </LangProvider>
  </React.StrictMode>
);
