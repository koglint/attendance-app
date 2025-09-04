// ==== CONFIG ====
const BACKEND_BASE_URL = "https://attendance-app-lfwc.onrender.com"; // your Render URL

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

  onlyAdmin: document.getElementById("onlyAdmin"),
  checkMetaBtn: document.getElementById("checkMetaBtn"),
  checkClassesBtn: document.getElementById("checkClassesBtn"),
  checkMsg: document.getElementById("checkMsg"),
  checkOut: document.getElementById("checkOut"),
};

function setMsg(el, text, kind="info") {
  el.textContent = text || "";
  el.className = kind === "error" ? "err"
             : kind === "ok" ? "ok"
             : "muted";
}

function showAuthedUI(user) {
  els.signInBox.style.display = "none";
  els.onlyAuthed.style.display = "block";
  els.signOutBtn.style.display = "inline-block";
  els.whoami.textContent = `${user.email}`;
}

function showSignedOutUI() {
  els.signInBox.style.display = "block";
  els.onlyAuthed.style.display = "none";
  els.onlyAdmin.style.display = "none";
  els.signOutBtn.style.display = "none";
  els.whoami.textContent = "";
  setMsg(els.authMsg, "");
  setMsg(els.uploadMsg, "");
  els.uploadResult.textContent = "";
}

// ====== Auth listeners ======
firebaseAuth.onAuthStateChanged(async (user) => {
  if (!user) return showSignedOutUI();
  showAuthedUI(user);

  // Optional: probe an admin-only endpoint to toggle "onlyAdmin" UI.
  try {
    const token = await user.getIdToken();
    const r = await fetch(`${BACKEND_BASE_URL}/api/snapshots/latest/meta`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (r.status === 403) {
      // teacher or viewer account
      els.onlyAdmin.style.display = "none";
    } else if (r.ok) {
      els.onlyAdmin.style.display = "block"; // meta is teacher-accessible; you can keep this visible for admin checks
    }
  } catch {}
});

els.signOutBtn.addEventListener("click", () => firebaseAuth.signOut());

els.signInBtn.addEventListener("click", async () => {
  setMsg(els.authMsg, "Signing in...");
  try {
    await firebaseAuth.signInWithEmailAndPassword(els.email.value.trim(), els.password.value);
    setMsg(els.authMsg, "Signed in", "ok");
  } catch (e) {
    setMsg(els.authMsg, e.message || "Sign-in failed", "error");
  }
});

// ====== Upload handling ======
els.uploadBtn.addEventListener("click", async () => {
  const user = firebaseAuth.currentUser;
  if (!user) return setMsg(els.uploadMsg, "Please sign in first", "error");

  const file = els.csvFile.files[0];
  if (!file) return setMsg(els.uploadMsg, "Choose a CSV file", "error");

  setMsg(els.uploadMsg, "Uploading...");
  els.uploadResult.textContent = "";

  try {
    const token = await user.getIdToken();
    const fd = new FormData();
    fd.append("file", file, file.name);

    const resp = await fetch(`${BACKEND_BASE_URL}/api/uploads`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: fd
    });

    const text = await resp.text();
    let data;
    try { data = JSON.parse(text); } catch { data = { raw: text }; }

    if (!resp.ok) {
      setMsg(els.uploadMsg, "Upload failed", "error");
      els.uploadResult.textContent = JSON.stringify(data, null, 2);
      return;
    }

    setMsg(els.uploadMsg, "Upload complete", "ok");
    els.uploadResult.textContent = JSON.stringify(data, null, 2);
  } catch (e) {
    setMsg(els.uploadMsg, e.message || "Network error", "error");
  }
});

// ====== Quick check buttons ======
if (els.checkMetaBtn) {
  els.checkMetaBtn.addEventListener("click", async () => {
    const user = firebaseAuth.currentUser;
    if (!user) return setMsg(els.checkMsg, "Sign in first", "error");
    const token = await user.getIdToken();
    const r = await fetch(`${BACKEND_BASE_URL}/api/snapshots/latest/meta`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const j = await r.json().catch(() => ({}));
    els.checkOut.textContent = JSON.stringify(j, null, 2);
  });
}
if (els.checkClassesBtn) {
  els.checkClassesBtn.addEventListener("click", async () => {
    const user = firebaseAuth.currentUser;
    if (!user) return setMsg(els.checkMsg, "Sign in first", "error");
    const token = await user.getIdToken();
    const r = await fetch(`${BACKEND_BASE_URL}/api/snapshots/latest/classes`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const j = await r.json().catch(() => ({}));
    els.checkOut.textContent = JSON.stringify(j, null, 2);
  });
}
