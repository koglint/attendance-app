const express = require("express");
const multer = require("multer");
const { parse } = require("csv-parse/sync");
const crypto = require("crypto");
const XLSX = require("xlsx");


const PORT = process.env.PORT || 3000;
const SCHOOL_ID = process.env.SCHOOL_ID || "default";

// --- CORS: allow only your GitHub Pages origin(s) ---
const allowedOrigins = (process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map(s => s.trim())
  .filter(Boolean);




  
const app = express();

// Basic JSON parsing (not needed for file uploads yet)
app.use(express.json());

// CORS with dynamic origin allowlist
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && allowedOrigins.includes(origin)) {
    res.header("Access-Control-Allow-Origin", origin);
    res.header("Vary", "Origin");
    res.header("Access-Control-Allow-Credentials", "true");
    res.header("Access-Control-Allow-Headers", "Authorization, Content-Type");
    res.header("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  }
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});


// --- Public: Firebase config (served from env) ---
app.get("/public/firebase-config", (req, res) => {
  if (!process.env.FB_API_KEY) {
    return res.status(500).json({ error: "FB_API_KEY is not set on the server" });
  }

  // Prefer env values if you set them; fall back to known constants
  const cfg = {
    apiKey: process.env.FB_API_KEY, // <-- from env (never in Git)
    authDomain: process.env.FB_AUTH_DOMAIN || "attendance-app-820b0.firebaseapp.com",
    projectId: process.env.FB_PROJECT_ID || "attendance-app-820b0",
    storageBucket: process.env.FB_STORAGE_BUCKET || "attendance-app-820b0.appspot.com",
    messagingSenderId: process.env.FB_MESSAGING_SENDER_ID || "195821555404",
    appId: process.env.FB_APP_ID || "1:195821555404:web:2c2009a38bf42a88f53c69",
  };

  // Cache briefly; adjust as you like
  res.set({
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "private, max-age=300",
  });
  res.send(JSON.stringify(cfg));
});

  

// --- Firebase Admin init (safe even if credentials not set yet) ---
let admin, db;
try {
  admin = require("firebase-admin");
  if (process.env.FIREBASE_ADMIN_JSON_B64) {
    const json = JSON.parse(Buffer.from(process.env.FIREBASE_ADMIN_JSON_B64, "base64").toString("utf8"));
    admin.initializeApp({ credential: admin.credential.cert(json) });
  } else {
    // Will use GOOGLE_APPLICATION_CREDENTIALS if set, or ADC on Render
    admin.initializeApp();
  }
  db = admin.firestore();
} catch (e) {
  console.warn("Firebase Admin not fully initialised:", e.message);
}

// --- Firestore error mapping helper (put near the top, before routes) ---
function sendFirestoreError(res, e, fallbackMessage) {
  // Firestore/GRPC often signals quota/rate issues via code 8 (RESOURCE_EXHAUSTED)
  // or with 'quota'/'resource_exhausted' in the message/details.
  const code = e?.code;
  const text = (e?.details || e?.message || "").toLowerCase();
  const isQuota =
    code === 8 ||
    /quota|resource[_\s-]?exhausted/.test(text);

  if (isQuota) {
    // Make it explicit to the frontend
    return res.status(429).json({ error: "quota exceeded" });
  }

  // Optionally treat transient 'UNAVAILABLE' (14) as 503
  const isUnavailable = code === 14 || /unavailable|timeout/.test(text);
  if (isUnavailable) {
    return res.status(503).json({ error: "service unavailable" });
  }

  console.error(fallbackMessage, e);
  return res.status(500).json({ error: fallbackMessage });
}



// --- Auth middleware (Email/Password tokens) ---
// ✅ outer returns a function; inner can be async
function requireAuth(requiredRole) {
  return async (req, res, next) => {
    if (!admin || !db) return res.status(503).json({ error: "auth not initialised on server" });

    const header = req.headers.authorization || "";
    if (!header.startsWith("Bearer ")) return res.status(401).json({ error: "missing bearer token" });
    const idToken = header.split(" ", 2)[1];

    let decoded;
    try {
      decoded = await admin.auth().verifyIdToken(idToken, true);
    } catch {
      return res.status(401).json({ error: "invalid token" });
    }

    const uid = decoded.uid;
    try {
      const userDoc = await db.collection("schools").doc(SCHOOL_ID).collection("users").doc(uid).get();
      if (!userDoc.exists) return res.status(403).json({ error: "no user profile" });
      const role = userDoc.get("role");
      if (requiredRole && role !== requiredRole && role !== "admin") {
        return res.status(403).json({ error: "forbidden" });
      }
      req.user = { uid, role };
      next();
    } catch (err) {
      console.error("Role lookup failed:", err);
      return res.status(503).json({
        error: "role lookup failed",
        detail: err?.message || String(err),
      });
    }
  };
}

// Multer: keep files in memory (no disk writes)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 } // 25MB
});

// Header mapping helpers (tolerate case/spacing variants)
const ABSENCE_REPORT_HEADERS = {
  studentId: [
    "Student ID","StudentId","External id","ExternalId",
    "External_id","ExternalID","ID","Sentral ID","SentralId"
  ],
  rollClass: [
    "Roll Class","Rollclass name","Rollclass","Roll class name","Roll class",
    "Class","Homegroup","RollGroup","Roll group"
  ],
  date: [
    "Date","Attendance Date","Absence Date"
  ],
  shorthand: [
    "Shorthand","Code","Attendance Code"
  ],
  description: [
    "Description","Attendance Description","Status"
  ],
  time: [
    "Time","Attendance Time","Session Time","Period Time"
  ]
};
const normalize = h => String(h || "").toLowerCase().replace(/[^a-z0-9]/g,"");
function findHeader(headers, candidates) {
  const map = new Map();
  headers.forEach(h => map.set(normalize(h), h));
  for (const c of candidates) {
    const hit = map.get(normalize(c));
    if (hit) return hit;
  }
  return null;
}
const clamp01 = n => Math.max(0, Math.min(100, n));

const TERM_CALENDAR = Object.freeze({
  2026: Object.freeze({
    1: Object.freeze({ weekStart: "2026-01-26", studentStart: "2026-02-02", end: "2026-04-02" }),
    2: Object.freeze({ weekStart: "2026-04-20", studentStart: "2026-04-22", end: "2026-07-03" }),
    3: Object.freeze({ weekStart: "2026-07-20", studentStart: "2026-07-21", end: "2026-09-25" }),
    4: Object.freeze({ weekStart: "2026-10-12", studentStart: "2026-10-13", end: "2026-12-17" }),
  }),
});

const TERM_WEEK_COUNTS = Object.freeze({
  1: 10,
  2: 11,
  3: 10,
  4: 10,
});

function parseIsoDateOnly(iso) {
  const [y, m, d] = String(iso || "").split("-").map(Number);
  if (!Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d)) return null;
  return new Date(Date.UTC(y, m - 1, d));
}

function toIsoDateOnly(value) {
  const dt = value instanceof Date ? value : new Date(value);
  if (!(dt instanceof Date) || Number.isNaN(dt.getTime())) return null;
  return dt.toISOString().slice(0, 10);
}

