


// ==== CONFIG ====
const BACKEND_BASE_URL = "https://attendance-app-lfwc.onrender.com";
let showWeeks = false;





// ====== UI refs ======
const els = {
  signInBox: document.getElementById("signInBox"),
  whoami: document.getElementById("whoami"),
  signOutBtn: document.getElementById("signOutBtn"),
  signInBtn: document.getElementById("signInBtn"),
  email: document.getElementById("email"),
  password: document.getElementById("password"),
  authMsg: document.getElementById("authMsg"),
  authForm: document.getElementById("authForm"),

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

  toggleWeeks: document.getElementById("toggleWeeks"),
  compactGrid: document.getElementById("compactGrid"),
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
  if (els.toggleWeeks) els.toggleWeeks.checked = false;
    showWeeks = false;

}

function formatUploadedAt(uploadedAt) {
  if (!uploadedAt) return "";
  try {
    if (typeof uploadedAt === "string") return new Date(uploadedAt).toLocaleString();
    if (uploadedAt._seconds) return new Date(uploadedAt._seconds * 1000).toLocaleString();
  } catch {}
  return String(uploadedAt);
}




(async function boot() {
  try {
    // 1) Wait for Firebase to be ready
    const ready = await (window.firebaseReady || Promise.reject(new Error("firebaseReady missing")));
    const auth = ready.auth || window.firebaseAuth; // both for safety

    // 2) Now wire auth listeners
    auth.onAuthStateChanged(async (user) => {
      if (!user) return showSignedOutUI();
      showAuthedUI(user);
      await populateTerms();
    });

    els.signOutBtn.addEventListener("click", () => auth.signOut());

    // 3) Wire sign-in ONLY after auth exists
    if (els.authForm) {
      els.authForm.addEventListener("submit", async (e) => {
        e.preventDefault();
        setMsg(els.authMsg, "Signing in...");
        try {
          const email = els.email.value.trim();
          const password = els.password.value;
          await auth.signInWithEmailAndPassword(email, password);
          setMsg(els.authMsg, "Signed in", "ok");
        } catch (err) {
          console.error("[auth] signIn error:", { code: err?.code, message: err?.message, full: err });
          setMsg(els.authMsg, `${err?.code || ""} ${err?.message || "Sign-in failed"}`, "error");
        }
      });
    } else if (els.signInBtn) {
      els.signInBtn.addEventListener("click", async () => {
        setMsg(els.authMsg, "Signing in...");
        try {
          await auth.signInWithEmailAndPassword(els.email.value.trim(), els.password.value);
          setMsg(els.authMsg, "Signed in", "ok");
        } catch (err) {
          console.error("[auth] signIn error:", { code: err?.code, message: err?.message, full: err });
          setMsg(els.authMsg, `${err?.code || ""} ${err?.message || "Sign-in failed"}`, "error");
        }
      });
    }

    // 4) Non-auth UI events are safe to wire now too
    els.refreshBtn.addEventListener("click", populateTerms);
    els.loadTermBtn.addEventListener("click", loadClassesForSelectedTerm);
    els.classSelect.addEventListener("change", loadRollupForClass);
    if (els.toggleWeeks) {
      els.toggleWeeks.addEventListener("change", () => {
        showWeeks = !!els.toggleWeeks.checked;
        applyWeekVisibility();
      });
    }
  } catch (e) {
    console.error("[boot] init failed:", e);
    setMsg(els.authMsg, "Auth not initialized — check console", "error");
  }
})();









