// rewards.js

const BACKEND_BASE_URL = (window.BACKEND_BASE_URL || "https://attendance-app-lfwc.onrender.com");
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
  goat: 10,
  diamond: 10,
  gold: 3,
  silver: 0.5,
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

    // take first 3 characters of surname (or fewer if shorter), Title-case it
    let surnameFragment = "";
    if (d.surname) {
      const s = d.surname.trim().slice(0,2);
      surnameFragment = s.charAt(0).toUpperCase() + s.slice(1).toLowerCase() + '.';
    }

    if (first && surnameFragment) name = `${first} ${surnameFragment}`.trim();
    else if (first) name = first;
    else if (surnameFragment) name = surnameFragment;
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

async function testFairness(n = 10000) {
  if (!students || students.length === 0) {
    console.warn("⚠️ No students loaded yet. Load a roll class first.");
    return;
  }

  const counts = new Map();
  for (let i = 0; i < n; i++) {
    const weights = students.map(s => tierWeights[tierMap.get(s.id)] || 1);
    const winnerIndex = weightedRandomIndex(weights);
    const name = students[winnerIndex].name;
    counts.set(name, (counts.get(name) || 0) + 1);
  }

  // Compute results
  const totalWeight = students.reduce(
    (sum, s) => sum + (tierWeights[tierMap.get(s.id)] || 1),
    0
  );

  const results = students.map(s => {
    const tier = tierMap.get(s.id);
    const weight = tierWeights[tier] || 1;
    const expectedProb = (weight / totalWeight) * 100;
    const count = counts.get(s.name) || 0;
    const observedProb = (count / n) * 100;
    const diff = observedProb - expectedProb;
    return {
      Name: s.name,
      Tier: tier,
      Weight: weight,
      "Expected %": expectedProb.toFixed(2),
      "Observed %": observedProb.toFixed(2),
      "Difference %": diff.toFixed(2),
      Count: count
    };
  });

  // Console display (pretty)
  console.table(results);

  // Also output CSV string for Excel
  const csvHeader = Object.keys(results[0]).join(",") + "\n";
  const csvRows = results.map(r => Object.values(r).join(",")).join("\n");
  const csv = csvHeader + csvRows;
  console.log("📋 Copy the following CSV data for Excel:\n\n" + csv);



  return results;
}


// Expose key variables for debugging from the console
window.students = students;
window.tierMap = tierMap;
window.tierWeights = tierWeights;
window.weightedRandomIndex = weightedRandomIndex;
window.testFairness = testFairness;




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
