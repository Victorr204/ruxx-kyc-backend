// File: api/kyc/status.js — the app's verification-status view, and the
// primary path of the 60-second auto-approval: while the user waits, this
// endpoint applies the due approval lazily (no cron needed), so the account
// flips to approved within seconds of its window elapsing.
import { getDatabases } from "../../lib/appwrite.js";
import { Query } from "node-appwrite";
import { verifySession } from "../../lib/auth.js";
import { autoApproveIfDue } from "../../lib/kycReview.js";

export default async function handler(req, res) {
  if (req.method !== "GET" && req.method !== "POST") {
    return res.status(405).json({ message: "Method not allowed" });
  }

  let user;
  try {
    user = await verifySession(req);
  } catch (err) {
    return res.status(err.status || 401).json({ message: err.message || "Unauthorized" });
  }

  try {
    const databases = getDatabases();
    const docs = await databases.listDocuments(
      process.env.DATABASE_ID,
      process.env.KYC_COLLECTION_ID,
      [Query.equal("userId", user.$id), Query.limit(1)]
    );
    const doc = docs.total ? docs.documents[0] : null;
    if (!doc) {
      return res.json({ ok: true, hasSubmission: false, status: null, verified: false });
    }

    let current = doc;
    let autoApproved = false;
    if (doc.status === "pending") {
      try {
        const flipped = await autoApproveIfDue(doc);
        if (flipped) {
          current = flipped;
          autoApproved = true;
        }
      } catch (err) {
        // Status must never fail because the approval path did.
        console.error("KYC status auto-approve error:", err.message);
      }
    }

    const dueAt = Date.parse(current.autoApproveAt || "");
    const pending = current.status === "pending";

    return res.json({
      ok: true,
      hasSubmission: true,
      status: current.status,
      verified: current.verified === true,
      verificationLevel: current.verificationLevel || 0,
      reviewNote: current.reviewNote || "",
      idType: current.idType || "",
      submittedAt: current.submittedAt || current.createdAt || "",
      reviewedAt: current.reviewedAt || "",
      autoApproved,
      autoApproveAt: pending && Number.isFinite(dueAt) ? current.autoApproveAt : null,
      autoApproveIn:
        pending && Number.isFinite(dueAt) ? Math.max(0, dueAt - Date.now()) : 0,
    });
  } catch (error) {
    console.error("KYC status error:", error?.message || error);
    return res.status(500).json({ message: "Failed to load verification status" });
  }
}
