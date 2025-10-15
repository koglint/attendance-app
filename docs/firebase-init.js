// firebase-init.js — expects window.firebaseConfig injected at deploy time
(function () {
  window.firebaseReady = (async () => {
    if (!window.firebase || !firebase.initializeApp) {
      throw new Error("Firebase compat SDK not loaded.");
    }
    const cfg = window.firebaseConfig;
    if (!cfg) throw new Error("window.firebaseConfig missing — did CI inject it?");
    const app = firebase.initializeApp(cfg);
    const auth = firebase.auth();
    window.firebaseApp = app;
    window.firebaseAuth = auth;
    document.dispatchEvent(new CustomEvent("firebase-ready"));
    return { app, auth };
  })().catch((e) => {
    console.error("[firebase-init] init failed:", e);
    window.firebaseInitError = e;
    throw e;
  });
})();
