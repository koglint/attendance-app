// ==== CONFIG ====
const BACKEND_BASE_URL = window.BACKEND_BASE_URL || "https://attendance-app-lfwc.onrender.com";

// ====== UI wiring ======
const els = {
  signInBox: document.getElementById("signInBox"),
  whoami: document.getElementById("whoami"),
  signOutBtn: document.getElementById("signOutBtn"),
  signInBtn: document.getElementById("signInBtn"),
  email: document.getElementById("email"),
  password: document.getElementById("password"),
  authMsg: document.getElementById("authMsg"),

  onlyAuthed: document.getElementById("onlyAuthed"),
  uploadBtn: document.getElementById("uploadBtn"),
  csvFile: document.getElementById("csvFile"),
  uploadMsg: document.getElementById("uploadMsg"),
  uploadResult: document.getElementById("uploadResult"),

  checkMetaBtn: document.getElementById("checkMetaBtn"),
  checkClassesBtn: document.getElementById("checkClassesBtn"),
  checkMsg: document.getElementById("checkMsg"),
  checkOut: document.getElementById("checkOut"),

  yearSelect: document.getElementById("yearSelect"),
  termSelect: document.getElementById("termSelect"),
  weekSelect: document.getElementById("weekSelect"),

  rosterFile: document.getElementById("rosterFile"),
  uploadRosterBtn: document.getElementById("uploadRosterBtn"),
  rosterUploadMsg: document.getElementById("rosterUploadMsg"),
};

// Populate Year: currentYear-1 .. currentYear+1
(function initYearTermWeek() {
  const now = new Date();
  const y = now.getFullYear();
  const years = [y - 1, y, y + 1];
  if (els.yearSelect) {
    els.yearSelect.innerHTML = years.map(v => `<option value="${v}">${v}</option>`).join("");
    els.yearSelect.value = String(y);
  }
  const month = now.getMonth() + 1;
  const guessTerm = month <= 3 ? 1 : month <= 6 ? 2 : month <= 9 ? 3 : 4;
  if (els.termSelect) els.termSelect.value = String(guessTerm);
})();

function setMsg(el, text, kind="info") {
  if (!el) return;
  el.textContent = text || "";
  el.className = kind === "error" ? "err"
             : kind === "ok" ? "ok"
             : "muted";
}

function showAuthedUI(user) {
  if (els.signInBox) els.signInBox.style.display = "none";
  if (els.signOutBtn) els.signOutBtn.style.display = "inline-block";
  if (els.whoami) els.whoami.textContent = user?.email || "";
}

function showSignedOutUI() {
  IS_ADMIN = false; // reset admin flag on sign-out
  if (document.getElementById("adminContent")) {
    document.getElementById("adminContent").style.display = "none";
  }
  if (els.signInBox) els.signInBox.style.display = "block";
  if (els.onlyAuthed) els.onlyAuthed.style.display = "none";
  if (els.signOutBtn) els.signOutBtn.style.display = "none";
  if (els.whoami) els.whoami.textContent = "";
  setMsg(els.authMsg, "");
  setMsg(els.uploadMsg, "");
  if (els.uploadResult) els.uploadResult.textContent = "";
}

