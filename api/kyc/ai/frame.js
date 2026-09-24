import { verifySession } from "../../../lib/auth.js";
import { enforce } from "../../../lib/rateLimit.js";
import { analyzeLivenessFrames, isAiConfigured, aiNotConfiguredMessage } from "../../../lib/openai.js";

const VALID_ACTIONS = new Set(["front", "left", "right", "blink", "up"]);

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

  if (!(await enforce(req, res, "kyc-ai-frame", 90, 60_000))) return;

  try {
    try {
      await verifySession(req);
    } catch (err) {
      return res
        .status(err.status || 401)
        .json({ success: false, message: err.message || "Unauthorized" });
    }

    const { action, image, images } = req.body || {};
    if (!VALID_ACTIONS.has(action)) {
      return res.status(400).json({ success: false, message: "Invalid liveness action" });
    }

    const rawList = Array.isArray(images) && images.length ? images : image ? [image] : [];
    const normalized = rawList.map(normalizeImage).filter(Boolean).slice(0, 4);
    if (!normalized.length) {
      return res.status(400).json({
        success: false,
        message: "Provide image (data URL/base64) or images[] for analysis",
      });
    }

    const result = await analyzeLivenessFrames(action, normalized);
    res.json({ success: true, ...result });
  } catch (error) {
    const status = error.status || 500;
    res.status(status).json({
      success: false,
      message: error.message || "AI frame analysis failed",
    });
  }
}