function addUtcDays(date, days) {
  const next = new Date(date.getTime());
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

function minDate(a, b) {
  return a.getTime() <= b.getTime() ? a : b;
}

function getTermBounds(year, term) {
  const cfg = TERM_CALENDAR[year]?.[term];
  if (!cfg) return null;
  const weekStart = parseIsoDateOnly(cfg.weekStart || cfg.start);
  const studentStart = parseIsoDateOnly(cfg.studentStart || cfg.start);
  const end = parseIsoDateOnly(cfg.end);
  return weekStart && studentStart && end ? { weekStart, studentStart, end } : null;
}

function getMaxWeekInTerm(year, term) {
  const bounds = getTermBounds(year, term);
  if (!bounds) return null;
  return TERM_WEEK_COUNTS[term] || null;
}

function inferSchoolWeekFromDate(dateIso) {
  const target = parseIsoDateOnly(dateIso);
  if (!target) return null;
  for (const [yearText, terms] of Object.entries(TERM_CALENDAR)) {
    const year = Number(yearText);
    for (const [termText, cfg] of Object.entries(terms || {})) {
      const term = Number(termText);
      const start = parseIsoDateOnly(cfg.weekStart || cfg.start);
      const end = parseIsoDateOnly(cfg.end);
      if (!start || !end) continue;
      const maxWeek = getMaxWeekInTerm(year, term);
      const gridEnd = addUtcDays(start, maxWeek * 7 - 1);
      if (target.getTime() < start.getTime() || target.getTime() > gridEnd.getTime()) continue;
      const week = Math.floor((target.getTime() - start.getTime()) / 86400000 / 7) + 1;
      if (Number.isInteger(maxWeek) && week >= 1 && week <= maxWeek) {
        return { year, term, week, label: `${year} Term ${term} Week ${week}` };
      }
    }
  }
  return null;
}

function isSupportedRollClass(value) {
  const text = String(value || "").trim();
  if (!text) return false;
  const normalized = text.toLowerCase().replace(/[^a-z0-9]/g, "");
  return (
    /^07roll\d+$/i.test(text) ||
    /^08roll\d+$/i.test(text) ||
    /^7[a-z0-9]*/i.test(text) ||
    /^8[a-z0-9]*/i.test(text) ||
    normalized.includes("year7") ||
    normalized.includes("year8") ||
    normalized.includes("yr7") ||
    normalized.includes("yr8") ||
    normalized.includes("y7") ||
    normalized.includes("y8") ||
    normalized.startsWith("07roll") ||
    normalized.startsWith("08roll")
  );
}

function getWeekWindowDates(year, term, week) {
  const bounds = getTermBounds(year, term);
  if (!bounds) return null;
  const maxWeek = getMaxWeekInTerm(year, term);
  if (!Number.isInteger(maxWeek) || week < 1 || week > maxWeek) {
    return {
      current: [],
      previous: [],
      currentBlockStart: null,
    };
  }

  const blockStart = addUtcDays(bounds.weekStart, (week - 1) * 7);

  function datesForWeek(targetWeek) {
    if (!Number.isInteger(targetWeek) || targetWeek < 1 || targetWeek > maxWeek) return [];
    const start = addUtcDays(bounds.weekStart, (targetWeek - 1) * 7);
    const end = addUtcDays(start, 6);
    const dates = [];
    for (let d = start; d.getTime() <= end.getTime(); d = addUtcDays(d, 1)) {
      const dow = d.getUTCDay();
      if (d.getTime() < bounds.studentStart.getTime() || d.getTime() > bounds.end.getTime()) continue;
      if (dow >= 1 && dow <= 4) dates.push(toIsoDateOnly(d));
    }
    return dates;
  }

  return {
    current: datesForWeek(week),
    previous: datesForWeek(week - 1),
    currentBlockStart: toIsoDateOnly(blockStart),
  };
}

function isRollCallTimeLate(timeRaw) {
  function toMinuteOfDay(value) {
    if (value instanceof Date && !Number.isNaN(value.getTime())) {
      return value.getHours() * 60 + value.getMinutes();
    }
    if (typeof value === "number" && Number.isFinite(value)) {
      const parsed = XLSX.SSF.parse_date_code(value);
      if (parsed && Number.isInteger(parsed.H) && Number.isInteger(parsed.M)) {
        return parsed.H * 60 + parsed.M;
      }
      if (value >= 0 && value < 1) {
        const totalMinutes = Math.round(value * 24 * 60);
        return totalMinutes >= 0 && totalMinutes < 24 * 60 ? totalMinutes : null;
      }
    }

    const text = String(value || "").trim();
    if (!text) return null;
    const firstChunk = text.split(/\s*[-–—]\s*/, 1)[0].trim();
    const match = firstChunk.match(/^(\d{1,2}):(\d{2})(?::\d{2})?\s*([AaPp][Mm])?$/);
    if (!match) return null;

    let hour = Number(match[1]);
    const minute = Number(match[2]);
    const meridiem = (match[3] || "").toUpperCase();
    if (!Number.isInteger(hour) || !Number.isInteger(minute) || minute < 0 || minute > 59) return null;

    if (meridiem === "AM") {
      if (hour === 12) hour = 0;
    } else if (meridiem === "PM") {
      if (hour !== 12) hour += 12;
    }

    if (hour < 0 || hour > 23) return null;
    return hour * 60 + minute;
  }

  const minuteOfDay = toMinuteOfDay(timeRaw);
  return minuteOfDay === 8 * 60 || minuteOfDay === (8 * 60 + 25);
}

function normalizeTimeRangeText(value) {
  return String(value || "")
    .trim()
    .toUpperCase()
    .replace(/[–—]/g, "-")
    .replace(/\s+/g, "");
}

function isAllDayAbsenceTime(value) {
  const normalized = normalizeTimeRangeText(value);
  return (
    normalized === "8:00AM-2:45PM" ||
    normalized === "8:25AM-2:45PM"
  );
}

function isRollCallMiss(shorthandRaw, descriptionRaw, timeRaw) {
  const shorthand = String(shorthandRaw || "").trim().toUpperCase();
  const description = String(descriptionRaw || "").trim().toLowerCase();
  const hasUnexplainedCode =
    (shorthand === "U" && description === "unjustified") ||
    (shorthand === "?" && description === "absent");
  return (
    hasUnexplainedCode &&
    (
      String(timeRaw || "").trim() === "" ||
      isRollCallTimeLate(timeRaw) ||
      isAllDayAbsenceTime(timeRaw)
    )
  );
}

function normalizeReportDate(value) {
  if (value instanceof Date) return toIsoDateOnly(value);
  if (typeof value === "number" && Number.isFinite(value)) {
    const parts = XLSX.SSF.parse_date_code(value);
    if (!parts) return null;
    return toIsoDateOnly(new Date(Date.UTC(parts.y, parts.m - 1, parts.d)));
  }

  const text = String(value || "").trim();
  if (!text) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;

  const dt = new Date(text);
  return Number.isNaN(dt.getTime()) ? null : toIsoDateOnly(dt);
}

function parseTabularUpload(buffer, filename = "") {
  const lower = String(filename || "").toLowerCase();
  if (lower.endsWith(".csv")) {
    const text = buffer.toString("utf8");
    return {
      rows: parse(text, { columns: true, skip_empty_lines: true, bom: true }),
      sourceType: "csv",
      sheetName: null,
    };
  }

  const workbook = XLSX.read(buffer, {
    type: "buffer",
    cellDates: true,
    dense: false,
  });
  const sheetName = workbook.SheetNames[0];
  if (!sheetName) return { rows: [], sourceType: "spreadsheet", sheetName: null };
  const rows = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], {
    defval: "",
    raw: true,
  });
  return { rows, sourceType: "spreadsheet", sheetName };
}