// ★ A tiny auth helper that defers to window.firebaseAuth once ready
const Auth = (() => {
  let _auth = null;                 // firebase auth instance
  let _currentUser = null;

  async function ready() {
    // Wait for whatever bootstrap you do in your firebase-init script
    // e.g., window.firebaseReady resolves after app+auth initialised with env from Render.
    if (window.firebaseReady) {
      try { await window.firebaseReady; } catch { /* ignore */ }
    }
    _auth = window.firebaseAuth || null;
    return _auth;
  }

  function onChange(cb) {
    if (_auth?.onAuthStateChanged) {
      _auth.onAuthStateChanged((u) => {
        _currentUser = u || null;
        cb(_currentUser);
      });
    } else {
      // If there's no firebase on the page, treat as signed-out
      _currentUser = null;
      cb(null);
    }
  }

  async function signIn(email, password) {
    if (!_auth?.signInWithEmailAndPassword) throw new Error("Auth not initialised");
    const cred = await _auth.signInWithEmailAndPassword(email.trim(), password);
    _currentUser = cred.user;
    return _currentUser;
  }

  async function signOut() {
    if (_auth?.signOut) await _auth.signOut();
    _currentUser = null;
  }

  function getUser() { return _currentUser; }

  async function getToken() {
    const u = _currentUser || _auth?.currentUser || null;
    if (!u?.getIdToken) return null;
    return await u.getIdToken();
  }

  // ★ Centralised authed fetch:
  async function fetch(path, init = {}) {
    const token = await getToken();
    const headers = new Headers(init.headers || {});
    if (token) headers.set("Authorization", `Bearer ${token}`);
    // Avoid sending both Authorization and credentials: 'include' together unless you need cookies.
    const final = {
      ...init,
      headers,
    };
    return await window.fetch(path, final);
  }

  return { ready, onChange, signIn, signOut, getUser, getToken, fetch };
})();

// === Admin gate ===
let IS_ADMIN = false;


