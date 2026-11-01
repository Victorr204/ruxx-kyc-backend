// File: api/kyc/nin-check.js — live NIN validation against NIMC (via Dojah)
// for the verify screen, so a wrong NIN is caught on the spot instead of
// after photos and liveness are taken.
import { verifySession } from "../../lib/auth.js";
import { enforce } from "../../lib/rateLimit.js";
import { checkNin, isNinFormat } from "../../lib/dojah.js";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ message: "Method not allowed" });
  }
  // Paid provider call — 15 checks / 5 min / session is generous for typing.
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
