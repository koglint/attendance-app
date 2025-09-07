// firebase-init.js
// Uses compat SDKs already loaded on the page.
// Fetches Firebase Web config from your backend (served from Step 4).

(function () {
  const PROD = location.hostname.endsWith("github.io");
  const API_BASE = PROD
    ? "https://attendance-app-lfwc.onrender.com"
    : "http://localhost:3000";

  async function loadConfig() {
    const res = await fetch(`${API_BASE}/public/firebase-config`, {
      // config is public; no creds needed
      credentials: "omit",
      cache: "no-store",
    });
    if (!res.ok) {
      throw new Error(`Failed to load Firebase config: ${res.status} ${res.statusText}`);
    }
    return res.json();
  }

  // Expose a promise the rest of the app can await
  window.firebaseReady = (async () => {
    if (!window.firebase || !firebase.initializeApp) {
      throw new Error("Firebase compat SDK not loaded (firebase-app-compat.js).");
    }
    const cfg = await loadConfig();
    window.firebaseConfig = cfg;

    const app = firebase.initializeApp(cfg);
    window.firebaseApp = app;
    window.firebaseAuth = firebase.auth();

    // Optional: Fire a DOM event others can hook if they prefer events
    document.dispatchEvent(new CustomEvent("firebase-ready"));

    return { app, auth: window.firebaseAuth };
  })().catch((e) => {
    console.error("[firebase-init] init failed:", e);
    window.firebaseInitError = e;
    throw e;
  });
})();
