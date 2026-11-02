import { configuredProviders, isAiConfigured, aiEngine, aiMethod } from "../../../lib/vision.js";

// Public, cheap config check: reports which server env vars are present so the
// app can show an exact setup error instead of a generic auth failure.
export default async function handler(req, res) {
  if (req.method !== "GET" && req.method !== "POST") {
    return res.status(405).json({ message: "Method not allowed" });
  }

  const providers = configuredProviders();
  const aiConfigured = isAiConfigured();
  const appwriteConfigured = Boolean(
    process.env.APPWRITE_ENDPOINT && process.env.APPWRITE_PROJECT_ID && process.env.APPWRITE_API_KEY
  );
  const dbConfigured = Boolean(
    process.env.DATABASE_ID && process.env.KYC_COLLECTION_ID && process.env.USER_COLLECTION_ID
  );

  res.json({
    success: true,
    configured: aiConfigured,
    // legacy alias — the app used this name before the provider chain existed
    openaiConfigured: aiConfigured,
    providers: {
      gemini: providers.includes("gemini"),
      groq: providers.includes("groq"),
      openai: providers.includes("openai"),
    },
    appwriteConfigured,
    dbConfigured,
    engine: aiConfigured ? aiEngine() : null,
    method: aiConfigured ? aiMethod() : "unconfigured",
  });
}
