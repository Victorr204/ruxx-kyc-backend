import { getDatabases } from "../../lib/appwrite.js";
import { ID, Query } from "node-appwrite";
import { verifySessionUser } from "../../lib/auth.js";

const VALID_ID_TYPES = ["local_id_nin", "national_id_card", "international_passport"];
const AI_LIVENESS_THRESHOLD = Number(process.env.AI_LIVENESS_THRESHOLD) || 0.75;
// Auto-approve is OFF unless explicitly enabled with KYC_AUTO_APPROVE=true
const AUTO_APPROVE_ENABLED = String(process.env.KYC_AUTO_APPROVE || "false").toLowerCase() === "true";

const parseMaybeJson = (value, fallback = {}) => {
  if (typeof value === "string") {
    try {
      return JSON.parse(value);
    } catch {
      return fallback;
    }
  }
  return value && typeof value === "object" ? value : fallback;
};

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ message: "Method not allowed" });
  }

  try {
    const {
      userId,
      fullName,
      idType,
      idDetails,
      imageUrl,
      selfieUrl,
      livenessUrls = [],
      livenessScores = {},
      aiLiveness = {},
    } = req.body;

    // --- Validate required fields ---
    if (!userId || !idType || !imageUrl || !selfieUrl) {
      return res.status(400).json({
        success: false,
        message: "Missing required fields: userId, idType, imageUrl, selfieUrl",
      });
    }

    // --- Authenticate: the session must belong to the submitted userId ---
    try {
      await verifySessionUser(req, userId);
    } catch (err) {
      return res
        .status(err.status || 401)
        .json({ success: false, message: err.message || "Unauthorized" });
    }

    const databases = getDatabases();

    if (!VALID_ID_TYPES.includes(idType)) {
      return res.status(400).json({
        success: false,
        message: `Invalid idType. Must be one of: ${VALID_ID_TYPES.join(", ")}`,
      });
    }

    if (!fullName || typeof fullName !== "string" || fullName.trim().length < 2) {
      return res.status(400).json({
        success: false,
        message: "Valid fullName is required",
      });
    }

    // --- Validate idDetails based on idType ---
    let details;
    try {
      details = typeof idDetails === "string" ? JSON.parse(idDetails) : idDetails;
    } catch {
      return res.status(400).json({ success: false, message: "Invalid idDetails format" });
    }

    if (idType === "local_id_nin") {
      if (!details?.ninNumber) {
        return res.status(400).json({ success: false, message: "NIN number is required" });
      }
    } else if (idType === "national_id_card") {
      if (!details?.idNumber || !details?.dob) {
        return res.status(400).json({ success: false, message: "ID number and DOB are required" });
      }
    } else if (idType === "international_passport") {
      if (!details?.passportNumber || !details?.dob || !details?.passportRegistrationDate || !details?.passportExpiration) {
        return res.status(400).json({
          success: false,
          message: "Passport number, DOB, registration date, and expiration are required",
        });
      }
    }

    // --- Validate liveness ---
    if (!livenessScores?.completed) {
      return res.status(400).json({
        success: false,
        message: "Liveness check must be completed",
      });
    }

    if (livenessScores?.passed === false) {
      return res.status(400).json({
        success: false,
        message: "Liveness check did not pass",
      });
    }

    if (livenessUrls.length < 2) {
      return res.status(400).json({
        success: false,
        message: "At least 2 liveness frames are required",
      });
    }

    const parsedAiLiveness = parseMaybeJson(aiLiveness);

    const livenessScore = Number(livenessScores?.score ?? parsedAiLiveness?.score) || 0;
    const livenessPassed =
      livenessScores?.passed === true || parsedAiLiveness?.passed === true;

    // --- Auto-verification candidate ---
    // Liveness runs fully in-app; every submission goes to admin review unless
    // KYC_AUTO_APPROVE=true is explicitly set.
    const clientCandidate = livenessPassed && livenessScore >= AI_LIVENESS_THRESHOLD;

    const autoApproved = AUTO_APPROVE_ENABLED && clientCandidate;

    // --- Check for existing KYC submission ---
    const existing = await databases.listDocuments(
      process.env.DATABASE_ID,
      process.env.KYC_COLLECTION_ID,
      [Query.equal("userId", userId)]
    );

    const nowIso = new Date().toISOString();

    const payload = {
      userId,
      fullName: fullName.trim(),
      idType,
      idDetails: JSON.stringify(details),
      imageUrl,
      selfieUrl,
      livenessUrls: JSON.stringify(livenessUrls),
      livenessScores: JSON.stringify({
        ...livenessScores,
        completed: true,
        passed: livenessScores?.passed !== false,
        aiLivenessPassed: livenessScores?.passed !== false,
        score: Number(livenessScores?.score) || 0,
        method: livenessScores?.method || "guided-capture",
        engine: livenessScores?.engine || "ruxx-ai",
        stepsPassed: Number(livenessScores?.stepsPassed) || livenessUrls.length + 1,
        eyeBlinkSeen: !!livenessScores?.eyeBlinkSeen,
        totalFrames: Number(livenessScores?.totalFrames) || livenessUrls.length + 1,
        promptCount: Number(livenessScores?.promptCount) || 5,
        aiAutoVerified: autoApproved,
        rawAiLiveness: parsedAiLiveness,
      }),
      verificationLevel: autoApproved ? 3 : 0,
      status: autoApproved ? "approved" : "pending",
      verified: autoApproved,
      aiLivenessPassed: livenessScores?.passed !== false,
      reviewNote: autoApproved
        ? `Auto-verified — liveness ${Math.round(livenessScore * 100)}%`
        : "",
      ...(autoApproved ? { reviewedAt: nowIso } : {}),
      submittedAt: nowIso,
      updatedAt: nowIso,
    };

    let action = "created";

    if (existing.total > 0) {
      // Check if currently approved — shouldn't resubmit
      const current = existing.documents[0];
      if (current.status === "approved" && current.verified) {
        return res.status(400).json({
          success: false,
          message: "KYC already approved. Contact support to re-verify.",
        });
      }

      await databases.updateDocument(
        process.env.DATABASE_ID,
        process.env.KYC_COLLECTION_ID,
        current.$id,
        payload
      );
      action = "updated";
    } else {
      await databases.createDocument(
        process.env.DATABASE_ID,
        process.env.KYC_COLLECTION_ID,
        ID.unique(),
        {
          ...payload,
          createdAt: nowIso,
        }
      );
    }

    // --- Sync the user document so profile/dashboard reflect KYC state ---
    try {
      const userDocs = await databases.listDocuments(
        process.env.DATABASE_ID,
        process.env.USER_COLLECTION_ID,
        [Query.equal("userId", userId)]
      );
      if (userDocs.total > 0) {
        await databases.updateDocument(
          process.env.DATABASE_ID,
          process.env.USER_COLLECTION_ID,
          userDocs.documents[0].$id,
          {
            kycStatus: autoApproved ? "approved" : "pending",
            kycLevel: autoApproved ? 3 : 0,
          }
        );
      }
    } catch (err) {
      console.error("KYC user sync error:", err.message);
    }

    res.json({
      success: true,
      action,
      autoApproved,
      message: autoApproved
        ? "Identity verified automatically. No further review needed."
        : action === "updated"
        ? "KYC updated — pending admin review."
        : "KYC submitted — pending admin review.",
    });
  } catch (error) {
    console.error("KYC submit error:", error);
    const isConfig = error && typeof error.message === "string" && error.message.startsWith("Server config error");
    res.status(error?.status || 500).json({
      success: false,
      message: isConfig ? error.message : "Server error",
    });
  }
}
