// ==== CONFIG ====
const BACKEND_BASE_URL = "https://attendance-app-lfwc.onrender.com"; // your Render URL
const DEBUG = false;

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

  yearSelect: document.getElementById("yearSelect"),
  termSelect: document.getElementById("termSelect"),
  classSelect: document.getElementById("classSelect"),
  loadTermBtn: document.getElementById("loadTermBtn"),
  refreshBtn: document.getElementById("refreshBtn"),

  tableMsg: document.getElementById("tableMsg"),
  dataTable: document.getElementById("dataTable"),
  thead: document.querySelector("#dataTable thead"),
  tbody: document.querySelector("#dataTable tbody"),
};

function setMsg(el, text, kind="info") {
  el.textContent = text || "";
  el.className = kind === "error" ? "err" : kind === "ok" ? "ok" : "muted";
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
  setMsg(els.snapshotInfo, "Pick a year & term, then Load.");
  setMsg(els.tableMsg, "Choose a class to view.");
  els.classSelect.innerHTML = `<option value="">(select a class)</option>`;
  els.dataTable.style.display = "none";
  els.thead.innerHTML = "";
  els.tbody.innerHTML = "";
}

function formatUploadedAt(uploadedAt) {
  if (!uploadedAt) return "";
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
  await populateTerms(); // fill year/term from server
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

// ====== Networking ======
async function authedFetch(path) {
  const user = firebaseAuth.currentUser;
  if (!user) throw new Error("Not signed in");
  const token = await user.getIdToken();
  const url = `${BACKEND_BASE_URL}${path}`;
  const resp = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (DEBUG) console.log("[fetch]", path, "→", resp.status);
  if (resp.status === 401) throw new Error("Not authorised (401)");
  return resp;
}

// ====== Term & class loading ======
async function populateTerms() {
  try {
    setMsg(els.snapshotInfo, "Loading terms…");
    const terms = await (await authedFetch("/api/terms")).json();
    if (DEBUG) console.log("[terms]", terms);

    if (!Array.isArray(terms) || terms.length === 0) {
      setMsg(els.snapshotInfo, "No term data yet — ask admin to upload CSVs", "error");
      return;
    }

    // Build Year options based on returned terms
    const years = Array.from(new Set(terms.map(t => t.year))).sort((a,b) => b - a);
    els.yearSelect.innerHTML = years.map(y => `<option value="${y}">${y}</option>`).join("");

    // Choose latest term by default (first item is newest due to sort)
    els.yearSelect.value = String(terms[0].year);
    els.termSelect.value = String(terms[0].term);

    // Show a quick “weeks present” note
    const weeks = terms.find(t => t.year === terms[0].year && t.term === terms[0].term)?.weeks || [];
    setMsg(els.snapshotInfo, `${terms[0].year} Term ${terms[0].term} • Weeks: ${weeks.join(", ")}`);
    await loadClassesForSelectedTerm();
  } catch (e) {
    setMsg(els.snapshotInfo, e.message || "Failed to load terms", "error");
  }
}

async function loadClassesForSelectedTerm() {
  const year = Number(els.yearSelect.value);
  const term = Number(els.termSelect.value);
  if (!Number.isInteger(year) || ![1,2,3,4].includes(term)) {
    setMsg(els.snapshotInfo, "Pick a valid year and term", "error");
    return;
  }
  try {
    setMsg(els.snapshotInfo, `Loading classes for ${year} Term ${term}…`);
    const classes = await (await authedFetch(`/api/terms/${year}/${term}/classes`)).json();
    if (DEBUG) console.log("[classes]", classes);

    if (!Array.isArray(classes) || classes.length === 0) {
      els.classSelect.innerHTML = `<option value="">(no classes)</option>`;
      setMsg(els.snapshotInfo, `No classes found for ${year} Term ${term}`);
      return;
    }
    els.classSelect.innerHTML = `<option value="">(select a class)</option>` +
      classes.map(c => `<option value="${encodeURIComponent(c.rollClass)}">${c.rollClass}</option>`).join("");

    // Clear the table until a class is chosen for this term
    els.thead.innerHTML = "";
    els.tbody.innerHTML = "";
    els.dataTable.style.display = "none";
    setMsg(els.tableMsg, "Choose a class to view.");
  

    setMsg(els.snapshotInfo, `${year} Term ${term} • ${classes.length} classes`);
  } catch (e) {
    setMsg(els.snapshotInfo, e.message || "Failed to load classes", "error");
  }
}

// ====== Rollup (table) ======
async function loadRollupForClass() {
  const rollClass = els.classSelect.value ? decodeURIComponent(els.classSelect.value) : "";
  const year = Number(els.yearSelect.value);
  const term = Number(els.termSelect.value);
  if (!rollClass) {
    els.dataTable.style.display = "none";
    els.tbody.innerHTML = "";
    els.thead.innerHTML = "";
    setMsg(els.tableMsg, "Choose a class to view.");
    return;
  }

  try {
    setMsg(els.tableMsg, "Loading…");
    els.dataTable.style.display = "none";
    els.tbody.innerHTML = "";
    els.thead.innerHTML = "";

    const encRC = encodeURIComponent(rollClass);
    const data = await (await authedFetch(`/api/terms/${year}/${term}/classes/${encRC}/rollup`)).json();
    if (DEBUG) console.log("[rollup]", data);

    const weeks = Array.isArray(data.weeks) ? data.weeks.slice(0, 12) : [];
    const rows = Array.isArray(data.rows) ? data.rows : [];

    // Build header: ID | Avatar | Trend | W1..WN
    const trh = document.createElement("tr");
    ["ID", "Avatar", "Trend", ...weeks.map(w => `W${w}`)].forEach(h => {
      const th = document.createElement("th");
      th.textContent = h;
      trh.appendChild(th);
    });
    els.thead.appendChild(trh);

    // Rows
    const frag = document.createDocumentFragment();
    for (const r of rows) {
      const tr = document.createElement("tr");
      const tdId = document.createElement("td");
      const tdAv = document.createElement("td");
      const tdTr = document.createElement("td");

      tdId.textContent = r.externalId ?? "";
      tdAv.textContent = ""; // placeholder for future avatar
      tdTr.textContent = ""; // placeholder for future trend

      tr.appendChild(tdId);
      tr.appendChild(tdAv);
      tr.appendChild(tdTr);

      for (const v of r.weekValues || []) {
        const td = document.createElement("td");
        if (v === null || v === undefined || v === "") {
          td.textContent = "";
        } else {
          const n = Number(v);
          td.textContent = Number.isFinite(n) ? n.toFixed(1) : "";
        }
        tr.appendChild(td);
      }

      frag.appendChild(tr);
    }
    els.tbody.appendChild(frag);

    els.dataTable.style.display = "table";
    setMsg(els.tableMsg, `${rows.length} students • Weeks shown: ${weeks.join(", ")}`, "ok");
  } catch (e) {
    setMsg(els.tableMsg, e.message || "Failed to load rollup", "error");
  }
}

// ====== Events ======
els.refreshBtn.addEventListener("click", async () => {
  await populateTerms();
});

els.loadTermBtn.addEventListener("click", async () => {
  await loadClassesForSelectedTerm();
});

els.classSelect.addEventListener("change", () => {
  loadRollupForClass();
});
