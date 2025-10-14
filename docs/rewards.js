// rewards.js

const BACKEND_BASE_URL = "https://attendance-app-lfwc.onrender.com";
const SCHOOL_ID = "warilla-hs"; // ← this is the doc id shown in your screenshot


const els = {
  rollClass: document.getElementById("rollClass"),
  spinButton: document.getElementById("spinButton"),
  wheelCanvas: document.getElementById("wheelCanvas"),
  winnerDisplay: document.getElementById("winnerDisplay"),
};

let students = [];
let tierMap = new Map();
let ctx = els.wheelCanvas.getContext("2d");
let spinning = false;

const tierWeights = {
  goat: 4,
  diamond: 3,
  gold: 2,
  silver: 1,
};

function weightedRandomIndex(weights) {
  const total = weights.reduce((a, b) => a + b, 0);
  const r = Math.random() * total;
  let acc = 0;
  for (let i = 0; i < weights.length; i++) {
    acc += weights[i];
    if (r < acc) return i;
  }
  return weights.length - 1;
}

function drawWheel(students) {
  const radius = els.wheelCanvas.width / 2;
  const angleStep = (2 * Math.PI) / students.length;
  ctx.clearRect(0, 0, els.wheelCanvas.width, els.wheelCanvas.height);
  students.forEach((student, i) => {
    const angle = i * angleStep;
    ctx.beginPath();
    ctx.moveTo(radius, radius);
    ctx.arc(radius, radius, radius, angle, angle + angleStep);
    ctx.fillStyle = `hsl(${(i * 360) / students.length}, 80%, 60%)`;
    ctx.fill();
    ctx.save();
    ctx.translate(radius, radius);
    ctx.rotate(angle + angleStep / 2);
    ctx.textAlign = "right";
    ctx.fillStyle = "black";
    ctx.font = "16px sans-serif";
    ctx.fillText(student.name, radius - 10, 5);
    ctx.restore();
  });
}

async function authedFetch(path, init = {}) {
  const ready = await (window.firebaseReady || Promise.reject("firebaseReady missing"));
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

async function loadRollClasses() {
  try {
    const termsResp = await authedFetch("/api/terms");
    const terms = await termsResp.json();
    const latest = terms[0];
    const classesResp = await authedFetch(`/api/terms/${latest.year}/${latest.term}/classes`);
    const classes = await classesResp.json();

    els.rollClass.replaceChildren();
    for (const c of classes) {
      const opt = document.createElement("option");
      opt.value = c.rollClass;
      opt.textContent = c.rollClass;
      els.rollClass.appendChild(opt);
    }
  } catch (err) {
    console.error("Failed to load roll classes:", err);
  }
}

async function loadStudents(rollClass) {
  const encRC = encodeURIComponent(rollClass);
  const resp = await authedFetch(`/api/snapshots/latest/classes/${encRC}/rows`);
  const rows = await resp.json();

const db = firebase.firestore();
students = await Promise.all(rows.map(async (r) => {
  const docId = String(r.externalId).replace(/\//g, "_");
  const snap = await db
    .collection("schools")
    .doc(SCHOOL_ID)
    .collection("roster")
    .doc(docId)
    .get();

    let name = String(r.externalId); // fallback
    if (snap.exists) {
      const d = snap.data() || {};
      const first = d.givenNames ? d.givenNames.trim().split(" ")[0] : ""; // first name only
      const lastInitial = d.surname ? d.surname.trim().charAt(0).toUpperCase() + "." : "";
      if (first) name = `${first} ${lastInitial}`.trim();
    }


  return { id: r.externalId, name };
}));


  tierMap = new Map(rows.map(r => [r.externalId, r.trend ?? "silver"]));
  drawWheel(students);
}

function spinWheel() {
  if (spinning || students.length === 0) return;
  spinning = true;

  const weights = students.map(s => tierWeights[tierMap.get(s.id)] || 1);
  const winnerIndex = weightedRandomIndex(weights);
  const winner = students[winnerIndex];


  let angle = 0;
  const spins = 5;
  const segment = (2 * Math.PI) / students.length;
  const targetAngle = (Math.PI * 3 / 2) - (segment * winnerIndex);
  const totalRotation = (Math.PI * 2 * spins) + targetAngle;

  const duration = 3000;
  const start = performance.now();

  function animate(t) {
    const elapsed = t - start;
    const progress = Math.min(elapsed / duration, 1);
    const eased = 1 - Math.pow(1 - progress, 3);
    angle = eased * totalRotation;

    ctx.save();
    ctx.clearRect(0, 0, els.wheelCanvas.width, els.wheelCanvas.height);
    ctx.translate(els.wheelCanvas.width / 2, els.wheelCanvas.height / 2);
    ctx.rotate(angle);
    ctx.translate(-els.wheelCanvas.width / 2, -els.wheelCanvas.height / 2);
    drawWheel(students);
    ctx.restore();

    if (progress < 1) requestAnimationFrame(animate);
    else {
      els.winnerDisplay.textContent = `🎉 Winner: ${winner.name} 🎉`;
      spinning = false;
    }
  }

  requestAnimationFrame(animate);
}

(async function init() {
  try {
    const ready = await (window.firebaseReady || Promise.reject("firebaseReady missing"));
    const auth = ready.auth || window.firebaseAuth;

    auth.onAuthStateChanged(async user => {
      if (!user) return;
      await loadRollClasses();
      if (els.rollClass.options.length > 0) {
        await loadStudents(els.rollClass.value);
      }
    });

    els.rollClass.addEventListener("change", async () => {
      if (els.rollClass.value) await loadStudents(els.rollClass.value);
    });

    els.spinButton.addEventListener("click", spinWheel);

  } catch (err) {
    console.error("Init error:", err);
  }
})();
