// student.js (module)
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.4/firebase-app.js";
import {
  getAuth, onAuthStateChanged, signInWithPopup, GoogleAuthProvider, signOut
} from "https://www.gstatic.com/firebasejs/10.12.4/firebase-auth.js";

// ---- Config ----
const BACKEND = (window.BACKEND_BASE_URL || "").replace(/\/+$/,"");
const firebaseConfig = window.FIREBASE_CONFIG;

// Basic DOM helpers
const $ = (id) => document.getElementById(id);
const show = (id, on = true) => $(id).classList.toggle("hidden", !on);

// UI elements
const signInBtn   = $("signInBtn");
const signOutBtn  = $("signOutBtn");
const signedOut   = $("signedOut");
const loading     = $("loading");
const errorBox    = $("errorBox");
const errorText   = $("errorText");
const retryBtn    = $("retryBtn");

const summary     = $("summary");
const studentName = $("studentName");
const rollClass   = $("rollClass");
const termLabel   = $("termLabel");
const termPercent = $("termPercent");
const ytdPercent  = $("ytdPercent");
const trendBadge  = $("trendBadge");
const updatedAt   = $("updatedAt");

const toggleWeeksBtn = $("toggleWeeksBtn");
const weeks          = $("weeks");
const weeksTitle     = $("weeksTitle");
const weeksTable     = $("weeksTable").querySelector("tbody");
const versionTag     = $("versionTag");

// ---- Firebase init ----
const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
auth.useDeviceLanguage();

// ---- State ----
let currentSummary = null;

// ---- Auth UI ----
const provider = new GoogleAuthProvider();
provider.setCustomParameters({ hd: "education.nsw.gov.au" });
// (Optional) restrict prompt by domain in console; server enforces authorization anyway.

signInBtn.onclick = async () => {
  try {
    show("errorBox", false);
    await signInWithPopup(auth, provider);
  } catch (e) {
    if (String(e?.code).includes("popup-blocked")) {
      // Fallback for strict browsers
      const { signInWithRedirect } = await import("https://www.gstatic.com/firebasejs/10.12.4/firebase-auth.js");
      return signInWithRedirect(auth, provider);
    }
    show("errorBox", true);
    errorText.textContent = friendlyError(e) || "Sign-in failed.";
  }
};

signOutBtn.onclick = async () => {
  await signOut(auth);
};

retryBtn.onclick = () => {
  if (auth.currentUser) fetchSummary();
  else showSignedOut();
};

// ---- Auth state changes ----
onAuthStateChanged(auth, (user) => {
  if (!user) {
    showSignedOut();
    return;
  }
  showSignedIn();
  fetchSummary(); // fire and render
});

// ---- UI state helpers ----
function showSignedOut() {
  signInBtn.classList.remove("hidden");
  signOutBtn.classList.add("hidden");
  show("weeks", false);
  show("summary", false);
  show("loading", false);
  show("errorBox", false);
  show("signedOut", true);
}

function showSignedIn() {
  signInBtn.classList.add("hidden");
  signOutBtn.classList.remove("hidden");
  show("signedOut", false);
  show("weeks", false);
  show("errorBox", false);
  show("summary", false);
  show("loading", true);
}

// ---- Backend calls ----
async function authedFetch(path) {
  const user = auth.currentUser;
  if (!user) throw new Error("not-signed-in");
  // Get a fresh-ish token; retry once on 401
  let token = await user.getIdToken();
  let res = await fetch(BACKEND + path, {
    method: "GET",
    headers: { "Authorization": `Bearer ${token}` },
    cache: "no-store",
    //credentials: "include",
  });
  if (res.status === 401) {
    token = await user.getIdToken(true);
    res = await fetch(BACKEND + path, {
      method: "GET",
      headers: { "Authorization": `Bearer ${token}` },
      cache: "no-store",
      //credentials: "include",
    });
  }
  return res;
}

async function fetchSummary() {
  try {
    show("loading", true);
    const res = await authedFetch("/api/me/summary");
    if (!res.ok) return handleHttpError(res, "Could not load your summary.");
    const data = await res.json();
    currentSummary = data;
    renderSummary(data);
    show("loading", false);
    show("summary", true);
  } catch (e) {
    show("loading", false);
    show("errorBox", true);
    errorText.textContent = friendlyError(e) || "Something went wrong.";
  }
}

