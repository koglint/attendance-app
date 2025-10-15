// firebase-init.js — fetch config from Render backend (no CI injection)
// Exposes: window.firebaseReady (Promise<{ app, auth }>), window.firebaseApp, window.firebaseAuth
(function () {
  // Avoid double-initialisation if script is included twice
  if (window.firebaseReady) return;

  // The backend base URL is set in teacher.html before this script
  const BASE =
    (typeof window.BACKEND_BASE_URL === "string" && window.BACKEND_BASE_URL.replace(/\/$/, "")) ||
    "";

  async function fetchConfig() {
    const url = `${BASE}/public/firebase-config`; // ✅ match your existing server route
    const resp = await fetch(url, {
      method: "GET",
      credentials: "omit",
      cache: "no-store",
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      throw new Error(`Failed to load Firebase config: ${resp.status} ${resp.statusText} ${text}`);
    }
    return resp.json();
  }

  window.firebaseReady = (async () => {
    if (!window.firebase || !firebase.initializeApp) {
      throw new Error("Firebase compat SDK not loaded.");
    }

    const cfg = await fetchConfig();

    // Defensive checks — helps catch wrong env var names on the server
    for (const k of ["apiKey", "authDomain", "projectId", "appId"]) {
      if (!cfg[k]) throw new Error(`Missing Firebase config key: ${k}`);
    }

    const app = (firebase.apps && firebase.apps.length) ? firebase.app() : firebase.initializeApp(cfg);
    const auth = firebase.auth();

    // Back-compat globals for existing app code
    window.firebaseApp = app;
    window.firebaseAuth = auth;

    // Optional: analytics if available (will no-op if not configured)
    try { firebase.analytics && firebase.analytics(); } catch {}

    // Optional event for any listeners
    try { document.dispatchEvent(new CustomEvent("firebase-ready")); } catch {}

    return { app, auth };
  })().catch((e) => {
    console.error("[firebase-init] init failed:", e);
    window.firebaseInitError = e;
    throw e;
  });
})();
