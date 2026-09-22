import { databases } from "../../lib/appwrite.js";
import { verifyAdmin } from "../../../paystack-backend/lib/auth.js";

const VALID_ACTIONS = ["approve", "reject", "reverify"];

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ message: "Method not allowed" });
  }

  // 1️⃣ Verify admin authentication
  try {
    await verifyAdmin(req);
  } catch (err) {
    return res.status(err.status || 401).json({ success: false, message: err.message || "Unauthorized" });
  }

  try {
    const { documentId, action = "approve", level = 3, reason = "" } = req.body;

    if (!documentId) {
      return res.status(400).json({ success: false, message: "Document ID is required" });
    }

    if (!VALID_ACTIONS.includes(action)) {
      return res.status(400).json({
        success: false,
        message: `Invalid action. Must be one of: ${VALID_ACTIONS.join(", ")}`,
      });
    }

    const doc = await databases.getDocument(
      process.env.DATABASE_ID,
      process.env.KYC_COLLECTION_ID,
      documentId
    );

    if (!doc) {
      return res.status(404).json({ success: false, message: "KYC document not found" });
    }

    let updatePayload = { updatedAt: new Date().toISOString() };

    if (action === "approve") {
      if (level < 1 || level > 3) {
        return res.status(400).json({ success: false, message: "Verification level must be between 1 and 3" });
      }
      updatePayload = {
        ...updatePayload,
        verified: true,
        status: "approved",
        verificationLevel: level,
        reviewedAt: new Date().toISOString(),
        reviewNote: reason || "Approved by admin",
      };
    } else if (action === "reject") {
      updatePayload = {
        ...updatePayload,
        verified: false,
        status: "rejected",
        verificationLevel: 0,
        reviewedAt: new Date().toISOString(),
        reviewNote: reason || "Rejected by admin",
      };
    } else if (action === "reverify") {
      updatePayload = {
        ...updatePayload,
        verified: false,
        status: "pending",
        verificationLevel: 0,
        reviewedAt: new Date().toISOString(),
        reviewNote: reason || "Sent for re-verification",
      };
    }

    await databases.updateDocument(
      process.env.DATABASE_ID,
      process.env.KYC_COLLECTION_ID,
      documentId,
      updatePayload
    );

    res.json({
      success: true,
      message: `KYC ${action === "approve" ? "approved" : action === "reject" ? "rejected" : "sent for re-verification"}`,
    });
  } catch (error) {
    console.error("KYC approve error:", error.message);
    res.status(500).json({ success: false, message: "Server error" });
  }
}
