import { verifySession } from "../../../lib/auth.js";
import { enforce } from "../../../lib/rateLimit.js";
import { matchFaces, isAiConfigured, aiNotConfiguredMessage } from "../../../lib/openai.js";

function normalizeImage(value) {
  if (typeof value !== "string") return null;
  const v = value.trim();
  if (v.startsWith("data:image/") || v.startsWith("https://")) return v;
  if (/^[A-Za-z0-9+/=\s]+$/.test(v) && v.length > 100) {
    return `data:image/jpeg;base64,${v.replace(/\s+/g, "")}`;
  }
  return null;
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ message: "Method not allowed" });
  }

  if (!isAiConfigured()) {
    return res.status(503).json({ success: false, message: aiNotConfiguredMessage() });
  }

  if (!(await enforce(req, res, "kyc-ai-match", 20, 60_000))) return;

  try {
    try {
      await verifySession(req);
    } catch (err) {
      return res
        .status(err.status || 401)
        .json({ success: false, message: err.message || "Unauthorized" });
    }

    const { documentImage, documentUrl, livenessImages, livenessUrls } = req.body || {};
    const doc = normalizeImage(documentImage || documentUrl);
    const livesRaw = Array.isArray(livenessImages) && livenessImages.length
      ? livenessImages
      : Array.isArray(livenessUrls)
      ? livenessUrls
      : [];
    const lives = livesRaw.map(normalizeImage).filter(Boolean).slice(0, 4);

    if (!doc) {
      return res.status(400).json({
        success: false,
        message: "documentImage is required (data URL, base64, or https URL)",
      });
    }
    if (!lives.length) {
      return res.status(400).json({
        success: false,
        message: "livenessImages must contain at least one image",
      });
    }

    const result = await matchFaces(doc, lives);
    res.json({ success: true, ...result });
  } catch (error) {
    const status = error.status || 500;
    res.status(status).json({
      success: false,
      message: error.message || "AI face match failed",
    });
  }
}
