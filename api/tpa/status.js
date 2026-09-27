// File: api/tpa/status.js — one call that tells the app which top-up flow to show.
import { verifySession } from "../../lib/auth.js";
import { isActive, listTpas, publicView } from "../../lib/tpa.js";
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
    const [userDoc, balanceDoc, tpaDocs] = await Promise.all([
      getUserDoc(user.$id),
      getBalanceDoc(user.$id),
      listTpas(user.$id),
    ]);

    const liveTpa = tpaDocs.find((d) => d.status === "pending" || isActive(d)) || null;
    const latestTpa = tpaDocs[0] || null;

    const approved = isKycApproved(userDoc);
    const hasPva = hasVirtualAccount(userDoc);

    return res.status(200).json({
      ok: true,
      userId: user.$id,
      email: userDoc?.email || user.email || "",
      kycStatus: userDoc?.kycStatus || null,
      approved,
      hasPva,
      // PVA creation is only offered once KYC is approved.
      canCreatePva: approved && !hasPva,
      needsMigration: approved && !hasPva && Boolean(latestTpa),
      pva: hasPva
        ? typeof userDoc.virtualAccount === "object"
          ? userDoc.virtualAccount
          : safeParse(userDoc.virtualAccount)
        : null,
      tpa: publicView(liveTpa || latestTpa),
      tpaActive: isActive(liveTpa),
      hasTpa: Boolean(latestTpa),
      tpaCount: tpaDocs.length,
      prepaid: balanceAmountOf(balanceDoc),
    });
  } catch (err) {
    console.error("TPA status error:", err?.message || err);
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
