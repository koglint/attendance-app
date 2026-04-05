const BACKEND_BASE_URL = window.BACKEND_BASE_URL || "https://attendance-app-lfwc.onrender.com";

const els = {
  yearSelect: document.getElementById("yearSelect"),
  termSelect: document.getElementById("termSelect"),
  weekSelect: document.getElementById("weekSelect"),
  rollClass: document.getElementById("rollClass"),
  loadButton: document.getElementById("loadButton"),
  spinButton: document.getElementById("spinButton"),
  wheelCanvas: document.getElementById("wheelCanvas"),
  winnerDisplay: document.getElementById("winnerDisplay"),
  boardInfo: document.getElementById("boardInfo"),
  weightInfo: document.getElementById("weightInfo"),
  studentCount: document.getElementById("studentCount"),
  studentList: document.getElementById("studentList"),
};

const ctx = els.wheelCanvas.getContext("2d");

const tierWeights = {
  goat: 10,
  sad1: 6,
  sad2: 3,
  sad3: 1,
  sad4: 0.5,
};

const tierLabels = {
  goat: "Golden Goat",
  sad1: "3 of 4",
  sad2: "2 of 4",
  sad3: "1 of 4",
  sad4: "0 of 4",
};

let availableTerms = [];
let students = [];
let spinning = false;