async function fetchRosterStudentMap(schoolRef) {
  const snap = await schoolRef.collection("roster").get();
  const map = new Map();
  snap.forEach((doc) => {
    const data = doc.data() || {};
    const externalId = String(data.externalId || doc.id).replace(/\//g, "_");
    map.set(externalId, {
      externalId,
      rollClass: data.rollClass || null,
      firstName: data.givenNames || null,
      surname: data.surname || null,
    });
  });
  return map;
}

// --- Join roster aliases for a list of externalIds (doc id = externalId with / replaced) ---
async function fetchAliasMapForIds(ids) {
  const clean = Array.from(new Set((ids || []).map(id => String(id)).filter(Boolean)));
  const map = new Map();
  if (!clean.length) return map;

  const refs = clean.map(id => {
    const docId = id.replace(/\//g, "_");
    return db.collection("schools").doc(SCHOOL_ID).collection("roster").doc(docId);
  });

  const snaps = await db.getAll(...refs);
  snaps.forEach((docSnap, idx) => {
    const id = clean[idx];
    const alias = docSnap.exists ? (docSnap.get("alias") ?? null) : null;
    if (alias) map.set(id, String(alias));
  });

  return map; // Map<externalId, alias>
}

// === Returns the latest and second-latest snapshot refs for a given year/term ===
async function getTopTwoSnapshotRefs(schoolRef, year, term) {
  const snapsQS = await schoolRef.collection("snapshots")
    .where("year", "==", year)
    .where("term", "==", term)
    .get();

  // Gather {week, ref}, sort ascending by week
  const items = [];
  snapsQS.forEach(d => {
    const w = d.get("week");
    if (Number.isInteger(w)) items.push({ week: w, ref: d.ref });
  });
  items.sort((a,b) => a.week - b.week);

  if (items.length === 0) return { latest: null, prev: null };
  const latest = items[items.length - 1] || null;
  const prev   = items.length >= 2 ? items[items.length - 2] : null;
  return { latest, prev };
}

// === Recomputes weekly status fields for the latest snapshot for a term ===
async function recomputeLatestTrendForTerm(db, schoolRef, year, term) {
  const { latest } = await getTopTwoSnapshotRefs(schoolRef, year, term);
  if (!latest) return { latestSnapshotId: null, compared: null };

  const latestRowsQS = await latest.ref.collection("rows")
    .select("lateDays", "windowDays")
    .get();

  let batch = db.batch();
  let inBatch = 0;
  latestRowsQS.forEach(doc => {
    const lateDays = Number(doc.get("lateDays") ?? 0);
    const windowDays = Number(doc.get("windowDays") ?? 0);
    const daysOnTime = Math.max(0, windowDays - lateDays);
    const status = statusFromDaysOnTime(daysOnTime, windowDays);

    const ref = doc.ref;
    const data = {
      trend: status ?? null,
      ...(status ? {
        trendMeta: {
          year,
          term,
          week: latest.week,
          daysOnTime,
          lateDays,
          windowDays,
          version: "status-v1",
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        }
      } : { trendMeta: admin.firestore.FieldValue.delete?.() || null })
    };

    batch.set(ref, data, { merge: true });
    inBatch++;
    if (inBatch >= 500) {
      batch.commit();
      batch = db.batch();
      inBatch = 0;
    }
  });
  if (inBatch) await batch.commit();

  return {
    latestSnapshotId: latest.ref.id,
    compared: null
  };
}

// --- Weekly status helpers ---
const TREND = Object.freeze({
  GOAT: "goat",
  SAD1: "sad1",
  SAD2: "sad2",
  SAD3: "sad3",
  SAD4: "sad4",
});

function statusFromDaysOnTime(daysOnTime, windowDays) {
  if (!Number.isFinite(daysOnTime) || !Number.isFinite(windowDays) || windowDays <= 0) return null;
  if (daysOnTime >= 4) return TREND.GOAT;
  if (daysOnTime === windowDays && windowDays < 4) return TREND.GOAT;
  if (daysOnTime === 3) return TREND.SAD1;
  if (daysOnTime === 2) return TREND.SAD2;
  if (daysOnTime === 1) return TREND.SAD3;
  if (daysOnTime <= 0) return TREND.SAD4;
  return null;
}


// ===== Leaderboard aggregation (term) =====
const BADGE_POINTS = { sad4: 0, sad3: 1, sad2: 2, sad1: 3, goat: 4 };
const TREND_TO_POINTS = BADGE_POINTS;
const MAX_WEEKS = 12;

function termIdOf(year, term) { return `${year}-T${term}`; }

async function getStudentCountByRoll(db, schoolId) {
  const snap = await db.collection("schools").doc(schoolId).collection("roster").select("rollClass").get();
  const map = {};
  snap.forEach(d => {
    const rc = d.get("rollClass");
    if (!rc) return;
    map[rc] = (map[rc] || 0) + 1;
  });
  return map;
}

// Rolls to exclude from leaderboard (case-insensitive)
const EXCLUDED_ROLLS = new Set([
  "SRC",
  "Connect Roll",
  "No Roll Class",
  "SUPPORT",
].map(s => s.toLowerCase()));

// === Aggregates leaderboard data for a term (per roll class, per week) ===
async function aggregateTermLeaderboard(db, schoolId, year, term) {
  const schoolRef = db.collection("schools").doc(schoolId);
  const snapsQS = await schoolRef.collection("snapshots")
    .where("year", "==", year).where("term", "==", term).get();

  const weeks = [];
  snapsQS.forEach(d => { const w = d.get("week"); if (Number.isInteger(w)) weeks.push({ week: w, ref: d.ref }); });
  weeks.sort((a,b) => a.week - b.week);
  const limited = weeks.slice(0, MAX_WEEKS);

  const byRoll = {};
  function ensureRoll(rc) {
    if (!byRoll[rc]) byRoll[rc] = {
      counts: { goat:0, sad1:0, sad2:0, sad3:0, sad4:0 },
      rawPoints: 0,
      weeks: {}
    };
    return byRoll[rc];
  }

  for (const { week, ref } of limited) {
    const rows = await ref.collection("rows").select("rollClass", "trend").get();
    const wkByRoll = {};
    rows.forEach(r => {
    const rc = r.get("rollClass");
    if (!rc || EXCLUDED_ROLLS.has(String(rc).toLowerCase())) return; // <-- skip these
    const tr = r.get("trend");
    if (!tr || !(tr in TREND_TO_POINTS)) return;
    wkByRoll[rc] ||= { goat:0, sad1:0, sad2:0, sad3:0, sad4:0, rawPoints:0 };
    wkByRoll[rc][tr] += 1;
    wkByRoll[rc].rawPoints += TREND_TO_POINTS[tr];
  });

    for (const [rc, wk] of Object.entries(wkByRoll)) {
      const agg = ensureRoll(rc);
      agg.weeks[week] = wk;
      for (const k of ["goat","sad1","sad2","sad3","sad4"]) agg.counts[k] += wk[k];
      agg.rawPoints += wk.rawPoints;
    }
  }

  const studentCountByRoll = await getStudentCountByRoll(db, schoolId);
  const leaderboard = Object.entries(byRoll).map(([rollId, agg]) => {
    const n = Number(studentCountByRoll[rollId] || 0);
    const normPoints = n > 0 ? agg.rawPoints / n : 0;
    return {
      rollId,
      counts: agg.counts,
      rawPoints: agg.rawPoints,
      normPoints,
      studentCount: n,
      weeks: agg.weeks
    };
  }).sort((a,b) => b.normPoints - a.normPoints);

  return { weeks: limited.map(w=>w.week), leaderboard };
}

// === Writes the computed leaderboard for a term to Firestore ===
async function writeTermLeaderboard(db, schoolId, year, term, payload) {
  const termId = termIdOf(year, term);
  const base = db.collection("schools").doc(schoolId).collection("terms").doc(termId);
  await base.collection("leaderboard").doc("current").set({
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    year, term,
    weeks: payload.weeks,
    leaderboard: payload.leaderboard
  }, { merge: false });
}

// === Aggregates and writes leaderboard for a term (helper for upload) ===
async function recomputeAndStoreLeaderboardForTerm(db, schoolId, year, term) {
  const data = await aggregateTermLeaderboard(db, schoolId, year, term);
  await writeTermLeaderboard(db, schoolId, year, term, data);
}



/** Find the snapshot doc for the most recent week < current within the same Year/Term. */
async function findPreviousSnapshotRef(db, schoolRef, year, term, week) {
  const snapsQS = await schoolRef.collection("snapshots")
    .where("year", "==", year)
    .where("term", "==", term)
    .get();

  let best = null, bestWeek = -Infinity;
  snapsQS.forEach(d => {
    const w = d.get("week");
    if (Number.isInteger(w) && w < week && w > bestWeek) {
      bestWeek = w;
      best = d.ref;
    }
  });
  return best; // null if none
}


// Admin upload: accepts Sentral absence list reports and writes a new snapshot
app.post("/api/uploads", requireAuth("admin"), upload.single("file"), async (req, res) => {
  try {
    if (!admin || !db) return res.status(503).json({ error: "auth not initialised on server" });
    if (!req.file || !req.file.buffer) return res.status(400).json({ error: "missing file" });

    // Parse report rows from CSV/XLS/XLSX
    const parsedUpload = parseTabularUpload(req.file.buffer, req.file.originalname || "");
    const records = parsedUpload.rows;
    if (!records.length) return res.status(400).json({ error: "empty report" });

    // Header detection
    const headers = Object.keys(records[0]);
    const hExternal = findHeader(headers, ABSENCE_REPORT_HEADERS.studentId);
    const hClass = findHeader(headers, ABSENCE_REPORT_HEADERS.rollClass);
    const hDate = findHeader(headers, ABSENCE_REPORT_HEADERS.date);
    const hShorthand = findHeader(headers, ABSENCE_REPORT_HEADERS.shorthand);
    const hDescription = findHeader(headers, ABSENCE_REPORT_HEADERS.description);
    const hTime = findHeader(headers, ABSENCE_REPORT_HEADERS.time);
    if (!hExternal || !hClass || !hDate || !hShorthand || !hDescription || !hTime) {
      return res.status(400).json({
        error: "missing required columns",
        required: ["Student ID", "Roll Class", "Date", "Shorthand", "Description", "Time"],
        found: headers
      });
    }

    const inferredWeeks = new Map();
    for (const row of records) {
      const rollClass = String(row[hClass] ?? "").trim();
      const date = normalizeReportDate(row[hDate]);
      if (!rollClass || !date || !isSupportedRollClass(rollClass)) continue;
      const inferred = inferSchoolWeekFromDate(date);
      if (!inferred) continue;
      inferredWeeks.set(`${inferred.year}-${inferred.term}-${inferred.week}`, inferred);
    }
    if (!inferredWeeks.size) {
      return res.status(400).json({ error: "could not infer school week from report dates" });
    }
    const inferredWeekList = Array.from(inferredWeeks.values()).sort((a, b) =>
      (a.year - b.year) || (a.term - b.term) || (a.week - b.week)
    );

    // Checksums (info/diagnostics)
    const contentChecksum = crypto.createHash("sha256").update(req.file.buffer).digest("hex");
    const compoundChecksum = crypto
      .createHash("sha256")
      .update(req.file.buffer)
      .update("|")
      .update(inferredWeekList.map((item) => item.label).join("|"))
      .digest("hex");

    const schoolRef = db.collection("schools").doc(SCHOOL_ID);
    const uploadsColl = schoolRef.collection("uploads");
    const snapsColl = schoolRef.collection("snapshots");

    // Create upload record (status: processing)
    const uploadRef = uploadsColl.doc();
    await uploadRef.set({
      filename: req.file.originalname || "absence-report",
      contentChecksum,
      compoundChecksum,
      uploadedAt: admin.firestore.FieldValue.serverTimestamp(),
      uploadedBy: req.user.uid,
      rowCount: records.length,
      status: "processing",
      inferredWeeks: inferredWeekList,
      sourceType: parsedUpload.sourceType,
      sourceSheet: parsedUpload.sheetName,
      metric: "mon-thu-roll-call",
    });

    const rosterById = await fetchRosterStudentMap(schoolRef);
    if (!rosterById.size) {
      return res.status(400).json({ error: "roster is empty; upload roster data before attendance reports" });
    }

    function ensureDateSet(map, externalId) {
      const key = String(externalId).trim().replace(/\//g, "_");
      if (!map.has(key)) map.set(key, new Set());
      return map.get(key);
    }
    const perWeekResults = [];
    let totalWritten = 0;
    let totalAcceptedRows = 0;
    let totalIgnoredRows = 0;
    let latestSnapshotId = null;
    const touchedTerms = new Map();

    for (const { year, term, week, label } of inferredWeekList) {
      const windows = getWeekWindowDates(year, term, week);
      if (!windows || !windows.current.length) continue;

      const existingSnapQS = await snapsColl
        .where("year", "==", year)
        .where("term", "==", term)
        .where("week", "==", week)
        .limit(1)
        .get();

      let snapshotRef;
      let reusedExisting = false;

      if (!existingSnapQS.empty) {
        snapshotRef = existingSnapQS.docs[0].ref;
        reusedExisting = true;
        await snapshotRef.set(
          {
            uploadedAt: admin.firestore.FieldValue.serverTimestamp(),
            uploadId: uploadRef.id,
            isLatest: false,
            year,
            term,
            week,
            label,
            metric: "mon-thu-roll-call",
          },
          { merge: true }
        );

        const rowsColl = snapshotRef.collection("rows");
        while (true) {
          const toDelete = await rowsColl.limit(500).get();
          if (toDelete.empty) break;
          const batch = db.batch();
          toDelete.docs.forEach((d) => batch.delete(d.ref));
          await batch.commit();
        }
      } else {
        snapshotRef = snapsColl.doc();
        await snapshotRef.set({
          uploadedAt: admin.firestore.FieldValue.serverTimestamp(),
          uploadId: uploadRef.id,
          isLatest: false,
          year,
          term,
          week,
          label,
          metric: "mon-thu-roll-call",
        });
      }

      const classSet = new Set();
      const currentDateSet = new Set(windows.current);
      const previousDateSet = new Set(windows.previous);
      const currentLateById = new Map();
      const previousLateById = new Map();
      const reportRollClassById = new Map();
      let acceptedRows = 0;
      let ignoredRows = 0;
      const diagnostics = {
        missingCoreFields: 0,
        unsupportedRollClass: 0,
        codeMismatch: 0,
        timeMismatch: 0,
        outsideWindows: 0,
      };

      for (const row of records) {
        const externalId = String(row[hExternal] ?? "").trim().replace(/\//g, "_");
        const rollClass = String(row[hClass] ?? "").trim();
        const date = normalizeReportDate(row[hDate]);
        const codeMatches =
          (String(row[hShorthand] ?? "").trim().toUpperCase() === "U" &&
            String(row[hDescription] ?? "").trim().toLowerCase() === "unjustified") ||
          (String(row[hShorthand] ?? "").trim().toUpperCase() === "?" &&
            String(row[hDescription] ?? "").trim().toLowerCase() === "absent");
        const rawTime = row[hTime];
        const timeMatches =
          String(rawTime || "").trim() === "" ||
          isRollCallTimeLate(rawTime) ||
          isAllDayAbsenceTime(rawTime);

        if (!externalId || !rollClass || !date) {
          diagnostics.missingCoreFields++;
          ignoredRows++;
          continue;
        }
        if (!isSupportedRollClass(rollClass)) {
          diagnostics.unsupportedRollClass++;
          ignoredRows++;
          continue;
        }
        if (!codeMatches) {
          diagnostics.codeMismatch++;
          ignoredRows++;
          continue;
        }
        if (!timeMatches) {
          diagnostics.timeMismatch++;
          ignoredRows++;
          continue;
        }

        if (currentDateSet.has(date)) {
          ensureDateSet(currentLateById, externalId).add(date);
          reportRollClassById.set(externalId, rollClass);
          classSet.add(rollClass);
          acceptedRows++;
          continue;
        }

        if (previousDateSet.has(date)) {
          ensureDateSet(previousLateById, externalId).add(date);
          reportRollClassById.set(externalId, rollClass);
          classSet.add(rollClass);
          acceptedRows++;
          continue;
        }

        diagnostics.outsideWindows++;
        ignoredRows++;
      }

      const studentUniverse = new Map();
      for (const [externalId, student] of rosterById.entries()) {
        if (isSupportedRollClass(student?.rollClass)) {
          studentUniverse.set(externalId, student);
        }
      }
      for (const [externalId, rollClass] of reportRollClassById.entries()) {
        if (!studentUniverse.has(externalId)) {
          studentUniverse.set(externalId, {
            externalId,
            rollClass: rollClass || null,
            firstName: null,
            surname: null,
          });
        }
      }

      const currentWindowDays = windows.current.length;
      const previousWindowDays = windows.previous.length;

      const rowsColl = snapshotRef.collection("rows");
      let batch = db.batch();
      let inBatch = 0;
      let written = 0;

      for (const student of studentUniverse.values()) {
        const externalId = String(student.externalId).trim().replace(/\//g, "_");
        const rollClass = reportRollClassById.get(externalId) || student.rollClass || "No Roll Class";
        const currentLateDates = Array.from(currentLateById.get(externalId) || []).sort();
        const previousLateDates = Array.from(previousLateById.get(externalId) || []).sort();
        const currentLateDays = currentLateDates.length;
        const previousLateDays = previousLateDates.length;
        const daysOnTime = Math.max(0, currentWindowDays - currentLateDays);
        const pct = currentWindowDays > 0
          ? clamp01(((currentWindowDays - currentLateDays) / currentWindowDays) * 100)
          : null;
        const trend = statusFromDaysOnTime(daysOnTime, currentWindowDays);

        classSet.add(rollClass);

        const ref = rowsColl.doc(externalId);
        batch.set(ref, {
          externalId,
          rollClass,
          pctAttendance: pct,
          lateDays: currentLateDays,
          windowDays: currentWindowDays,
          lateDates: currentLateDates,
          trend: trend ?? null,
          trendMeta: trend ? {
            year,
            term,
            week,
            daysOnTime,
            lateDays: currentLateDays,
            windowDays: currentWindowDays,
            version: "status-v1",
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          } : null,
          metric: "mon-thu-roll-call",
          metricMeta: {
            year,
            term,
            week,
            currentWindowDates: windows.current,
            previousWindowDates: windows.previous,
            previousWindowDays,
            previousLateDays,
            previousPctAttendance: previousWindowDays > 0
              ? clamp01(((previousWindowDays - previousLateDays) / previousWindowDays) * 100)
              : null,
          },
        }, { merge: false });

        inBatch++;
        written++;
        if (inBatch >= 500) {
          await batch.commit();
          batch = db.batch();
          inBatch = 0;
        }
      }
      if (inBatch) await batch.commit();

      latestSnapshotId = snapshotRef.id;
      touchedTerms.set(`${year}-${term}`, { year, term, snapshotRef });

      await snapshotRef.set(
        {
          isLatest: true,
          classList: Array.from(classSet).sort(),
          metric: "mon-thu-roll-call",
          metricLabel: "Mon-Thu roll-call score",
          currentWindowDates: windows.current,
          previousWindowDates: windows.previous,
          currentWindowDays,
          previousWindowDays,
        },
        { merge: true }
      );

      perWeekResults.push({
        snapshotId: snapshotRef.id,
        label,
        year,
        term,
        week,
        reusedExisting,
        currentWindowDates: windows.current,
        previousWindowDates: windows.previous,
        rowCount: written,
        acceptedRows,
        ignoredRows,
        diagnostics,
      });
      totalWritten += written;
      totalAcceptedRows += acceptedRows;
      totalIgnoredRows += ignoredRows;
    }

    for (const { year, term, snapshotRef } of touchedTerms.values()) {
      const latestForTerm = await recomputeLatestTrendForTerm(db, schoolRef, year, term);
      latestSnapshotId = latestForTerm.latestSnapshotId || snapshotRef.id || latestSnapshotId;
      await recomputeAndStoreLeaderboardForTerm(db, SCHOOL_ID, year, term);
    }
    if (latestSnapshotId) {
      await schoolRef.set({ latestSnapshotId }, { merge: true });
    }

    await uploadRef.update({
      status: "processed",
      snapshotIds: perWeekResults.map((item) => item.snapshotId),
      rowCount: totalWritten,
      acceptedRows: totalAcceptedRows,
      ignoredRows: totalIgnoredRows,
    });

    return res.json({
      uploadId: uploadRef.id,
      snapshotIds: perWeekResults.map((item) => item.snapshotId),
      weeksProcessed: perWeekResults,
      rowCount: totalWritten,
      acceptedRows: totalAcceptedRows,
      ignoredRows: totalIgnoredRows,
      metric: "Mon-Thu roll-call score",
    });
  } catch (err) {
    console.error("Upload failed:", err);
    try {
      const uploads = db.collection("schools").doc(SCHOOL_ID).collection("uploads");
      if (req.file) {
        const checksum = crypto.createHash("sha256").update(req.file.buffer).digest("hex");
        const q = await uploads.where("contentChecksum", "==", checksum).limit(1).get();
        if (!q.empty) await uploads.doc(q.docs[0].id).update({ status: "failed" });
      }
    } catch {}
    return res.status(500).json({ error: "upload failed" });
  }
});


// Teacher: read precomputed leaderboard for a term
app.get("/api/leaderboard", requireAuth("teacher"), async (req, res) => {
  try {
    const year = Number(req.query.year);
    const term = Number(req.query.term);
    if (!Number.isInteger(year) || ![1,2,3,4].includes(term)) {
      return res.status(400).json({ error: "invalid year/term" });
    }
    const termId = `${year}-T${term}`;
    const doc = await db.collection("schools").doc(SCHOOL_ID)
      .collection("terms").doc(termId)
      .collection("leaderboard").doc("current").get();
    if (!doc.exists) return res.json({ ok: true, year, term, weeks: [], leaderboard: [] });
    const data = doc.data() || {};
    return res.json({ ok: true, year, term, weeks: data.weeks || [], leaderboard: data.leaderboard || [] });
  } catch (e) {
    return sendFirestoreError(res, e, "failed to load leaderboard");
  }
});



// --- Health check ---
app.get("/healthz", (req, res) => {
  res.status(200).send("ok");
});

// --- Teacher endpoints (read-only): latest meta, classes, class rows ---

// Add near other routes:

app.get("/api/whoami", requireAuth(), (req, res) => {
  res.json({ uid: req.user.uid, role: req.user.role });
});

// Student: summary from latest snapshot (live-computed; one read of school doc + one row doc)
app.get("/api/me/summary", requireAuth("student"), async (req, res) => {
  try {
    res.set("Cache-Control", "no-store");
    const schoolRef = db.collection("schools").doc(SCHOOL_ID);
    const userRef = schoolRef.collection("users").doc(req.user.uid);
    const userDoc = await userRef.get();
    if (!userDoc.exists) return res.status(404).json({ error: "no user profile" });

    const profile = userDoc.data() || {};
    const externalId = profile.externalId;
    if (!externalId) return res.status(404).json({ error: "no student id on profile" });

    const queryYear = Number(req.query.year);
    const queryTerm = Number(req.query.term);
    const queryWeek = Number(req.query.week);

    let snapDoc = null;
    let snapshotId = null;
    let year = null;
    let term = null;
    let week = null;
    let label = null;

    if (Number.isInteger(queryYear) && [1, 2, 3, 4].includes(queryTerm) && Number.isInteger(queryWeek)) {
      const qs = await schoolRef.collection("snapshots")
        .where("year", "==", queryYear)
        .where("term", "==", queryTerm)
        .where("week", "==", queryWeek)
        .limit(1)
        .get();
      if (qs.empty) return res.status(404).json({ error: "no snapshot for the selected term/week" });
      snapDoc = qs.docs[0];
      snapshotId = snapDoc.id;
      year = queryYear;
      term = queryTerm;
      week = queryWeek;
      label = snapDoc.get("label") ?? null;
    } else {
      const schoolDoc = await schoolRef.get();
      const latestSnapshotId = schoolDoc.get("latestSnapshotId");
      if (!latestSnapshotId) return res.status(404).json({ error: "no snapshot yet" });
      snapshotId = latestSnapshotId;
      snapDoc = await schoolRef.collection("snapshots").doc(latestSnapshotId).get();
      year = snapDoc.get("year") ?? null;
      term = snapDoc.get("term") ?? null;
      week = snapDoc.get("week") ?? null;
      label = snapDoc.get("label") ?? null;
    }

    const rowRef = snapDoc.ref.collection("rows").doc(String(externalId).replace(/\//g,"_"));
    const rowDoc = await rowRef.get();

    const pct = rowDoc.exists ? rowDoc.get("pctAttendance") : null;
    const trend = rowDoc.exists ? (rowDoc.get("trend") ?? null) : null;
    let previousPct = null;
    if (year && term) {
      const snapsQS = await schoolRef.collection("snapshots")
        .where("year", "==", year)
        .where("term", "==", term)
        .get();
      let prevRef = null;
      let prevWeek = -Infinity;
      snapsQS.forEach((d) => {
        const candidateWeek = d.get("week");
        if (Number.isInteger(candidateWeek) && candidateWeek < week && candidateWeek > prevWeek) {
          prevWeek = candidateWeek;
          prevRef = d.ref;
        }
      });
      if (prevRef) {
        const prevRowDoc = await prevRef.collection("rows").doc(String(externalId).replace(/\//g,"_")).get();
        previousPct = prevRowDoc.exists ? (prevRowDoc.get("pctAttendance") ?? null) : null;
      }
    }

    const uploadedAt = snapDoc.get("uploadedAt");
    const updatedAtIso = uploadedAt?.toDate ? uploadedAt.toDate().toISOString() : null;

    // Optionally compute YTD/term % later; for now mirror latest week (%)
    return res.json({
      studentId: externalId,
      firstName: profile.firstName ?? null,
      surname: profile.surname ?? null,
      rollClass: profile.rollClass ?? (rowDoc.get("rollClass") ?? null),
      term: year && term ? `${year}-T${term}` : label,
      snapshotLabel: label || (year && term && week ? `${year} Term ${term} Week ${week}` : null),
      ytdPercent: previousPct,
      termPercent: pct,
      trend,
      year,
      week,
      version: `live-${snapshotId}`,
      updatedAt: updatedAtIso
    });
  } catch (e) {
    return sendFirestoreError(res, e, "failed to load student summary");
  }
});

app.get("/api/me/terms", requireAuth("student"), async (req, res) => {
  try {
    res.set("Cache-Control", "no-store");
    const schoolRef = db.collection("schools").doc(SCHOOL_ID);
    const userDoc = await schoolRef.collection("users").doc(req.user.uid).get();
    if (!userDoc.exists) return res.status(404).json({ error: "no user profile" });
    const externalId = userDoc.get("externalId");
    if (!externalId) return res.status(404).json({ error: "no student id on profile" });

    const snapsQS = await schoolRef.collection("snapshots").get();
    const byTerm = new Map();
    snapsQS.forEach((d) => {
      const year = d.get("year");
      const term = d.get("term");
      const week = d.get("week");
      if (!Number.isInteger(year) || !Number.isInteger(term) || !Number.isInteger(week)) return;
      const key = `${year}-${term}`;
      const current = byTerm.get(key) || { year, term, weeks: new Set() };
      current.weeks.add(week);
      byTerm.set(key, current);
    });

    const terms = Array.from(byTerm.values())
      .map((item) => ({ year: item.year, term: item.term, weeks: Array.from(item.weeks).sort((a, b) => a - b) }))
      .sort((a, b) => (b.year - a.year) || (b.term - a.term));

    const latest = terms[0]
      ? { year: terms[0].year, term: terms[0].term, week: terms[0].weeks[terms[0].weeks.length - 1] ?? null }
      : null;

    return res.json({ terms, latest });
  } catch (e) {
    return sendFirestoreError(res, e, "failed to list student terms");
  }
});

// Student: weekly detail across the current term (scan the term’s snapshots for this externalId)
app.get("/api/me/term", requireAuth("student"), async (req, res) => {
  try {
    res.set("Cache-Control", "no-store");
    const schoolRef = db.collection("schools").doc(SCHOOL_ID);
    const userDoc = await schoolRef.collection("users").doc(req.user.uid).get();
    if (!userDoc.exists) return res.status(404).json({ error: "no user profile" });
    const externalId = userDoc.get("externalId");
    if (!externalId) return res.status(404).json({ error: "no student id on profile" });

    // Determine which term: explicit ?term=YYYY-Tn or latest
    let termParam = String(req.query.term || "").trim();
    let year = null, term = null;
    if (termParam && /^20\d{2}-T[1-4]$/.test(termParam)) {
      const parts = termParam.split("-T");
      year = Number(parts[0]); term = Number(parts[1]);
    } else {
      const schoolDoc = await schoolRef.get();
      const latestSnapshotId = schoolDoc.get("latestSnapshotId");
      if (!latestSnapshotId) return res.status(404).json({ error: "no snapshot yet" });
      const snapDoc = await schoolRef.collection("snapshots").doc(latestSnapshotId).get();
      year = snapDoc.get("year") ?? null;
      term = snapDoc.get("term") ?? null;
      termParam = year && term ? `${year}-T${term}` : (snapDoc.get("label") ?? "current term");
    }

    // Fetch all snapshots in this term (max ~12 weeks)
    const snapsQS = await schoolRef.collection("snapshots")
      .where("year", "==", year)
      .where("term", "==", term)
      .get();

    // For each snapshot (week), read this student’s row (doc id = externalId)
    const weeks = {};
    for (const d of snapsQS.docs) {
      const w = d.get("week");
      if (!Number.isInteger(w)) continue;
      const rowRef = d.ref.collection("rows").doc(String(externalId).replace(/\//g,"_"));
      const rowDoc = await rowRef.get();
      if (rowDoc.exists) {
        const currentWindowDates = d.get("currentWindowDates") || [];
        weeks[`W${String(w).padStart(2,"0")}`] = {
          weekStart: currentWindowDates[0] || null,
          percent: rowDoc.get("pctAttendance") ?? null,
          absences: null,
          lates: rowDoc.get("lateDays") ?? null,
          trend: rowDoc.get("trend") ?? null
        };
      }
    }

    return res.json({
      term: termParam,
      version: `live-term-${year}-T${term}`,
      weeks
    });
  } catch (e) {
    return sendFirestoreError(res, e, "failed to load weekly data");
  }
});


// GET latest snapshot meta
app.get("/api/snapshots/latest/meta", requireAuth("teacher"), async (req, res) => {
  try {
    const schoolDoc = await db.collection("schools").doc(SCHOOL_ID).get();
    const latestSnapshotId = schoolDoc.get("latestSnapshotId") || null;
    if (!latestSnapshotId) return res.json({ snapshotId: null, uploadedAt: null });

    const snapDoc = await db
      .collection("schools")
      .doc(SCHOOL_ID)
      .collection("snapshots")
      .doc(latestSnapshotId)
      .get();

    res.json({
      snapshotId: latestSnapshotId,
      uploadedAt: snapDoc.exists ? snapDoc.get("uploadedAt") || null : null,
      year: snapDoc.get("year") ?? null,
      term: snapDoc.get("term") ?? null,
      week: snapDoc.get("week") ?? null,
      label: snapDoc.get("label") ?? null
    });
  } catch (e) {
    res.status(500).json({ error: "failed to fetch latest snapshot meta" });
  }
});


// GET list of classes present in latest snapshot
app.get("/api/snapshots/latest/classes", requireAuth("teacher"), async (req, res) => {
  try {
    const schoolDoc = await db.collection("schools").doc(SCHOOL_ID).get();
    const latestSnapshotId = schoolDoc.get("latestSnapshotId");
    if (!latestSnapshotId) return res.json([]);

    const rowsRef = db.collection("schools").doc(SCHOOL_ID)
      .collection("snapshots").doc(latestSnapshotId)
      .collection("rows");

    // Fetch all rows (small dataset) and dedupe rollClass values
    const snap = await rowsRef.get();
    const set = new Set();
    snap.forEach(doc => {
      const rc = doc.get("rollClass");
      if (rc && isSupportedRollClass(rc)) set.add(rc);
    });
    res.json(Array.from(set).sort().map(rollClass => ({ rollClass })));
  } catch (e) {
    res.status(500).json({ error: "failed to list classes" });
  }
});



app.get("/api/snapshots/latest/classes/:rollClass/rows", requireAuth("teacher"), async (req, res) => {
  const { rollClass } = req.params;
  try {
    const schoolDoc = await db.collection("schools").doc(SCHOOL_ID).get();
    const latestSnapshotId = schoolDoc.get("latestSnapshotId");
    if (!latestSnapshotId) return res.json([]);

    const rowsRef = db.collection("schools").doc(SCHOOL_ID)
      .collection("snapshots").doc(latestSnapshotId)
      .collection("rows");

    const qs = await rowsRef.where("rollClass", "==", rollClass).get();

    const rows = qs.docs.map(d => ({
      externalId: d.get("externalId"),
      pctAttendance: d.get("pctAttendance"),
      trend: d.get("trend") ?? null,
      trendMeta: d.get("trendMeta") ?? null,
    }));

    // Join aliases from roster
    const aliasById = await fetchAliasMapForIds(rows.map(r => r.externalId));

    const data = rows.map(r => ({
      ...r,
      alias: aliasById.get(String(r.externalId)) ?? null,
    }));

    res.json(data);
  } catch (e) {
    res.status(500).json({ error: "failed to fetch class rows" });
  }
});

// List all available terms (grouped by year/term), with the weeks present
app.get("/api/terms", requireAuth("teacher"), async (req, res) => {
  try {
    const snaps = await db
      .collection("schools")
      .doc(SCHOOL_ID)
      .collection("snapshots")
      .get();

    const byTerm = new Map(); // key = `${year}-${term}` → {year, term, weeks:Set}
    snaps.forEach((d) => {
      const y = d.get("year");
      const t = d.get("term");
      const w = d.get("week");
      if (!Number.isInteger(y) || !Number.isInteger(t) || !Number.isInteger(w)) return;
      const key = `${y}-${t}`;
      const cur = byTerm.get(key) || { year: y, term: t, weeks: new Set() };
      cur.weeks.add(w);
      byTerm.set(key, cur);
    });

    const terms = Array.from(byTerm.values()).map((v) => ({
      year: v.year,
      term: v.term,
      weeks: Array.from(v.weeks).sort((a, b) => a - b),
    }));

    // Sort newest first: by year desc, then term desc
    terms.sort((a, b) => (b.year - a.year) || (b.term - a.term));
    res.json(terms);
  } catch (e) {
    return sendFirestoreError(res, e, "failed to list terms");
  }
});

// List roll classes for a specific year/term (union across that term's snapshots)
// List roll classes for a specific year/term using ONE snapshot (low read cost)
app.get("/api/terms/:year/:term/classes", requireAuth("teacher"), async (req, res) => {
  try {
    const year = Number(req.params.year);
    const term = Number(req.params.term);
    if (!Number.isInteger(year) || ![1, 2, 3, 4].includes(term)) {
      return res.status(400).json({ error: "invalid year/term" });
    }

    // Get all snapshots for the term, then pick the most recent week
    const snapsQS = await db
      .collection("schools").doc(SCHOOL_ID)
      .collection("snapshots")
      .where("year", "==", year)
      .where("term", "==", term)
      .get();

    let latestDoc = null, bestWeek = -Infinity;
    snapsQS.forEach(d => {
      const w = d.get("week");
      if (Number.isInteger(w) && w > bestWeek) { bestWeek = w; latestDoc = d; }
    });

    if (!latestDoc) return res.json([]);

    // Fast path: use snapshot-level classList if present
    const existing = latestDoc.get("classList");
    if (Array.isArray(existing) && existing.length) {
      return res.json(
        existing
          .filter(isSupportedRollClass)
          .slice()
          .sort()
          .map(rollClass => ({ rollClass }))
      );
    }

    // Slow path (first run / older snapshots): scan rows in THIS ONE snapshot, then seed classList
    const rowsSnap = await latestDoc.ref.collection("rows").select("rollClass").get();
    const set = new Set();
    rowsSnap.forEach(r => {
      const rc = r.get("rollClass");
      if (rc && isSupportedRollClass(rc)) set.add(rc);
    });
    const classes = Array.from(set).sort();

    // Seed classList for future fast reads
    await latestDoc.ref.set({ classList: classes }, { merge: true });

    return res.json(classes.map(rollClass => ({ rollClass })));
  } catch (e) {
    console.error("term classes failed:", e);
    // Map Firestore quota errors to 429 to make the client message clearer
    const msg = (e && (e.details || e.message || "")).toLowerCase();
    if (e?.code === 8 || msg.includes("quota")) {
      return res.status(429).json({ error: "quota exceeded" });
    }
    return res.status(500).json({ error: "failed to list term classes" });
  }
});


// For a given year/term + class, return a rollup table across weeks (max 12)
// For a given year/term + class, return a rollup table across weeks (max 12)
app.get("/api/terms/:year/:term/classes/:rollClass/rollup", requireAuth("teacher"), async (req, res) => {
  try {
    const year = Number(req.params.year);
    const term = Number(req.params.term);
    const rollClass = req.params.rollClass; // express decodes %20 etc.
    if (!Number.isInteger(year) || ![1,2,3,4].includes(term) || !rollClass) {
      return res.status(400).json({ error: "invalid parameters" });
    }

    // Query without orderBy to avoid composite index; sort weeks in JS
    const snapsQS = await db
      .collection("schools").doc(SCHOOL_ID)
      .collection("snapshots")
      .where("year", "==", year)
      .where("term", "==", term)
      .get();

    // Build list of { week, ref } and sort by week
    const weekRefs = [];
    snapsQS.forEach(d => {
      const w = d.get("week");
      if (Number.isInteger(w)) weekRefs.push({ week: w, ref: d.ref });
    });
    weekRefs.sort((a, b) => a.week - b.week);

    // Cap at 12 weeks and extract week numbers for the header order
    const limited = weekRefs.slice(0, 12);
    const weeks = limited.map(x => x.week);

    // Build student → per-week map
    const byStudent = new Map(); // externalId → { externalId, weeks: { [week]: { pct, trend, meta } } }

    for (const { week, ref } of limited) {
      const qs = await ref.collection("rows")
        .where("rollClass", "==", rollClass)
        .select("externalId", "pctAttendance", "trend", "trendMeta")
        .get();

      qs.forEach(r => {
        const id = r.get("externalId");
        if (!id) return;
        const pct = r.get("pctAttendance");
        const cur = byStudent.get(id) || { externalId: id, weeks: {} };
        cur.weeks[week] = {
          pct: (typeof pct === "number") ? pct : null,
          trend: r.get("trend") ?? null,
          meta: r.get("trendMeta") ?? null,
        };
        byStudent.set(id, cur);
      });
    }

    // ---- Join roster aliases (doc id = externalId with / replaced) ----
    const ids = Array.from(byStudent.keys()).map(id => String(id));
    const aliasById = new Map();

    if (ids.length) {
      const refs = ids.map(id => {
        const docId = String(id).replace(/\//g, "_");
        return db.collection("schools").doc(SCHOOL_ID).collection("roster").doc(docId);
      });

      // Firestore Admin SDK supports getAll(...refs)
      const snaps = await db.getAll(...refs);
      snaps.forEach((docSnap, idx) => {
        const id = ids[idx];
        const alias = docSnap.exists ? (docSnap.get("alias") ?? null) : null;
        if (alias) aliasById.set(String(id), String(alias));
      });
    }

    const rows = Array.from(byStudent.values())
      .map(s => ({
        externalId: s.externalId,
        alias: aliasById.get(String(s.externalId)) ?? null,
        avatar: null,     // placeholder for future image URL
        trend: null,      // placeholder for future badge
        weekValues: weeks.map(w => (s.weeks[w]?.pct ?? null)),
        weekTrends: weeks.map(w => (s.weeks[w]?.trend ?? null)),
        weekTrendMeta: weeks.map(w => (s.weeks[w]?.meta ?? null)),
      }));

    res.json({ year, term, rollClass, weeks, rows });


  } catch (e) {
    console.error("term rollup failed:", e);
    res.status(500).json({ error: "failed to build rollup" });
  }
});

// --- Roster upload (admin): email ↔ studentId seeding for student sign-in ---
const ROSTER_HEADERS = {
  studentId: ["Student ID","StudentId","External id","ExternalId","ID","Sentral ID","SentralID"],
  email: ["Email","Email Address","E-mail","EmailAddress"],
  surname: ["Surname","Last Name","LastName","Family Name","FamilyName"],
  givenNames: ["Given Names","Given Name","First Name","FirstName","GivenNames","FirstNames"],
  rollClass: [
    "Roll Class","RollClass","Roll class name","Rollclass name","Roll group","RollGroup",
    "Class","Homegroup","Rollclass"
  ],
  alias: ["Alias","alias","Student Alias","StudentAlias","Pseudonym","Nickname"],
};

app.post("/api/roster/upload", requireAuth("admin"), upload.single("file"), async (req, res) => {
  try {
    if (!admin || !db) return res.status(503).json({ error: "auth not initialised on server" });
    if (!req.file || !req.file.buffer) return res.status(400).json({ error: "missing file" });

    // Parse CSV
    const text = req.file.buffer.toString("utf8");
    const rows = parse(text, { columns: true, skip_empty_lines: true, bom: true });
    if (!rows.length) return res.status(400).json({ error: "empty CSV" });

    // Header detection
    const headers = Object.keys(rows[0]);
    const hId    = findHeader(headers, ROSTER_HEADERS.studentId);
    const hMail  = findHeader(headers, ROSTER_HEADERS.email);
    const hSur   = findHeader(headers, ROSTER_HEADERS.surname);
    const hGiven = findHeader(headers, ROSTER_HEADERS.givenNames);
    const hRC    = findHeader(headers, ROSTER_HEADERS.rollClass);
    const hAlias = findHeader(headers, ROSTER_HEADERS.alias); // optional

    if (!hId || !hMail || !hSur || !hGiven || !hRC) {
      return res.status(400).json({
        error: "missing required columns",
        required: ["Student ID","Email","Surname","Given Names","Roll Class"],
        found: headers
      });
    }

    const schoolRef = db.collection("schools").doc(SCHOOL_ID);
    const rosterColl = schoolRef.collection("roster");
    const lookupColl = schoolRef.collection("email_lookup");

    // Detect duplicate/malformed inputs in-memory first
    const seenEmailToId = new Map();
    const warnings = { duplicateEmails: [], missingId: 0, missingEmail: 0, skippedUnsupportedRollClass: 0 };

    // Prepare batched writes
    let batch = db.batch();
    let inBatch = 0, writtenRoster = 0, writtenLookup = 0;

    function commitIfNeeded(force=false) {
      if (inBatch >= 500 || force) {
        const b = batch; // capture
        batch = db.batch();
        inBatch = 0;
        return b.commit();
      }
      return Promise.resolve();
    }

    for (const r of rows) {
      const studentIdRaw = String(r[hId] ?? "").trim();
      const emailRaw = String(r[hMail] ?? "").trim();
      const surname = String(r[hSur] ?? "").trim();
      const given = String(r[hGiven] ?? "").trim();
      const rollClass = String(r[hRC] ?? "").trim();

      if (!studentIdRaw) { warnings.missingId++; continue; }
      if (!emailRaw)     { warnings.missingEmail++; continue; }
      if (!isSupportedRollClass(rollClass)) { warnings.skippedUnsupportedRollClass++; continue; }

      // Some rows have multiple emails; split on , ; whitespace
      const emails = emailRaw.split(/[,\s;]+/).map(e => e.toLowerCase()).filter(Boolean);
      const docId = studentIdRaw.replace(/\//g, "_");

      // Upsert roster doc (merge emails)
      const rosterRef = rosterColl.doc(docId);

      // Optional alias (do NOT overwrite an existing alias unless a non-empty alias is provided)
      const aliasRaw = hAlias ? String(r[hAlias] ?? "").trim() : "";
      const rosterPayload = {
        surname,
        givenNames: given,
        rollClass,
        emails,
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      };

      // Only set alias if the CSV actually includes the alias column AND the cell is non-empty
      if (hAlias && aliasRaw) {
        rosterPayload.alias = aliasRaw;
      }

      batch.set(rosterRef, rosterPayload, { merge: true });
      writtenRoster++; inBatch++;

      // Build email_lookup documents
      for (const em of emails) {
        const prev = seenEmailToId.get(em);
        if (prev && prev !== docId) {
          warnings.duplicateEmails.push({ email: em, firstId: prev, secondId: docId });
          // continue; // keep first mapping, skip conflicting second
          // (Alternatively: overwrite last-writer-wins; keeping first is safer)
          continue;
        }
        seenEmailToId.set(em, docId);

        const lookRef = lookupColl.doc(em);
        batch.set(lookRef, {
          studentId: docId,
          updatedAt: admin.firestore.FieldValue.serverTimestamp()
        }, { merge: true });
        writtenLookup++; inBatch++;
      }

      if (inBatch >= 500) await commitIfNeeded();
    }
    await commitIfNeeded(true);

    // Log a minimal upload record (optional)
    await schoolRef.collection("roster_uploads").add({
      filename: req.file.originalname || "roster.csv",
      uploadedAt: admin.firestore.FieldValue.serverTimestamp(),
      uploadedBy: req.user.uid,
      rowCount: rows.length,
      writtenRoster,
      writtenLookup,
      warnings,
    });

    // If there are hard conflicts, surface them but still 200 OK (admin can resolve)
    return res.json({
      ok: true,
      rowCount: rows.length,
      writtenRoster,
      writtenLookup,
      warnings,
      note: (warnings.duplicateEmails.length
        ? "Some emails map to multiple student IDs; these were skipped on the second occurrence."
        : "All rows processed.")
    });
  } catch (e) {
    return sendFirestoreError(res, e, "roster upload failed");
  }
});


app.listen(PORT, () => {
  console.log(`attendance-api listening on ${PORT}`);
});
