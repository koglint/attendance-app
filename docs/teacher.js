// ==== CONFIG ====
const BACKEND_BASE_URL = "https://attendance-app-lfwc.onrender.com"; // your Render URL

// ====== UI refs ======
const els = {
  signInBox: document.getElementById("signInBox"),
  whoami: document.getElementById("whoami"),
  signOutBtn: document.getElementById("signOutBtn"),
  signInBtn: document.getElementById("signInBtn"),
  email: document.getElementById("email"),
  password: document.getElementById("password"),
  authMsg: document.getElementById("authMsg"),

  onlyAuthed: document.getElementById("onlyAuthed"),
  snapshotInfo: document.getElementById("snapshotInfo"),
  classSelect: document.getElementById("classSelect"),
  refreshBtn: document.getElementById("refreshBtn"),

  tableMsg: document.getElementById("tableMsg"),
  dataTable: document.getElementById("dataTable"),
  tbody: document.querySelector("#dataTable tbody"),
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
  els.signOutBtn.style.display = "none";
  els.whoami.textContent = "";
  setMsg(els.authMsg, "");
  setMsg(els.snapshotInfo, "");
  setMsg(els.tableMsg, "Choose a class to view.");
  els.classSelect.innerHTML = `<option value="">(select a class)</option>`;
  els.dataTable.style.display = "none";
  els.tbody.innerHTML = "";
}

function formatUploadedAt(uploadedAt) {
  // Handle Firestore timestamp objects {_seconds, _nanoseconds} or ISO strings/null
  if (!uploadedAt) return "No snapshot yet";
  try {
    if (typeof uploadedAt === "string") return new Date(uploadedAt).toLocaleString();
    if (uploadedAt._seconds) return new Date(uploadedAt._seconds * 1000).toLocaleString();
  } catch {}
  return String(uploadedAt);
}

// ====== Auth listeners ======
firebaseAuth.onAuthStateChanged(async (user) => {
  if (!user) return showSignedOutUI();
  showAuthedUI(user);
  await loadSnapshotMetaAndClasses();
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

// ====== Data loading ======
async function authedFetch(path) {
  const user = firebaseAuth.currentUser;
  if (!user) throw new Error("Not signed in");
  const token = await user.getIdToken();
  const resp = await fetch(`${BACKEND_BASE_URL}${path}`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  if (resp.status === 401) throw new Error("Not authorised (401)");
  return resp;
}

async function loadSnapshotMetaAndClasses() {
  try {
    setMsg(els.snapshotInfo, "Loading…");

    // meta (now returns {snapshotId, uploadedAt, year, term, week, label})
    const m = await (await authedFetch("/api/snapshots/latest/meta")).json();
    if (!m.snapshotId) {
      setMsg(els.snapshotInfo, "No snapshot yet — ask admin to upload a CSV");
      els.classSelect.innerHTML = `<option value="">(no classes)</option>`;
      return;
    }

    // Choose the nicest text to show: label > composed Y/T/W > snapshotId
    const ytw =
      m.label ||
      (m.year && m.term && m.week ? `${m.year} Term ${m.term} Week ${m.week}` : null);

    const uploaded = formatUploadedAt(m.uploadedAt);
    const line = ytw ? `${ytw} • Uploaded: ${uploaded}` : `Snapshot: ${m.snapshotId} • Uploaded: ${uploaded}`;
    setMsg(els.snapshotInfo, line);

    // classes
    const classes = await (await authedFetch("/api/snapshots/latest/classes")).json();
    if (!Array.isArray(classes) || classes.length === 0) {
      els.classSelect.innerHTML = `<option value="">(no classes)</option>`;
      return;
    }
    const current = els.classSelect.value;
    els.classSelect.innerHTML =
      `<option value="">(select a class)</option>` +
      classes.map(c => `<option value="${encodeURIComponent(c.rollClass)}">${c.rollClass}</option>`).join("");

    // keep selection if still present
    if (current && [...els.classSelect.options].some(o => o.value === current)) {
      els.classSelect.value = current;
      if (current) { loadRows(decodeURIComponent(current)); }
    }
  } catch (e) {
    setMsg(els.snapshotInfo, e.message || "Failed to load snapshot/classes", "error");
  }
}


async function loadRows(rollClass) {
  if (!rollClass) {
    els.dataTable.style.display = "none";
    els.tbody.innerHTML = "";
    setMsg(els.tableMsg, "Choose a class to view.");
    return;
  }
  try {
    setMsg(els.tableMsg, "Loading…");
    els.dataTable.style.display = "none";
    els.tbody.innerHTML = "";

    const enc = encodeURIComponent(rollClass);
    const rows = await (await authedFetch(`/api/snapshots/latest/classes/${enc}/rows`)).json();

    if (!Array.isArray(rows) || rows.length === 0) {
      setMsg(els.tableMsg, "No rows for this class", "info");
      return;
    }

    // Optional: sort descending by pctAttendance
    rows.sort((a, b) => (b.pctAttendance || 0) - (a.pctAttendance || 0));

    const frag = document.createDocumentFragment();
    for (const r of rows) {
      const tr = document.createElement("tr");
      const tdA = document.createElement("td");
      const tdB = document.createElement("td");
      tdA.textContent = r.externalId ?? "";
      tdB.textContent = (r.pctAttendance ?? "") === "" ? "" : Number(r.pctAttendance).toFixed(1);
      tr.appendChild(tdA);
      tr.appendChild(tdB);
      frag.appendChild(tr);
    }
    els.tbody.appendChild(frag);
    els.dataTable.style.display = "table";
    setMsg(els.tableMsg, `${rows.length} students`, "ok");
  } catch (e) {
    setMsg(els.tableMsg, e.message || "Failed to load rows", "error");
  }
}

// Events
els.classSelect.addEventListener("change", (e) => {
  const val = e.target.value ? decodeURIComponent(e.target.value) : "";
  loadRows(val);
});
els.refreshBtn.addEventListener("click", () => loadSnapshotMetaAndClasses());
