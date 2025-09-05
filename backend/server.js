const express = require("express");
const cors = require("cors");
const multer = require("multer");
const { parse } = require("csv-parse/sync");
const crypto = require("crypto");


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
const REQUIRED_HEADERS = {
  externalId: [
    "External id","ExternalId","Student ID","StudentId",
    "External_id","ExternalID","ID","SentralId","Sentral ID"
  ],
  rollClass: [
    "Rollclass name","Rollclass","Roll class name","Roll class",
    "Class","Homegroup","RollGroup","Roll group","Roll Class"
  ],
  pctAttendance: [
    "Percentage Attendance", "Percentage attendance", "percentage attendance", "Percentage present","Percentage Present","Present %","% Present",
    "Attendance %","Attendance percent","Percent present"
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

// --- Trend helpers ---
const TREND = Object.freeze({
  DIAMOND: "diamond", // improved
  GOLD: "gold",       // maintained
  SILVER: "silver",   // lower
});
const TREND_EPSILON = 0.1; // tolerance (percentage points)

/** Compare two 0–100 percentages and return a TREND or null if not computable. */
function compareTrend(curr, prev, eps = TREND_EPSILON) {
  if (Number.isFinite(curr) && Number.isFinite(prev)) {
    if (curr - prev > eps) return TREND.DIAMOND;
    if (prev - curr > eps) return TREND.SILVER;
    return TREND.GOLD;
  }
  return null;
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


// Admin upload: accepts CSV and writes a new snapshot
app.post("/api/uploads", requireAuth("admin"), upload.single("file"), async (req, res) => {
  try {
    if (!admin || !db) return res.status(503).json({ error: "auth not initialised on server" });
    if (!req.file || !req.file.buffer) return res.status(400).json({ error: "missing file" });

    // Year/Term/Week (from form fields sent by the admin page)
    const year = Number(req.body?.year);
    const term = Number(req.body?.term);
    const week = Number(req.body?.week);
    if (!Number.isInteger(year) || year < 2000 || year > 2100) {
      return res.status(400).json({ error: "invalid year" });
    }
    if (![1, 2, 3, 4].includes(term)) {
      return res.status(400).json({ error: "invalid term (1–4)" });
    }
    if (!Number.isInteger(week) || week < 1 || week > 12) {
      return res.status(400).json({ error: "invalid week (1–12)" });
    }
    const label = `${year} Term ${term} Week ${week}`;

    // Checksums (info/diagnostics)
    const contentChecksum = crypto.createHash("sha256").update(req.file.buffer).digest("hex");
    const compoundChecksum = crypto
      .createHash("sha256")
      .update(req.file.buffer)
      .update("|")
      .update(label)
      .digest("hex");

    const schoolRef = db.collection("schools").doc(SCHOOL_ID);
    const uploadsColl = schoolRef.collection("uploads");
    const snapsColl = schoolRef.collection("snapshots");

    // Parse CSV
    const text = req.file.buffer.toString("utf8");
    const records = parse(text, { columns: true, skip_empty_lines: true, bom: true });
    if (!records.length) return res.status(400).json({ error: "empty CSV" });

    // Header detection
    const headers = Object.keys(records[0]);
    const hExternal = findHeader(headers, REQUIRED_HEADERS.externalId);
    const hClass = findHeader(headers, REQUIRED_HEADERS.rollClass);
    const hPct = findHeader(headers, REQUIRED_HEADERS.pctAttendance);
    if (!hExternal || !hClass || !hPct) {
      return res.status(400).json({
        error: "missing required columns",
        required: ["External id", "Rollclass name", "Percentage Attendance"],
        found: headers
      });
    }

    // Create upload record (status: processing)
    const uploadRef = uploadsColl.doc();
    await uploadRef.set({
      filename: req.file.originalname || "upload.csv",
      contentChecksum,
      compoundChecksum,
      uploadedAt: admin.firestore.FieldValue.serverTimestamp(),
      uploadedBy: req.user.uid,
      rowCount: records.length,
      status: "processing",
      year,
      term,
      week,
      label
    });

    // Find existing snapshot by (year, term, week)
    const existingSnapQS = await snapsColl
      .where("year", "==", year)
      .where("term", "==", term)
      .where("week", "==", week)
      .limit(1)
      .get();

    let snapshotRef;
    let reusedExisting = false;

    // Collect rollClass values for this snapshot across both code paths
    const classSet = new Set();


    if (!existingSnapQS.empty) {
      // OVERWRITE path: reuse the existing snapshot doc for this label
      snapshotRef = existingSnapQS.docs[0].ref;
      reusedExisting = true;

      // Ensure snapshot doc carries current metadata (in case label changed casing etc.)
      await snapshotRef.set(
        {
          uploadedAt: admin.firestore.FieldValue.serverTimestamp(),
          uploadId: uploadRef.id,
          isLatest: false,
          year,
          term,
          week,
          label
        },
        { merge: true }
      );

      // Delete all existing rows under this snapshot
      const rowsColl = snapshotRef.collection("rows");
      while (true) {
        const toDelete = await rowsColl.limit(500).get();
        if (toDelete.empty) break;
        const batch = db.batch();
        toDelete.docs.forEach((d) => batch.delete(d.ref));
        await batch.commit();
      }
    } else {
      // NEW snapshot path
      snapshotRef = snapsColl.doc();
      await snapshotRef.set({
        uploadedAt: admin.firestore.FieldValue.serverTimestamp(),
        uploadId: uploadRef.id,
        isLatest: false,
        year,
        term,
        week,
        label
      });
    }

    // Build a map of previous week %s keyed by externalId (same Year/Term, latest week < current)
    const prevRef = await findPreviousSnapshotRef(db, schoolRef, year, term, week);
    const prevPctById = new Map();
    if (prevRef) {
    const prevSnap = await prevRef.collection("rows").select("externalId", "pctAttendance").get();
    prevSnap.forEach(d => {
        const id = d.get("externalId");
        const pct = d.get("pctAttendance");
        if (id && typeof pct === "number") prevPctById.set(String(id), pct);
    });
    }

    // Now write rows for the current snapshot, computing trend vs previous
    const rowsColl = snapshotRef.collection("rows");
    let batch = db.batch();
    let inBatch = 0;
    let written = 0;

    for (const r of records) {
      const externalIdRaw = String(r[hExternal] ?? "").trim();
      const rollClass = String(r[hClass] ?? "").trim();
      if (!externalIdRaw || !rollClass) continue;
      classSet.add(rollClass);

      const rawPct = String(r[hPct] ?? "").replace("%", "").trim();
      const pct = Number(rawPct);
      if (!Number.isFinite(pct)) continue;

      const docId = externalIdRaw.replace(/\//g, "_");
      const ref = rowsColl.doc(docId);

        const curr = clamp01(pct);
        const prev = prevPctById.get(externalIdRaw);
        const status = compareTrend(curr, prev);

        // Build row payload without using FieldValue.delete()
        const rowData = {
        externalId: externalIdRaw,
        rollClass,
        pctAttendance: curr,
        trend: status ?? null,
        };

        if (status) {
        rowData.trendMeta = {
            year,
            term,
            week,
            prev: Number.isFinite(prev) ? prev : null,
            curr,
            epsilon: TREND_EPSILON,
            version: "v1",
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        };
        }

        batch.set(ref, rowData, { merge: false });


      inBatch++;
      written++;
      if (inBatch === 500) {
        await batch.commit();
        batch = db.batch();
        inBatch = 0;
      }
    }
    if (inBatch) await batch.commit();

    // Make this snapshot "latest" (global pointer)
    await schoolRef.set({ latestSnapshotId: snapshotRef.id }, { merge: true });

    // Finalize
    await snapshotRef.set(
      {
        isLatest: true,
        classList: Array.from(classSet).sort(), // ← snapshot-level class list
      },
      { merge: true }
    );

    await uploadRef.update({
      status: "processed",
      snapshotId: snapshotRef.id,
      rowCount: written,
      reusedExisting
    });

    return res.json({
      uploadId: uploadRef.id,
      snapshotId: snapshotRef.id,
      rowCount: written,
      label,
      reusedExisting
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




// --- Health check ---
app.get("/healthz", (req, res) => {
  res.status(200).send("ok");
});

// --- Teacher endpoints (read-only): latest meta, classes, class rows ---

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
      if (rc) set.add(rc);
    });
    res.json(Array.from(set).sort().map(rollClass => ({ rollClass })));
  } catch (e) {
    res.status(500).json({ error: "failed to list classes" });
  }
});

// GET all rows for a class in latest snapshot (externalId + pctAttendance only)
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
    const data = qs.docs.map(d => ({
    externalId: d.get("externalId"),
    pctAttendance: d.get("pctAttendance"),
    trend: d.get("trend") ?? null
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
      return res.json(existing.slice().sort().map(rollClass => ({ rollClass })));
    }

    // Slow path (first run / older snapshots): scan rows in THIS ONE snapshot, then seed classList
    const rowsSnap = await latestDoc.ref.collection("rows").select("rollClass").get();
    const set = new Set();
    rowsSnap.forEach(r => { const rc = r.get("rollClass"); if (rc) set.add(rc); });
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
    const byStudent = new Map(); // externalId → { externalId, weeks: { [week]: pct } }

    for (const { week, ref } of limited) {
      const qs = await ref.collection("rows")
        .where("rollClass", "==", rollClass)
        .select("externalId", "pctAttendance")
        .get();

      qs.forEach(r => {
        const id = r.get("externalId");
        if (!id) return;
        const pct = r.get("pctAttendance");
        const cur = byStudent.get(id) || { externalId: id, weeks: {} };
        cur.weeks[week] = (typeof pct === "number") ? pct : null;
        byStudent.set(id, cur);
      });
    }

    const rows = Array.from(byStudent.values())
      .sort((a, b) => String(a.externalId).localeCompare(String(b.externalId)))
      .map(s => ({
        externalId: s.externalId,
        avatar: null,     // placeholder for future image URL
        trend: null,      // placeholder for future badge
        weekValues: weeks.map(w => (s.weeks[w] ?? null))
      }));

    res.json({ year, term, rollClass, weeks, rows });
  } catch (e) {
    console.error("term rollup failed:", e);
    res.status(500).json({ error: "failed to build rollup" });
  }
});



app.listen(PORT, () => {
  console.log(`attendance-api listening on ${PORT}`);
});
