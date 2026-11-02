// File: api/kyc/nin-check.js — inline NIN pre-check for the verify screen,
// so a malformed number is caught on the spot instead of after photos and
// liveness are taken. Chip mode only: without the ID photo there is nothing
// to cross-check yet — the real validation runs on /api/kyc/submit, where
// the entered NIN is matched against what's printed on the document (in-app,
// no third-party NIMC lookup).
import { verifySession } from "../../lib/auth.js";
import { enforce } from "../../lib/rateLimit.js";
import { checkNin, isNinFormat } from "../../lib/ninValidator.js";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ message: "Method not allowed" });
  }
  // Session-scoped limit kept generous for typing UX (no provider credits
  // are burned any more — the chip check is a local format check).
  if (!(await enforce(req, res, "kyc-nin-check", 15, 5 * 60_000))) return;

  try {
    await verifySession(req);
  } catch (err) {
    return res.status(err.status || 401).json({ message: err.message || "Unauthorized" });
  }

  try {
    const nin = String(req.body?.nin || "").trim();
    const fullName = String(req.body?.fullName || "").trim();

    if (!isNinFormat(nin)) {
      return res.status(400).json({
        success: false,
        status: "bad_format",
        message: "NIN must be exactly 11 digits.",
      });
    }

    const result = await checkNin({ nin, fullName });

    // Every lookup outcome is a 200 — the app renders the status chip itself.
    // Only malformed requests are 400s. 'unavailable' (not configured, outage,
    // out of credit) is NOT a failure: submission still proceeds to review.
    return res.json({
      success: true,
      status: result.status,
      nameMatch: typeof result.nameMatch === "boolean" ? result.nameMatch : null,
      officialName: result.officialName || null,
      message: result.message,
    });
  } catch (error) {
    console.error("KYC nin-check error:", error?.message || error);
    return res.status(500).json({ success: false, message: "NIN check failed" });
  }
}
