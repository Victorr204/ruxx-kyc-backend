// File: api/wallet/status.js — KYC + permanent prepaid account state for the
// app (replaces /api/tpa/status: temporary accounts no longer exist — every
// account is permanent and KYC-gated).
import { verifySession } from "../../lib/auth.js";
import { balanceAmountOf, getBalanceDoc, getUserDoc, hasVirtualAccount, isKycApproved } from "../../lib/accounts.js";

export default async function handler(req, res) {
  if (req.method !== "GET" && req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  let user;
  try {
    user = await verifySession(req);
  } catch (err) {
    return res.status(err.status || 401).json({ error: err.message || "Unauthorized" });
  }

  try {
    const [userDoc, balanceDoc] = await Promise.all([
      getUserDoc(user.$id),
      getBalanceDoc(user.$id),
    ]);

    const approved = isKycApproved(userDoc);
    const hasPva = hasVirtualAccount(userDoc);

    return res.status(200).json({
      ok: true,
      userId: user.$id,
      email: userDoc?.email || user.email || "",
      kycStatus: userDoc?.kycStatus || null,
      approved,
      hasPva,
      // The permanent prepaid account is only issued once identity is verified.
      canCreatePva: approved && !hasPva,
      pva: hasPva
        ? typeof userDoc.virtualAccount === "object"
          ? userDoc.virtualAccount
          : safeParse(userDoc.virtualAccount)
        : null,
      prepaid: balanceAmountOf(balanceDoc),
    });
  } catch (err) {
    console.error("wallet status error:", err?.message || err);
    return res.status(500).json({ error: "Failed to load account status" });
  }
}

function safeParse(value) {
  if (!value) return null;
  if (typeof value === "object") return value;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}