// ====== Networking ======
async function authedFetch(path, init = {}) {
  const ready = await (window.firebaseReady || Promise.reject(new Error("firebaseReady missing")));
  const auth = ready.auth || window.firebaseAuth;
  const user = auth.currentUser;
  if (!user) throw new Error("Not signed in");
  const token = await user.getIdToken();

  const resp = await fetch(`${BACKEND_BASE_URL}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, ...(init.headers || {}) },
  });

  if (!resp.ok) {
    let detail = "";
    try { const j = await resp.json(); detail = j?.error || JSON.stringify(j); }
    catch { try { detail = await resp.text(); } catch {} }
    const err = new Error(`${resp.status} ${resp.statusText}${detail ? ` — ${detail}` : ""}`);
    err.status = resp.status;
    throw err;
  }
  return resp;
}




// ====== Term & class loading ======
async function populateTerms() {
  try {
    setMsg(els.snapshotInfo, "Loading terms…");
    const terms = await (await authedFetch("/api/terms")).json();

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

// --- Trend badge (tiny UI helper) ---
function renderTrendBadge(status) {
  if (!status) return " ¯_(ツ)_/¯";

  const map = {
    diamond: { src: "https://koglint.github.io/attendance-app/assets/trend/diamond.svg", alt: "Diamond (improved)" },
    gold:    { src: "https://koglint.github.io/attendance-app/assets/trend/gold.svg",    alt: "Gold (maintained)" },
    silver:  { src: "https://koglint.github.io/attendance-app/assets/trend/silver.svg",  alt: "Silver (lower)" },
  };
  const m = map[status];
  if (!m) return "?";

  const span = document.createElement("span");
  span.className = `trend-badge trend-${status}`;
  span.setAttribute("role", "img");
  span.setAttribute("aria-label", m.alt);

  const img = document.createElement("img");
  img.alt = m.alt;
  img.loading = "lazy";
  img.decoding = "async";
  img.src = m.src;                    // ← the missing line
  img.onerror = () => { span.textContent = m.alt; };  // graceful fallback

  span.appendChild(img);
  return span;
}






// --- Fetch latest trends for a class (uses endpoint that includes `trend`) ---
async function fetchLatestTrends(rollClass) {
  const encRC = encodeURIComponent(rollClass);
  const resp = await authedFetch(`/api/snapshots/latest/classes/${encRC}/rows`);
  const rows = await resp.json();

  // Expect the server endpoint to include trendMeta; if not present we still work.
  const byId = new Map();
  rows.forEach(r => {
    byId.set(String(r.externalId), {
      trend: r.trend ?? null,
      meta: r.trendMeta ?? null, // { prevWeek, week, ... } if server exposed it
    });
  });

  return byId; // Map<externalId, {trend, meta}>
}



// --- Seeded shuffle (stable order for a given day/class) ---
function xmur3(str) {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return function() {
    h = Math.imul(h ^ (h >>> 16), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    return (h ^= h >>> 16) >>> 0;
  };
}
function mulberry32(a) {
  return function() {
    let t = (a += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function seededShuffleInPlace(a, seedStr) {
  const seed = xmur3(seedStr)();
  const rand = mulberry32(seed);
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function buildMiniTable(rowsSubset, trendMap) {
  const table = document.createElement("table");
  table.className = "mini-table";

  const thead = document.createElement("thead");
  const trh = document.createElement("tr");
  ["ID", "Trend"].forEach(h => {
    const th = document.createElement("th");
    th.textContent = h;
    trh.appendChild(th);
  });
  thead.appendChild(trh);
  table.appendChild(thead);

  const tbody = document.createElement("tbody");
  rowsSubset.forEach(r => {
    const tr = document.createElement("tr");

    const tdId = document.createElement("td");
    tdId.textContent = r.externalId ?? "";

    //const tdAv = document.createElement("td");
    //tdAv.textContent = ""; // reserved for avatars later

    const tdTr = document.createElement("td");
    tdTr.classList.add("trend-cell");   // ← add this line


   const info = trendMap.get(String(r.externalId)) || null;
const t = info?.trend ?? (typeof info === "string" ? info : null); // backward compatible
const badge = renderTrendBadge(t);
if (badge instanceof Element) {
  const meta = info?.meta;
  if (meta && Number.isInteger(meta.prevWeek) && Number.isInteger(meta.week)) {
    badge.title = `Trend from Week ${meta.prevWeek} to Week ${meta.week}`;
    badge.setAttribute("data-trend-range", `W${meta.prevWeek}-W${meta.week}`);
  }
  tdTr.appendChild(badge);
} else {
  tdTr.textContent = badge ?? "—";
}


    tr.appendChild(tdId);
    //tr.appendChild(tdAv);
    tr.appendChild(tdTr);
    tbody.appendChild(tr);
  });

  table.appendChild(tbody);
  return table;
}


// ====== Rollup (table) ======
async function loadRollupForClass() {
  const rollClass = els.classSelect.value ? decodeURIComponent(els.classSelect.value) : "";
  const year = Number(els.yearSelect.value);
  const term = Number(els.termSelect.value);
  if (!rollClass) { return; }

  try {
    setMsg(els.tableMsg, "Loading…");
    // Hide both while repopulating
    els.dataTable.style.display = "none";
    els.compactGrid.style.display = "none";
    els.tbody.innerHTML = "";
    els.thead.innerHTML = "";
    els.compactGrid.innerHTML = "";

    const encRC = encodeURIComponent(rollClass);

    // Fetch rollup (weeks + per-student week values) AND latest trends in parallel
    const [rollupResp, trendMap] = await Promise.all([
      authedFetch(`/api/terms/${year}/${term}/classes/${encRC}/rollup`).then(r => r.json()),
      fetchLatestTrends(rollClass).catch(() => new Map()),  // ← never let it throw
    ]);

    const weeks = Array.isArray(rollupResp.weeks) ? rollupResp.weeks.slice(0, 12) : [];
    const rows  = Array.isArray(rollupResp.rows)  ? rollupResp.rows : [];

    // Determine which weeks are being compared for trend display
let trendFrom = null, trendTo = null;

// Try to get it from any student's trend meta (preferred, exact)
for (const r of rows) {
  const info = trendMap.get(String(r.externalId));
  const meta = info?.meta;
  if (meta && Number.isInteger(meta.prevWeek) && Number.isInteger(meta.week)) {
    trendFrom = meta.prevWeek;
    trendTo   = meta.week;
    break;
  }
}

// Fallback: if no meta, use the last two term weeks available
if (trendFrom == null || trendTo == null) {
  const sortedWeeks = [...weeks].sort((a,b) => a - b);
  if (sortedWeeks.length >= 2) {
    trendFrom = sortedWeeks[sortedWeeks.length - 2];
    trendTo   = sortedWeeks[sortedWeeks.length - 1];
  }
}



    // Stable shuffle per day + class + term so students can't infer identities
    const d = new Date();
    const todayLocal = [
      d.getFullYear(),
      String(d.getMonth() + 1).padStart(2, "0"),
      String(d.getDate()).padStart(2, "0"),
    ].join("-");
    seededShuffleInPlace(rows, `${todayLocal}|${year}|${term}|${rollClass}`);

    // ===== Build WIDE table (with weeks) =====
    {
      // Header: ID | Avatar | Trend | W1..WN
      const trh = document.createElement("tr");
      ["ID", "Trend", ...weeks.map(w => `W${w}`)].forEach((h, idx) => {
        const th = document.createElement("th");
        th.textContent = h;
        if (idx >= 2) th.classList.add("weekcol");
        trh.appendChild(th);
      });
      els.thead.appendChild(trh);

      const frag = document.createDocumentFragment();
      for (const r of rows) {
        const tr = document.createElement("tr");
        const tdId = document.createElement("td");
        //const tdAv = document.createElement("td");
        const tdTr = document.createElement("td");
        tdTr.classList.add("trend-cell");   // ← add this line


        tdId.textContent = r.externalId ?? "";
        //tdAv.textContent = ""; // avatar later
                
        const info = trendMap.get(String(r.externalId)) || null;
        const t = info?.trend ?? (typeof info === "string" ? info : null); // backward compatible
        const badge = renderTrendBadge(t);

        if (badge instanceof Element) {
          const meta = info?.meta;
          const fromW = (meta && Number.isInteger(meta.prevWeek)) ? meta.prevWeek : trendFrom;
          const toW   = (meta && Number.isInteger(meta.week))     ? meta.week     : trendTo;
          if (fromW != null && toW != null) {
            badge.title = `Trend from Week ${fromW} to Week ${toW}`;
            badge.setAttribute("data-trend-range", `W${fromW}-W${toW}`);
          }
          tdTr.appendChild(badge);
        } else {
          tdTr.textContent = badge;
        }


        tr.appendChild(tdId);
       // tr.appendChild(tdAv);
        tr.appendChild(tdTr);

        for (const v of r.weekValues || []) {
          const td = document.createElement("td");
          td.classList.add("weekcol");
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
    }

    // ===== Build COMPACT view (ID | Avatar | Trend only) =====
    {
      // Split rows roughly in half for two columns
      const oneThird = Math.ceil(rows.length / 3 * 1);
      const twoThirds = Math.ceil(rows.length / 3 * 2);
      const left = rows.slice(0, oneThird);
      const middle = rows.slice(oneThird, twoThirds);
      const right = rows.slice(twoThirds);

      const leftTable = buildMiniTable(left, trendMap);
      const middleTable = buildMiniTable(middle, trendMap);
      const rightTable = buildMiniTable(right, trendMap);

      els.compactGrid.appendChild(leftTable);
      els.compactGrid.appendChild(middleTable);
      els.compactGrid.appendChild(rightTable);
    }

    // Now toggle which layout is visible
    applyWeekVisibility();

    const trendText = (trendFrom != null && trendTo != null)
  ? `Trend: Week ${trendFrom} → Week ${trendTo}`
  : `Trend: (weeks unavailable)`;

setMsg(
  els.tableMsg,
  `${rows.length} students • Weeks: ${weeks.join(", ") || "—"} • ${trendText}`,
  "ok"
);

  } catch (e) {
    setMsg(els.tableMsg, e.message || "Failed to load rollup", "error");
  }
}



function applyWeekVisibility() {
  if (!els.dataTable || !els.compactGrid) return;

  // Toggle the week columns class on the wide table (still useful for accessibility)
  if (showWeeks) {
    els.dataTable.classList.remove("hide-weeks");
  } else {
    els.dataTable.classList.add("hide-weeks");
  }

  // Show only one layout at a time
  if (showWeeks) {
    els.compactGrid.style.display = "none";
    els.dataTable.style.display = "table";
  } else {
    els.dataTable.style.display = "none";
    els.compactGrid.style.display = "grid";
  }

  if (els.toggleWeeks) els.toggleWeeks.checked = showWeeks;
}






