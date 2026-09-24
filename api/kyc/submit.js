import { databases } from "../../lib/appwrite.js";
import { ID, Query } from "appwrite";
import { verifySessionUser } from "../../lib/auth.js";
import { verifySubmissionWithAi, isAiConfigured } from "../../lib/openai.js";

const VALID_ID_TYPES = ["local_id_nin", "national_id_card", "international_passport"];
const AI_LIVENESS_THRESHOLD = Number(process.env.AI_LIVENESS_THRESHOLD) || 0.75;
const AI_FACE_MATCH_THRESHOLD = Number(process.env.AI_FACE_MATCH_THRESHOLD) || 0.72;
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
      aiFaceMatch = {},
      aiFaceMatchPassed,
      aiFaceMatchScore,
      stepActions = [],
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

    // --- Validate AI liveness ---
    if (!livenessScores?.completed) {
      return res.status(400).json({
        success: false,
        message: "Liveness check must be completed",
      });
    }

    if (livenessScores?.passed === false) {
      return res.status(400).json({
        success: false,
        message: "AI liveness check did not pass",
      });
    }

    if (livenessUrls.length < 2) {
      return res.status(400).json({
        success: false,
        message: "At least 2 liveness frames are required",
      });
    }

    const parsedAiLiveness = parseMaybeJson(aiLiveness);
    const parsedAiFaceMatch = parseMaybeJson(aiFaceMatch);

    // --- Validate AI face match (ID photo vs liveness face) ---
    const hasFaceMatchResult =
      typeof parsedAiFaceMatch.passed === "boolean" ||
      aiFaceMatchPassed !== undefined ||
      aiFaceMatchScore !== undefined;

    if (!hasFaceMatchResult) {
      return res.status(400).json({
        success: false,
        message: "AI face match must run before submitting (ID photo vs liveness face)",
      });
    }

    const faceMatchScore = Math.min(
      1,
      Math.max(0, Number(parsedAiFaceMatch.score ?? aiFaceMatchScore) || 0)
    );
    const faceMatchPassed =
      (parsedAiFaceMatch.passed === true || aiFaceMatchPassed === true) &&
      faceMatchScore >= AI_FACE_MATCH_THRESHOLD;

    const livenessScore = Number(livenessScores?.score ?? parsedAiLiveness?.score) || 0;
    const livenessPassed =
      livenessScores?.passed === true || parsedAiLiveness?.passed === true;

    // --- Inbuilt AI verification (OpenAI on server) ---
    // Re-checks uploaded liveness frames + ID face match before any auto-approve.
    let serverAi = null;
    let serverAiError = null;
    if (isAiConfigured()) {
      try {
        serverAi = await verifySubmissionWithAi({
          documentUrl: imageUrl,
          livenessUrls: [selfieUrl, ...livenessUrls].filter(Boolean),
          stepActions: Array.isArray(stepActions) ? stepActions : [],
        });
      } catch (err) {
        serverAiError = err.message || "Server AI verification failed";
        console.error("KYC server AI error:", serverAiError);
      }
    }

    const serverLivenessPassed = serverAi ? serverAi.livenessPassed : false;
    const serverFaceMatchPassed = serverAi ? !!serverAi.faceMatch?.passed : false;
    const serverAiPassed = serverAi ? serverAi.passed : false;

    // --- AI auto-verification candidate ---
    // Client scores alone are never enough: server AI must also pass when configured.
    // AUTO_APPROVE stays off unless KYC_AUTO_APPROVE=true.
    const clientCandidate =
      livenessPassed &&
      livenessScore >= AI_LIVENESS_THRESHOLD &&
      faceMatchPassed &&
      faceMatchScore >= AI_FACE_MATCH_THRESHOLD;

    const aiCandidate = isAiConfigured()
      ? serverAiPassed && serverLivenessPassed && serverFaceMatchPassed
      : clientCandidate;

    const autoApproved = AUTO_APPROVE_ENABLED && clientCandidate && aiCandidate;

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
        method: livenessScores?.method || "openai-vision",
        engine: livenessScores?.engine || "openai-gpt",
        stepsPassed: Number(livenessScores?.stepsPassed) || livenessUrls.length + 1,
        eyeBlinkSeen: !!livenessScores?.eyeBlinkSeen,
        totalFrames: Number(livenessScores?.totalFrames) || livenessUrls.length + 1,
        promptCount: Number(livenessScores?.promptCount) || 5,
        aiFaceMatchPassed: faceMatchPassed,
        aiFaceMatchScore: faceMatchScore,
        aiFaceMatchReason: parsedAiFaceMatch.reason || "",
        aiFaceMatchMethod: parsedAiFaceMatch.method || "openai-vision",
        aiAutoVerified: autoApproved,
        rawAiLiveness: parsedAiLiveness,
        rawAiFaceMatch: parsedAiFaceMatch,
        serverAiRan: isAiConfigured(),
        serverAiPassed: serverAiPassed,
        serverAiError: serverAiError || "",
        serverAi: serverAi
          ? {
              passed: serverAi.passed,
              livenessPassed: serverAi.livenessPassed,
              livenessScore: serverAi.livenessScore,
              faceMatch: serverAi.faceMatch,
              reason: serverAi.reason,
              method: serverAi.method,
              engine: serverAi.engine,
              verifiedAt: serverAi.verifiedAt,
            }
          : null,
      }),
      verificationLevel: autoApproved ? 3 : 0,
      status: autoApproved ? "approved" : "pending",
      verified: autoApproved,
      aiLivenessPassed: livenessScores?.passed !== false,
      reviewNote: autoApproved
        ? `Auto-verified by AI — liveness ${Math.round(livenessScore * 100)}% + ID face match ${Math.round(
            faceMatchScore * 100
          )}%${serverAi ? " + server OpenAI re-check passed" : ""}`
        : isAiConfigured() && serverAi && !serverAi.passed
        ? `Server AI: ${serverAi.reason}`
        : isAiConfigured() && serverAiError
        ? `Server AI error: ${serverAiError}`
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
        ? "Identity verified — OpenAI confirmed your liveness and ID face match. No further review needed."
        : isAiConfigured() && serverAi && !serverAi.passed
        ? `KYC submitted — server AI could not fully verify (${serverAi.reason}). Pending admin review.`
        : action === "updated"
        ? "KYC updated — pending admin review."
        : "KYC submitted — pending admin review.",
    });
  } catch (error) {
    console.error("KYC submit error:", error);
    res.status(500).json({ success: false, message: "Server error" });
  }
}
