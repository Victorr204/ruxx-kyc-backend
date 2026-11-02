import { getDatabases } from "../../lib/appwrite.js";
import { ID, Query } from "node-appwrite";
import { verifySessionUser } from "../../lib/auth.js";
import { checkNin } from "../../lib/ninValidator.js";
import { isAiConfigured, matchFaces } from "../../lib/openai.js";
import { AUTO_APPROVE_DELAY_MS } from "../../lib/kycReview.js";

const VALID_ID_TYPES = ["local_id_nin", "national_id_card", "international_passport"];
const AI_LIVENESS_THRESHOLD = Number(process.env.AI_LIVENESS_THRESHOLD) || 0.75;

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

    // --- NIN validation against the photographed ID document (in-app) -----
    // The entered NIN must match the number printed on the ID photo: a
    // wrong number is rejected immediately so the user can fix it before
    // the review queue ever sees it. An unreadable photo never blocks a
    // submission: it falls back to admin review instead of the 60-second
    // auto-approval.
    let ninCheck = { status: "n/a" };
    if (idType === "local_id_nin") {
      try {
        ninCheck = await checkNin({ nin: details.ninNumber, fullName, imageUrl });
      } catch (err) {
        ninCheck = { status: "unavailable", message: err.message };
      }
      if (ninCheck.status === "mismatch" || ninCheck.status === "bad_format") {
        return res.status(400).json({
          success: false,
          code: "NIN_MISMATCH",
          message: ninCheck.message || "The NIN doesn't match your ID photo. Check the number and try again.",
        });
      }
      // Any other status ('verified', 'unavailable') continues below:
      // 'unavailable' simply forgoes the auto-approval and goes to review.
    }

    // --- Facial verification: the live face vs the ID document face --------
    // Server-side face match (OpenAI vision). A mismatch is returned to the
    // user right away so they can retake; an AI outage routes the submission
    // to human review rather than locking anyone out.
    let aiCheck = { status: "unconfigured" };
    if (isAiConfigured()) {
      try {
        const faceMatch = await matchFaces(imageUrl, [selfieUrl, ...livenessUrls].filter(Boolean));
        aiCheck = { status: faceMatch.passed ? "passed" : "failed", result: faceMatch };
        if (!faceMatch.passed) {
          return res.status(400).json({
            success: false,
            code: "FACE_MISMATCH",
            message: `Facial verification failed: ${faceMatch.reason}. Retake your selfie in good light and try again.`,
          });
        }
      } catch (err) {
        aiCheck = { status: "unavailable", error: err.message };
      }
    }

    // --- 60-second auto-approval window ------------------------------------
    // NIN confirmed against the ID photo (printed number + printed name) +
    // face match + liveness all passed → the account approves itself 60
    // seconds later if no admin has decided in between (the reviewer keeps
    // the full window to reject first). Anything missing — unreadable photo,
    // non-NIN ID, name not confirmed, weak liveness — goes to admin review.
    const clientCandidate = livenessPassed && livenessScore >= AI_LIVENESS_THRESHOLD;
    const ninVerified = ninCheck.status === "verified";
    const autoApproveEligible =
      ninVerified &&
      ninCheck.nameMatch === true &&
      aiCheck.status === "passed" &&
      clientCandidate;
    const autoApproveAt = autoApproveEligible
      ? new Date(Date.now() + AUTO_APPROVE_DELAY_MS).toISOString()
      : "";

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
        aiAutoVerified: false,
        rawAiLiveness: parsedAiLiveness,
      }),
      // Verification trail consumed by the status view, the admin screen and
      // the 60-second auto-approver (attributes: scripts/setup-schema.mjs).
      ninVerified,
      ninNameMatch: ninCheck.nameMatch === true,
      ninCheckStatus: String(ninCheck.status || "n/a").slice(0, 32),
      faceMatchPassed: aiCheck.status === "passed",
      aiReport: JSON.stringify(aiCheck).slice(0, 65535),
      autoApproveAt,
      // Nothing is approved synchronously any more: the decision belongs to
      // an admin, or to the 60-second window when every check passed.
      verificationLevel: 0,
      status: "pending",
      verified: false,
      aiLivenessPassed: livenessScores?.passed !== false,
      reviewNote: "",
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
            kycStatus: "pending",
            kycLevel: 0,
          }
        );
      }
    } catch (err) {
      console.error("KYC user sync error:", err.message);
    }

    res.json({
      success: true,
      action,
      status: "pending",
      autoApproved: false,
      autoApproveEligible,
      autoApproveAt: autoApproveAt || null,
      autoApproveSeconds: autoApproveEligible ? Math.round(AUTO_APPROVE_DELAY_MS / 1000) : 0,
      ninStatus: ninCheck.status,
      faceMatch: aiCheck.status,
      message: autoApproveEligible
        ? "All checks passed — reviewing your identity now. You'll be approved within a minute if no reviewer is available."
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
