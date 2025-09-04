const express = require("express");
const cors = require("cors");

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
    } catch {
      return res.status(500).json({ error: "role lookup failed" });
    }
  };
}


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

    const snapDoc = await db.collection("schools").doc(SCHOOL_ID)
      .collection("snapshots").doc(latestSnapshotId).get();

    res.json({
      snapshotId: latestSnapshotId,
      uploadedAt: snapDoc.exists ? snapDoc.get("uploadedAt") || null : null
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

// GET all rows for a class in latest snapshot (externalId + pctPresent only)
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
      pctPresent: d.get("pctPresent")
    }));
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: "failed to fetch class rows" });
  }
});

app.listen(PORT, () => {
  console.log(`attendance-api listening on ${PORT}`);
});
