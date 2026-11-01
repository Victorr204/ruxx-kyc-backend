// File: api/kyc/autoapprove.js — daily cron that approves submissions whose
// 60-second review window elapsed while nobody had the app open, so an
// approved identity never depends on the user polling. The app's
// /api/kyc/status endpoint applies the same approval lazily on read (the
// primary path, effectively instant while the app is open); this worker is
// the background safety net. The schedule is daily because Vercel's Hobby
// plan rejects cron expressions that run more than once per day.
import { getDatabases } from "../../lib/appwrite.js";
import { Query } from "node-appwrite";
import { autoApproveIfDue } from "../../lib/kycReview.js";

function authOk(req) {
  const secret = process.env.CRON_SECRET;
  // Fail closed — without a configured secret this endpoint could approve
  // accounts, so it stays shut instead of open.
  if (!secret) return false;
  const header = req.headers?.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : header;
  return token === secret || req.headers?.["x-cron-secret"] === secret;
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ message: "Method not allowed" });
  }
  if (!authOk(req)) {
    return res.status(401).json({ message: "Unauthorized" });
  }

  try {
    const databases = getDatabases();
    const nowIso = new Date().toISOString();
    const due = await databases.listDocuments(
      process.env.DATABASE_ID,
      process.env.KYC_COLLECTION_ID,
      [
        Query.equal("status", "pending"),
        Query.notEqual("autoApproveAt", ""),
        Query.lessThanEqual("autoApproveAt", nowIso),
        Query.orderAsc("autoApproveAt"),
        Query.limit(20),
      ]
    );

    let approved = 0;
    const errors = [];
    for (const doc of due.documents) {
      try {
        const flipped = await autoApproveIfDue(doc);
        if (flipped) approved += 1;
      } catch (err) {
        errors.push(`${doc.$id}: ${err.message}`);
      }
    }

    return res.json({ ok: true, at: nowIso, due: due.total, approved, errors });
  } catch (error) {
    console.error("KYC autoapprove error:", error?.message || error);
    return res.status(500).json({ message: "Auto-approve run failed" });
  }
}
