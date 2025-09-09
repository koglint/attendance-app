// Node 18+, CommonJS
const { initializeApp } = require("firebase-admin/app");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");
const { beforeUserCreated, beforeUserSignedIn } = require("firebase-functions/v2/identity");
const logger = require("firebase-functions/logger");

initializeApp();
const db = getFirestore();

// Configure these via env if you like
const SCHOOL_ID = process.env.SCHOOL_ID || "default";
const ALLOWED_EMAIL_DOMAIN = process.env.ALLOWED_EMAIL_DOMAIN || "education.nsw.gov.au";

async function lookupAllowlist(emailRaw) {
  const email = (emailRaw || "").toLowerCase();
  if (!email) return null;
  const ref = db.collection("schools").doc(SCHOOL_ID)
                .collection("email_lookup").doc(email);
  const snap = await ref.get();
  if (!snap.exists) return null;

  // You already store { studentId } from roster upload
  const studentId = snap.get("studentId") || null;
  // (Optionally support a role field later)
  return studentId ? { studentId } : null;
}

// Block account creation for anyone not in email_lookup
exports.gateBeforeCreate = beforeUserCreated(
  { region: "australia-southeast1", timeoutSeconds: 10 /* add scaling later */ },
  async (event) => {
    const email = (event.data.email || "").toLowerCase();
    if (!email) throw new Error("email-required");

    // Hard domain check (cheap fast-fail)
    if (!email.endsWith(`@${ALLOWED_EMAIL_DOMAIN}`)) {
      logger.warn("Blocked signup: wrong domain", { email });
      throw new Error("wrong-domain");
    }

    const allow = await lookupAllowlist(email);
    if (!allow) {
      logger.warn("Blocked signup: not enrolled", { email });
      throw new Error("not-enrolled");
    }

    // Auto-provision the user profile your backend expects
    const uid = event.data.uid;
    const userRef = db.collection("schools").doc(SCHOOL_ID)
                      .collection("users").doc(uid);

    await userRef.set({
      role: "student",
      externalId: allow.studentId,
      email,
      createdAt: FieldValue.serverTimestamp(),
    }, { merge: true });

    // Allow creation
    return;
  }
);

// Re-check on every sign-in (still cheap: 1 read). Attach session claims.
exports.gateBeforeSignIn = beforeUserSignedIn(
  { region: "australia-southeast1", timeoutSeconds: 10 },
  async (event) => {
    const email = (event.data.email || "").toLowerCase();
    const uid = event.data.uid;
    if (!email) throw new Error("email-required");

    if (!email.endsWith(`@${ALLOWED_EMAIL_DOMAIN}`)) {
      logger.warn("Blocked sign-in: wrong domain", { email, uid });
      throw new Error("wrong-domain");
    }

    const allow = await lookupAllowlist(email);
    if (!allow) {
      logger.warn("Blocked sign-in: not enrolled", { email, uid });
      throw new Error("not-enrolled");
    }

    const userRef = db.collection("schools").doc(SCHOOL_ID)
                      .collection("users").doc(uid);
    const userDoc = await userRef.get();
    const suspended = userDoc.exists ? !!userDoc.get("suspended") : false;
    if (suspended) {
      logger.warn("Blocked sign-in: suspended", { email, uid });
      throw new Error("account-suspended");
    }

    const role = (userDoc.get && userDoc.get("role")) || "student";

    // Session claims are handy for your backend or client-side gating
    return {
      sessionClaims: {
        role,
        schoolId: SCHOOL_ID,
        studentId: allow.studentId,
      }
    };
  }
);
