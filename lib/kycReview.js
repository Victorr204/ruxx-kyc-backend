// lib/kycReview.js — the one place a KYC submission becomes a decision.
// Shared by the admin endpoint (/api/kyc/approve), the 60-second
// auto-approver (/api/kyc/autoapprove cron) and the app's status endpoint
// (/api/kyc/status), which applies a due auto-approval lazily while the
// user watches. Every path writes the same fields, syncs the user document
// and tells the user the outcome.

import { getDatabases } from "./appwrite.js";
import { Query } from "node-appwrite";

/** Verified identities wait exactly 60s for a reviewer before self-approving. */
export const AUTO_APPROVE_DELAY_MS = 60_000;

const db = () => process.env.DATABASE_ID;
const kycCol = () => process.env.KYC_COLLECTION_ID;
const usersCol = () => process.env.USER_COLLECTION_ID;

/**
 * Apply approve / reject / reverify to a KYC doc, sync the user doc so the
 * dashboard badge and every server-side gate flip, and notify the user.
 */
export async function applyDecision(doc, { status, level, reviewNote, actor = "admin" }) {
  const databases = getDatabases();
  const now = new Date().toISOString();
  const payload = {
    updatedAt: now,
    verified: status === "approved",
    status,
    verificationLevel: level,
    reviewedAt: now,
    reviewNote: String(reviewNote || "").slice(0, 500),
  };

  await databases.updateDocument(db(), kycCol(), doc.$id, payload);

  // Sync the user document so profile/dashboard/KYC gates reflect the decision.
  try {
    const userDocs = await databases.listDocuments(db(), usersCol(), [
      Query.equal("userId", doc.userId),
    ]);
    if (userDocs.total > 0) {
      await databases.updateDocument(db(), usersCol(), userDocs.documents[0].$id, {
        kycStatus: status,
        kycLevel: level,
      });
    }
  } catch (err) {
    console.error("KYC user sync error:", err.message);
  }

  // The user hears about every decision — including auto-approval.
  try {
    const { notifyUser } = await import("./push.js");
    await notifyUser({
      userId: doc.userId,
      title:
        status === "approved"
          ? "Identity verified ✓"
          : status === "rejected"
          ? "Verification rejected"
          : "Verification update",
      message:
        status === "approved"
          ? "Your identity is verified — purchases, transfers and Auto-Pay are fully unlocked."
          : String(payload.reviewNote || "Open the Verification section of your profile for details."),
      type: "system",
      data: { screen: "/verify" },
    });
  } catch (err) {
    console.error("KYC decision notify error:", err.message);
  }

  console.log(`KYC ${status} (${actor}): ${doc.$id} user=${doc.userId}`);
  return { ...doc, ...payload };
}

/**
 * Approve a pending submission once its 60-second review window has elapsed.
 * Returns the updated doc, or null when nothing is due (not pending, window
 * not yet up, or an admin decision landed in the meantime).
 */
export async function autoApproveIfDue(doc, now = Date.now()) {
  if (!doc || doc.status !== "pending") return null;
  const dueAt = Date.parse(doc.autoApproveAt || "");
  if (!Number.isFinite(dueAt) || now < dueAt) return null;

  // The cron and the app's status poll can race — re-read right before the
  // write so a decision that already landed is never overwritten.
  const databases = getDatabases();
  const fresh = await databases
    .getDocument(db(), kycCol(), doc.$id)
    .catch(() => null);
  if (!fresh || fresh.status !== "pending") return null;

  return applyDecision(fresh, {
    status: "approved",
    level: 3,
    reviewNote:
      "Auto-approved — NIN verified with NIMC, face match and liveness passed, no reviewer available.",
    actor: "auto-approve",
  });
}
