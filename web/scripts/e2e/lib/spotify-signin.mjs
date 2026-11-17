// -----------------------------------------------------------------------------
// The Spotify sign-in for the e2e checks, the real way: the app's own
// "Accedi con Spotify" (PKCE) goes to accounts.spotify.com/authorize, which is
// answered here with a redirect straight back to /callback?code&state, and the
// token exchange gets a fake token. The app then seals it per person on this
// device (WebCrypto + IndexedDB) as it would for real. Nothing real is called.
// -----------------------------------------------------------------------------

/** Routes accounts.spotify.com: /authorize → back to the app with a code; /api/token → `access`. */
export async function routeSpotifyAccounts(context, { access = "fake-access" } = {}) {
  await context.route("https://accounts.spotify.com/**", async (route) => {
    const u = new URL(route.request().url());
    if (u.pathname === "/authorize") {
      const back = new URL(u.searchParams.get("redirect_uri"));
      back.searchParams.set("code", "e2e-code");
      back.searchParams.set("state", u.searchParams.get("state") ?? "");
      return route.fulfill({ status: 302, headers: { location: back.toString() } });
    }
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: { "access-control-allow-origin": "*" },
      body: JSON.stringify({ access_token: access, refresh_token: "fake-refresh", expires_in: 3600, scope: "" }),
    });
  });
}

/** Clicks `button` (a sign-in button) and waits until the app is back from Spotify (the caller waits for what it shows). */
export async function signInWith(page, button, { timeout = 20000 } = {}) {
  await Promise.all([page.waitForURL(/\/callback\?code=/, { timeout, waitUntil: "commit" }), button.click()]);
  await page.waitForURL((u) => u.pathname === "/" && /#\/music\//.test(u.hash), { timeout });
}
