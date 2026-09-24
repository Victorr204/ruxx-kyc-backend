import { verifySession } from "../../../lib/auth.js";
import { isAiConfigured, openAiModel } from "../../../lib/openai.js";

export default async function handler(req, res) {
  if (req.method !== "GET" && req.method !== "POST") {
    return res.status(405).json({ message: "Method not allowed" });
  }

  try {
    await verifySession(req);
  } catch (err) {
    return res
      .status(err.status || 401)
      .json({ success: false, message: err.message || "Unauthorized" });
  }

  res.json({
    success: true,
    configured: isAiConfigured(),
    engine: isAiConfigured() ? openAiModel() : null,
    method: "openai-vision",
  });
}