// ★ Wrap all event wiring in a single async bootstrap so we only touch auth after it's ready
(async function bootstrap() {
  await (window.firebaseReady || Promise.resolve());

  await Auth.ready();

  // Enable sign-in once Firebase is ready
    if (els.signInBtn) {
      els.signInBtn.disabled = false;
      els.signInBtn.removeAttribute("aria-disabled");
      els.signInBtn.title = "Sign in";
    }


  // ====== Roster Upload ======
  els.uploadRosterBtn?.addEventListener("click", async () => {
    if (!IS_ADMIN) { setMsg(els.rosterUploadMsg, "Admin access required.", "error"); return; }

    if (!els.rosterFile?.files?.length) {
      setMsg(els.rosterUploadMsg, "Please choose a CSV file.", "error");
      return;
    }
    if (!confirm("This will upsert the roster and email lookup. Continue?")) return;

    
    const user = Auth.getUser();
    if (!user) { setMsg(els.rosterUploadMsg, "Sign in first", "error"); return; }

    setMsg(els.rosterUploadMsg, "Uploading…");
    try {
      const fd = new FormData();
      fd.append("file", els.rosterFile.files[0]);

      const res = await Auth.fetch(`${BACKEND_BASE_URL}/api/roster/upload`, {
        method: "POST",
        body: fd,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);

      setMsg(
        els.rosterUploadMsg,
        `Done: ${data.writtenRoster} students, ${data.writtenLookup} emails. ${data.warnings?.duplicateEmails?.length || 0} duplicate emails.`,
        "ok"
      );
    } catch (e) {
      setMsg(els.rosterUploadMsg, `Failed: ${e.message || e}`, "error");
    }
  });

// ====== Auth listeners ======
Auth.onChange(async (user) => {
  if (!user) {
    showSignedOutUI();
    return;
  }
  showAuthedUI(user); // hides login box, shows sign-out + whoami

  try {
    const r = await Auth.fetch(`${BACKEND_BASE_URL}/api/whoami`, { method: "GET" });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const me = await r.json().catch(() => ({}));

    IS_ADMIN = (me.role === "admin");
    const adminContent = document.getElementById("adminContent");

    if (IS_ADMIN) {
      if (adminContent) adminContent.style.display = "block";
      if (els.onlyAuthed) els.onlyAuthed.style.display = "block";
    } else {
      if (adminContent) adminContent.style.display = "none";
      if (els.onlyAuthed) els.onlyAuthed.style.display = "none";
      setMsg(els.authMsg, "Admin access required.", "error");
    }
  } catch (e) {
    IS_ADMIN = false;
    const adminContent = document.getElementById("adminContent");
    if (adminContent) adminContent.style.display = "none";
    if (els.onlyAuthed) els.onlyAuthed.style.display = "none";
  }
});






  // ====== Sign in/out buttons ======
  els.signOutBtn?.addEventListener("click", () => Auth.signOut());

  els.signInBtn?.addEventListener("click", async () => {
    setMsg(els.authMsg, "Signing in...");
    try {
      await Auth.signIn(els.email.value, els.password.value);
      setMsg(els.authMsg, "Signed in", "ok");
    } catch (e) {
      setMsg(els.authMsg, e.message || "Sign-in failed", "error");
    }
  });

  // ====== CSV Upload handling ======
  els.uploadBtn?.addEventListener("click", async () => {
    if (!IS_ADMIN) { setMsg(els.uploadMsg, "Admin access required.", "error"); return; }

    const user = Auth.getUser();
    if (!user) return setMsg(els.uploadMsg, "Please sign in first", "error");

    const file = els.csvFile?.files?.[0];
    if (!file) return setMsg(els.uploadMsg, "Choose a CSV file", "error");

    setMsg(els.uploadMsg, "Uploading...");
    if (els.uploadResult) els.uploadResult.textContent = "";

    try {
      const fd = new FormData();
      fd.append("file", file, file.name);

      // Add the snapshot labels
      const year = Number(els.yearSelect?.value);
      const term = Number(els.termSelect?.value);
      const week = Number(els.weekSelect?.value);

      if (!Number.isInteger(year) || year < 2000 || year > 2100)
        return setMsg(els.uploadMsg, "Please choose a valid Year", "error");
      if (![1, 2, 3, 4].includes(term))
        return setMsg(els.uploadMsg, "Please choose a valid Term (1-4)", "error");
      if (!Number.isInteger(week) || week < 1 || week > 12)
        return setMsg(els.uploadMsg, "Please choose a valid Week (1-12)", "error");

      fd.append("year", String(year));
      fd.append("term", String(term));
      fd.append("week", String(week));

      // Confirmation popup
      const proceed = window.confirm(
        `Are you sure you want to upload this CSV?\n\n` +
        `• File: ${file.name}\n` +
        `• Year: ${year}\n` +
        `• Term: ${term}\n` +
        `• Week: ${week}\n\n` +
        `This will create a new snapshot and may overwrite existing data for these labels.`
      );
      if (!proceed) {
        setMsg(els.uploadMsg, "Upload cancelled.");
        return;
      }

      const resp = await Auth.fetch(`${BACKEND_BASE_URL}/api/uploads`, {
        method: "POST",
        body: fd
      });

      const text = await resp.text();
      let data;
      try { data = JSON.parse(text); } catch { data = { raw: text }; }

      if (!resp.ok) {
        setMsg(els.uploadMsg, "Upload failed", "error");
        if (els.uploadResult) els.uploadResult.textContent = JSON.stringify(data, null, 2);
        return;
      }

      setMsg(els.uploadMsg, "Upload complete", "ok");
      if (els.uploadResult) els.uploadResult.textContent = JSON.stringify(data, null, 2);
    } catch (e) {
      setMsg(els.uploadMsg, e.message || "Network error", "error");
    }
  });

  // ====== Quick check buttons ======
  els.checkMetaBtn?.addEventListener("click", async () => {
    if (!IS_ADMIN) { setMsg(els.checkMsg, "Admin access required.", "error"); return; }
    const user = Auth.getUser();
    if (!user) return setMsg(els.checkMsg, "Sign in first", "error");
    const r = await Auth.fetch(`${BACKEND_BASE_URL}/api/snapshots/latest/meta`, { method: "GET" });
    const j = await r.json().catch(() => ({}));
    if (els.checkOut) els.checkOut.textContent = JSON.stringify(j, null, 2);
  });

  els.checkClassesBtn?.addEventListener("click", async () => {
    if (!IS_ADMIN) { setMsg(els.checkMsg, "Admin access required.", "error"); return; }
    const user = Auth.getUser();
    if (!user) return setMsg(els.checkMsg, "Sign in first", "error");
    const r = await Auth.fetch(`${BACKEND_BASE_URL}/api/snapshots/latest/classes`, { method: "GET" });
    const j = await r.json().catch(() => ({}));
    if (els.checkOut) els.checkOut.textContent = JSON.stringify(j, null, 2);
  });
})();
