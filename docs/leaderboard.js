// Wait for Firebase init (same pattern as teacher.js)
await (window.firebaseReady || Promise.resolve());

// ===== UI refs =====
const els = {
  whoami: document.getElementById("whoami"),
  yearSelect: document.getElementById("yearSelect"),
  termSelect: document.getElementById("termSelect"),
  loadBtn: document.getElementById("loadBtn"),
  status: document.getElementById("status"),
  board: document.getElementById("board"),
};

// ===== Helpers =====
function option(el, value, label = value) {
  const o = document.createElement("option");
  o.value = value; o.textContent = label; el.appendChild(o);
}
function fmt(n, d = 3) { return Number(n ?? 0).toFixed(d); }
function absUrl(rel) { return new URL(rel, document.baseURI).href; }

async function getUserAndToken() {
  await (window.firebaseReady || Promise.resolve());
  const auth = window.firebaseAuth || firebase.auth();

  // Wait for user if needed
  const user = auth.currentUser || await new Promise(resolve => {
    const unsub = auth.onAuthStateChanged(u => { unsub(); resolve(u); });
  });
  if (!user) return { user: null, token: null };

  // IMPORTANT: don't force-refresh (that’s what triggers the 403 on localhost)
  try {
    const token = await user.getIdToken();
    return { user, token };
  } catch (err) {
    console.warn("getIdToken blocked (API key / authorized domains):", err);
    return { user, token: null };
  }
}


async function apiGet(pathAndQuery, token) {
  const url = new URL(pathAndQuery, window.BACKEND_BASE_URL);
  const res = await fetch(url.toString(), {
    method: "GET",
    headers: {
      "Authorization": `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    // credentials not strictly needed (auth via header), but harmless:
    credentials: "include",
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

function currentYear() {
  const now = new Date();
  return now.getFullYear();
}

function badgeCell(counts) {
  const wrap = document.createElement("div");
  wrap.style.display = "flex";
  wrap.style.flexWrap = "wrap";
  wrap.style.alignItems = "center";

  const items = [
    ["goat",   "assets/trend/goldenGoat.svg"],
    ["diamond","assets/trend/diamond.svg"],
    ["gold",   "assets/trend/gold.svg"],
    ["silver", "assets/trend/silver.svg"],
  ];
  for (const [k, src] of items) {
    const span = document.createElement("span");
    span.className = "badge";
    const img = document.createElement("img");
    img.src = absUrl(src);
    img.alt = k;
    const txt = document.createElement("span");
    txt.textContent = String(counts?.[k] ?? 0);
    span.append(img, txt);
    wrap.appendChild(span);
  }
  return wrap;
}

function renderLeaderboard(weeks, list) {
  const tbody = els.board.querySelector("tbody");
  tbody.innerHTML = "";

  list.forEach((row, idx) => {
    const tr = document.createElement("tr");

    const tdRank = document.createElement("td");
    tdRank.textContent = String(idx + 1);

    const tdRoll = document.createElement("td");
    tdRoll.textContent = row.rollId;

    const tdNorm = document.createElement("td");
    tdNorm.className = "right";
    tdNorm.textContent = (Number(row.normPoints * 1000 ?? 0)).toFixed(0);

    // Add four separate columns for each badge count
    const tdGoat = document.createElement("td");
    tdGoat.textContent = row.counts?.goat ?? 0;

    const tdDiamond = document.createElement("td");
    tdDiamond.textContent = row.counts?.diamond ?? 0;

    const tdGold = document.createElement("td");
    tdGold.textContent = row.counts?.gold ?? 0;

    const tdSilver = document.createElement("td");
    tdSilver.textContent = row.counts?.silver ?? 0;

    tr.append(tdRank, tdRoll, tdNorm, tdGoat, tdDiamond, tdGold, tdSilver);
    tbody.appendChild(tr);
  });
}


async function loadDefaults(token) {
  // Try to seed year/term from latest snapshot meta (auth required)
  try {
    const meta = await apiGet("/api/snapshots/latest/meta", token);
    if (meta?.year) els.yearSelect.value = String(meta.year);
    if (meta?.term) els.termSelect.value = String(meta.term);
  } catch {
    // fallback: current year, term guess by month (not perfect but fine)
    const y = currentYear();
    els.yearSelect.value = String(y);
    // keep whatever term <select> already has
  }
}

async function init() {
  els.status.textContent = "Checking sign-in…";
  const { user, token } = await getUserAndToken();

if (!user) {
  els.status.textContent = "Not signed in. Open Teacher page and sign in.";
  return;
}
if (!token) {
  els.status.textContent =
    "Auth token blocked by Firebase config. Add localhost to Firebase Auth > Authorized domains, and allow your Web API key for http://localhost in Google Cloud Console.";
  return;
}

  els.whoami.textContent = `Signed in as ${user.email || user.uid}`;
  els.status.textContent = "";

  // Populate year select: previous, current, next
  const y = currentYear();
  [y - 1, y, y + 1].forEach(val => option(els.yearSelect, val, val));

  // Load defaults from server meta
  await loadDefaults(token);

  // Wire button
  els.loadBtn.addEventListener("click", async () => {
    els.status.textContent = "Loading…";
    try {
      const year = Number(els.yearSelect.value);
      const term = Number(els.termSelect.value);
      const data = await apiGet(`/api/leaderboard?year=${year}&term=${term}`, token);
      const weeks = data.weeks || [];
      const list = (data.leaderboard || []).slice(); // already sorted by server
      renderLeaderboard(weeks, list);
      els.status.textContent = `Updated ${new Date().toLocaleString()}`;
    } catch (e) {
      console.error(e);
      els.status.textContent = "Failed to load leaderboard.";
    }
  });

  // Auto-load
  els.loadBtn.click();
}

init().catch(err => {
  console.error(err);
  els.status.textContent = "Initialisation failed.";
});
