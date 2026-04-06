await (window.firebaseReady || Promise.resolve());

const els = {
  whoami: document.getElementById("whoami"),
  yearSelect: document.getElementById("yearSelect"),
  termSelect: document.getElementById("termSelect"),
  status: document.getElementById("status"),
  board: document.getElementById("board"),
};

function option(el, value, label = value) {
  const o = document.createElement("option");
  o.value = value;
  o.textContent = label;
  el.appendChild(o);
}

async function getUserAndToken() {
  await (window.firebaseReady || Promise.resolve());
  const auth = window.firebaseAuth || firebase.auth();
  const user = auth.currentUser || await new Promise((resolve) => {
    const unsub = auth.onAuthStateChanged((u) => {
      unsub();
      resolve(u);
    });
  });
  if (!user) return { user: null, token: null };

  try {
    const token = await user.getIdToken();
    return { user, token };
  } catch (err) {
    console.warn("getIdToken blocked:", err);
    return { user, token: null };
  }
}

async function apiGet(pathAndQuery, token) {
  const url = new URL(pathAndQuery, window.BACKEND_BASE_URL);
  const res = await fetch(url.toString(), {
    method: "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    credentials: "include",
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

function currentYear() {
  return new Date().getFullYear();
}

function renderLeaderboard(list) {
  const tbody = els.board.querySelector("tbody");
  tbody.innerHTML = "";

  if (!list.length) {
    els.status.textContent = "No leaderboard data available for that term yet.";
    return;
  }

  list.forEach((row, idx) => {
    const tr = document.createElement("tr");
    if (idx === 0) tr.classList.add("top-glow");

    const tdRank = document.createElement("td");
    tdRank.textContent = String(idx + 1);

    const tdRoll = document.createElement("td");
    tdRoll.textContent = row.rollId || row.rollClass || "";

    const tdNorm = document.createElement("td");
    tdNorm.className = "right";
    tdNorm.textContent = Number(row.normPoints ?? 0).toFixed(2);

    const tdGoat = document.createElement("td");
    tdGoat.textContent = row.counts?.goat ?? 0;

    const tdSad1 = document.createElement("td");
    tdSad1.textContent = row.counts?.sad1 ?? 0;

    const tdSad2 = document.createElement("td");
    tdSad2.textContent = row.counts?.sad2 ?? 0;

    const tdSad3 = document.createElement("td");
    tdSad3.textContent = row.counts?.sad3 ?? 0;

    const tdSad4 = document.createElement("td");
    tdSad4.textContent = row.counts?.sad4 ?? 0;

    tr.append(tdRank, tdRoll, tdNorm, tdGoat, tdSad1, tdSad2, tdSad3, tdSad4);
    tbody.appendChild(tr);
  });
}

async function loadDefaults(token) {
  try {
    const meta = await apiGet("/api/snapshots/latest/meta", token);
    if (meta?.year) els.yearSelect.value = String(meta.year);
    if (meta?.term) els.termSelect.value = String(meta.term);
  } catch {
    els.yearSelect.value = String(currentYear());
  }
}

async function loadLeaderboard(token) {
  els.status.textContent = "Loading...";
  try {
    const year = Number(els.yearSelect.value);
    const term = Number(els.termSelect.value);
    const data = await apiGet(`/api/leaderboard?year=${year}&term=${term}`, token);
    const list = Array.isArray(data.leaderboard) ? data.leaderboard.slice() : [];
    renderLeaderboard(list);
    if (list.length) {
      els.status.textContent = `Updated ${new Date().toLocaleString()}`;
    }
  } catch (e) {
    console.error(e);
    els.status.textContent = "Failed to load leaderboard.";
  }
}

async function init() {
  els.status.textContent = "Checking sign-in...";
  const { user, token } = await getUserAndToken();

  if (!user) {
    els.status.textContent = "Not signed in. Open Attendance Data and sign in.";
    return;
  }
  if (!token) {
    els.status.textContent = "Could not get an auth token for the leaderboard.";
    return;
  }

  if (els.whoami) els.whoami.textContent = `Signed in as ${user.email || user.uid}`;
  els.status.textContent = "";

  const y = currentYear();
  [y - 1, y, y + 1].forEach((val) => option(els.yearSelect, val, val));

  await loadDefaults(token);

  els.yearSelect.addEventListener("change", () => loadLeaderboard(token));
  els.termSelect.addEventListener("change", () => loadLeaderboard(token));

  await loadLeaderboard(token);
}

init().catch((err) => {
  console.error(err);
  if (els.status) els.status.textContent = "Initialisation failed.";
});