async function authedFetch(path, init = {}) {
  const ready = await (window.firebaseReady || Promise.reject(new Error("firebaseReady missing")));
  const auth = ready.auth || window.firebaseAuth;
  const user = auth.currentUser;
  if (!user) throw new Error("Not signed in");
  const token = await user.getIdToken();
  const resp = await fetch(`${BACKEND_BASE_URL}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(init.headers || {}),
    },
  });
  if (!resp.ok) throw new Error(await resp.text());
  return resp;
}

function setWinner(title, subtitle = "") {
  els.winnerDisplay.innerHTML = `<strong>${title}</strong><span>${subtitle}</span>`;
}

function weightedRandomIndex(weights) {
  const total = weights.reduce((a, b) => a + b, 0);
  const r = Math.random() * total;
  let acc = 0;
  for (let i = 0; i < weights.length; i++) {
    acc += weights[i];
    if (r < acc) return i;
  }
  return Math.max(0, weights.length - 1);
}

function renderWeekOptions(preferredWeek = "") {
  const year = Number(els.yearSelect.value);
  const term = Number(els.termSelect.value);
  const entry = availableTerms.find((item) => item.year === year && item.term === term);
  const weeks = Array.isArray(entry?.weeks) ? entry.weeks : [];
  els.weekSelect.replaceChildren();
  const latest = document.createElement("option");
  latest.value = "";
  latest.textContent = "Latest available";
  els.weekSelect.appendChild(latest);
  for (const week of weeks) {
    const opt = document.createElement("option");
    opt.value = String(week);
    opt.textContent = `Week ${week}`;
    els.weekSelect.appendChild(opt);
  }
  els.weekSelect.value = weeks.includes(Number(preferredWeek)) ? String(preferredWeek) : "";
}

function renderStudentList(rows) {
  els.studentList.replaceChildren();
  if (!rows.length) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = "No students available for this class and week yet.";
    els.studentList.appendChild(empty);
    els.studentCount.textContent = "0 students";
    return;
  }

  const frag = document.createDocumentFragment();
  rows.forEach((student) => {
    const card = document.createElement("div");
    card.className = "student-card";

    const name = document.createElement("div");
    name.className = "student-name";
    name.textContent = student.name;

    const pill = document.createElement("div");
    pill.className = `status-pill status-${student.trend || "none"}`;
    pill.textContent = tierLabels[student.trend] || "No status";

    card.appendChild(name);
    card.appendChild(pill);
    frag.appendChild(card);
  });

  els.studentList.appendChild(frag);
  els.studentCount.textContent = `${rows.length} student${rows.length === 1 ? "" : "s"}`;
}

function drawWheel(items, rotation = 0) {
  const { width, height } = els.wheelCanvas;
  const radius = Math.min(width, height) / 2;
  ctx.clearRect(0, 0, width, height);

  if (!items.length) {
    ctx.fillStyle = "#d8dee9";
    ctx.beginPath();
    ctx.arc(width / 2, height / 2, radius - 10, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#173451";
    ctx.font = "bold 28px Segoe UI";
    ctx.textAlign = "center";
    ctx.fillText("Load a class", width / 2, height / 2);
    return;
  }

  ctx.save();
  ctx.translate(width / 2, height / 2);
  ctx.rotate(rotation);
  ctx.translate(-width / 2, -height / 2);

  const angleStep = (Math.PI * 2) / items.length;
  for (let i = 0; i < items.length; i++) {
    const start = i * angleStep;
    const end = start + angleStep;

    ctx.beginPath();
    ctx.moveTo(width / 2, height / 2);
    ctx.arc(width / 2, height / 2, radius - 10, start, end);
    ctx.closePath();
    ctx.fillStyle = `hsl(${(i * 360) / items.length}, 78%, 66%)`;
    ctx.fill();

    ctx.save();
    ctx.translate(width / 2, height / 2);
    ctx.rotate(start + angleStep / 2);
    ctx.textAlign = "right";
    ctx.fillStyle = "#16324f";
    ctx.font = `${Math.max(12, Math.min(18, 240 / items.length))}px Segoe UI`;
    ctx.fillText(items[i].name.slice(0, 18), radius - 24, 5);
    ctx.restore();
  }

  ctx.restore();

  ctx.fillStyle = "#d62828";
  ctx.beginPath();
  ctx.moveTo(width / 2, 14);
  ctx.lineTo(width / 2 - 18, 50);
  ctx.lineTo(width / 2 + 18, 50);
  ctx.closePath();
  ctx.fill();
}

function buildTrendFromWeekArrays(row, weeks, selectedWeek) {
  const index = weeks.indexOf(selectedWeek);
  const effectiveIndex = index >= 0 ? index : weeks.length - 1;
  return {
    trend: Array.isArray(row.weekTrends) ? (row.weekTrends[effectiveIndex] ?? null) : null,
    meta: Array.isArray(row.weekTrendMeta) ? (row.weekTrendMeta[effectiveIndex] ?? null) : null,
  };
}

async function populateTerms() {
  const resp = await authedFetch("/api/terms");
  const terms = await resp.json();
  availableTerms = Array.isArray(terms) ? terms : [];
  if (!availableTerms.length) throw new Error("No term data available yet.");

  const years = Array.from(new Set(availableTerms.map((item) => item.year))).sort((a, b) => b - a);
  els.yearSelect.replaceChildren();
  for (const year of years) {
    const opt = document.createElement("option");
    opt.value = String(year);
    opt.textContent = String(year);
    els.yearSelect.appendChild(opt);
  }
  els.yearSelect.value = String(availableTerms[0].year);
  els.termSelect.value = String(availableTerms[0].term);
  renderWeekOptions();
}

async function loadClasses() {
  const year = Number(els.yearSelect.value);
  const term = Number(els.termSelect.value);
  const resp = await authedFetch(`/api/terms/${year}/${term}/classes`);
  const classes = await resp.json();
  els.rollClass.replaceChildren();
  for (const item of classes) {
    const opt = document.createElement("option");
    opt.value = item.rollClass;
    opt.textContent = item.rollClass;
    els.rollClass.appendChild(opt);
  }
}

async function loadBoard() {
  const year = Number(els.yearSelect.value);
  const term = Number(els.termSelect.value);
  const rollClass = els.rollClass.value;
  if (!rollClass) return;

  const encRC = encodeURIComponent(rollClass);
  const rollupResp = await authedFetch(`/api/terms/${year}/${term}/classes/${encRC}/rollup`);
  const rollup = await rollupResp.json();
  const weeks = Array.isArray(rollup.weeks) ? rollup.weeks : [];
  const selectedWeek = Number(els.weekSelect.value) || (weeks[weeks.length - 1] ?? null);

  students = (Array.isArray(rollup.rows) ? rollup.rows : []).map((row) => {
    const info = buildTrendFromWeekArrays(row, weeks, selectedWeek);
    return {
      id: String(row.externalId),
      name: (typeof row.alias === "string" && row.alias.trim()) ? row.alias.trim() : String(row.externalId),
      trend: info.trend || "sad4",
      meta: info.meta || null,
    };
  }).sort((a, b) => a.name.localeCompare(b.name));

  renderStudentList(students);
  drawWheel(students);
  els.boardInfo.textContent = `${year} Term ${term}${selectedWeek ? ` • Week ${selectedWeek}` : ""} • ${rollClass}`;
  setWinner("Ready to spin", "Everyone on the board is visible below.");
}

function spinWheel() {
  if (spinning || !students.length) return;
  spinning = true;

  const weights = students.map((student) => tierWeights[student.trend] || 1);
  const winnerIndex = weightedRandomIndex(weights);
  const winner = students[winnerIndex];
  const spins = 5;
  const segment = (Math.PI * 2) / students.length;
  const targetAngle = (Math.PI * 3 / 2) - (segment * winnerIndex);
  const totalRotation = (Math.PI * 2 * spins) + targetAngle;
  const duration = 3200;
  const start = performance.now();

  function animate(now) {
    const progress = Math.min((now - start) / duration, 1);
    const eased = 1 - Math.pow(1 - progress, 3);
    drawWheel(students, eased * totalRotation);

    if (progress < 1) {
      requestAnimationFrame(animate);
      return;
    }

    setWinner(`Winner: ${winner.name}`, `${tierLabels[winner.trend] || "No status"} weighting applied`);
    spinning = false;
  }

  requestAnimationFrame(animate);
}

(async function init() {
  try {
    const ready = await (window.firebaseReady || Promise.reject(new Error("firebaseReady missing")));
    const auth = ready.auth || window.firebaseAuth;

    auth.onAuthStateChanged(async (user) => {
      if (!user) return;
      await populateTerms();
      await loadClasses();
      await loadBoard();
    });

    els.yearSelect.addEventListener("change", async () => {
      renderWeekOptions();
      await loadClasses();
      await loadBoard();
    });

    els.termSelect.addEventListener("change", async () => {
      renderWeekOptions();
      await loadClasses();
      await loadBoard();
    });

    els.weekSelect.addEventListener("change", loadBoard);
    els.rollClass.addEventListener("change", loadBoard);
    els.loadButton.addEventListener("click", loadBoard);
    els.spinButton.addEventListener("click", spinWheel);

    drawWheel([]);
  } catch (err) {
    console.error("Rewards board init error:", err);
    setWinner("Could not load board", err.message || "Unknown error");
  }
})();