async function fetchWeeks(term) {
  try {
    show("weeks", true);
    weeksTable.innerHTML = "";
    weeksTitle.textContent = `Weekly detail — ${term}`;
    const res = await authedFetch(`/api/me/term?term=${encodeURIComponent(term)}`);
    if (!res.ok) return handleHttpError(res, "Could not load weekly data.");
    const data = await res.json();
    renderWeeks(data);
  } catch (e) {
    show("errorBox", true);
    errorText.textContent = friendlyError(e) || "Could not load weekly data.";
  }
}

// ---- Rendering ----
function renderSummary(s) {
  const name = [s.firstName, s.surname].filter(Boolean).join(" ");
  studentName.textContent = name || "Your profile";
  rollClass.textContent = `Roll: ${s.rollClass ?? "—"}`;
  termLabel.textContent = s.term || "—";
  termPercent.textContent = fmtPct(s.termPercent);
  ytdPercent.textContent = fmtPct(s.ytdPercent);
  trendBadge.textContent = fmtTrend(s.trend);
  updatedAt.textContent = s.updatedAt ? `Updated ${fmtDate(s.updatedAt)}` : "Updated —";

  toggleWeeksBtn.onclick = () => {
    if (!weeks.classList.contains("hidden")) {
      show("weeks", false);
      toggleWeeksBtn.textContent = "Show weekly detail";
    } else {
      fetchWeeks(s.term);
      toggleWeeksBtn.textContent = "Hide weekly detail";
    }
  };
}

function renderWeeks(d) {
  versionTag.textContent = d.version ? `Data version: ${d.version}` : "";
  const rows = [];
  // Keep a stable numeric week sort if keys are like "W01", "W02"
  const entries = Object.entries(d.weeks || {}).sort((a,b) => keyWeek(a[0]) - keyWeek(b[0]));
  for (const [wk, v] of entries) {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${wk}</td>
      <td>${v?.weekStart ? esc(v.weekStart) : "—"}</td>
      <td class="right">${fmtPct(v?.percent)}</td>
      <td class="right">${v?.absences ?? "—"}</td>
      <td class="right">${v?.lates ?? "—"}</td>
    `;
    rows.push(tr);
  }
  if (!rows.length) {
    const tr = document.createElement("tr");
    tr.innerHTML = `<td colspan="5" class="muted">No weekly data available for ${esc(d.term)} yet.</td>`;
    rows.push(tr);
  }
  weeksTable.replaceChildren(...rows);
}

// ---- Utils ----
function fmtPct(x) {
  return (typeof x === "number" && isFinite(x)) ? `${x.toFixed(0)}%` : "—";
}
function fmtTrend(t) {
  if (!t) return "—";
  if (t === "diamond") return "Improved";
  if (t === "gold") return "Maintained";
  if (t === "silver") return "Lower";
  return t;
}
function fmtDate(isoOrTS) {
  try {
    // Server can send an ISO string or Firestore Timestamp { _seconds, _nanoseconds } if serialized.
    const d = typeof isoOrTS === "string"
      ? new Date(isoOrTS)
      : (isoOrTS?._seconds ? new Date(isoOrTS._seconds * 1000) : null);
    return d ? d.toLocaleString() : "—";
  } catch { return "—"; }
}
function keyWeek(k) { const m = String(k).match(/(\d+)/); return m ? Number(m[1]) : 0; }
function esc(s) { return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function friendlyError(e) {
  const msg = (e?.message || "").toLowerCase();
  if (msg.includes("not-signed-in")) return "Please sign in first.";
  return e?.message || null;
}
async function handleHttpError(res, fallback) {
  let detail = "";
  try { detail = (await res.json())?.error || ""; } catch {}
  const code = res.status;
  if (code === 401) errorText.textContent = "Your session expired. Please sign in again.";
  else if (code === 403) errorText.textContent = detail || "You don't have access. If you're a student, ask your teacher to add your account.";
  else if (code === 404) errorText.textContent = detail || "We couldn't find your record. Ask your teacher to confirm your email and student ID.";
  else if (code === 429) errorText.textContent = "Too many requests right now. Please try again shortly.";
  else if (code === 503) errorText.textContent = "Service temporarily unavailable. Please try again.";
  else errorText.textContent = detail || fallback || "Something went wrong.";
  show("errorBox", true);
}
