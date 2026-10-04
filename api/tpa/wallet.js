// File: api/tpa/wallet.js — purchase integration.
// While a TPA is active it funds every purchase; after migration or expiry the
// purchase flow never calls this endpoint again.
import { verifySession } from "../../lib/auth.js";
import { debitTpa, findLiveTpa, findLatestTpa, isActive, refundTpa } from "../../lib/tpa.js";
import { balanceAmountOf, getBalanceDoc } from "../../lib/accounts.js";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  let user;
  try {
    user = await verifySession(req);
  } catch (err) {
    return res.status(err.status || 401).json({ error: err.message || "Unauthorized" });
  }

  const action = req.body?.action || "resolve";

  try {
    if (action === "resolve") {
      const tpa = await findLiveTpa(user.$id);
      if (tpa && isActive(tpa)) {
        return res.status(200).json({
          ok: true,
          source: "tpa",
          tpaId: tpa.$id,
          balance: Number(tpa.amount) || 0,
          spent: Number(tpa.spent) || 0,
          status: tpa.status,
          expiresAt: tpa.expiresAt || null,
        });
      }
      const prepaid = await getBalanceDoc(user.$id);
      return res.status(200).json({
        ok: true,
        source: "prepaid",
        tpaId: tpa?.$id || null,
        balance: balanceAmountOf(prepaid),
        status: tpa?.status || null,
      });
    }

    if (action === "debit") {
      const amount = Number(req.body?.amount);
      if (!amount || isNaN(amount) || amount <= 0) {
        return res.status(400).json({ ok: false, error: "Invalid amount" });
      }
      const tpa = await findLiveTpa(user.$id);
      if (!tpa || !isActive(tpa)) {
        return res.status(409).json({ ok: false, code: "NOT_ACTIVE", error: "Temporary account is not active" });
      }
      try {
        const result = await debitTpa(tpa, amount);
        return res.status(200).json({
          ok: true,
          source: "tpa",
          previousAmount: result.previousAmount,
          previousSpent: result.previousSpent,
          newBalance: result.newBalance,
        });
      } catch (debitErr) {
        const status = debitErr?.status || 500;
        return res.status(status).json({
          ok: false,
          code: status === 400 ? "INSUFFICIENT" : "ERROR",
          error: debitErr?.message || "Could not debit temporary account",
        });
      }
    }

    // Reversal used by immediate purchase failures and delayed reconciliation
    // alike: a relative credit stays correct when other transactions landed
    // between the debit and this reversal.
    if (action === "refundAmount" || action === "refund") {
      const amount = Number(req.body?.amount);
      if (!amount || amount <= 0 || isNaN(amount)) {
        return res.status(400).json({ ok: false, error: "Missing amount" });
      }
      const tpa = (await findLiveTpa(user.$id)) || (await findLatestTpa(user.$id));
      if (!tpa) {
        return res.status(404).json({ ok: false, error: "Temporary account not found" });
      }
      const result = await refundTpa(tpa, amount);
      return res.status(200).json({ ok: true, source: "tpa", newBalance: result.newBalance });
    }

    return res.status(400).json({ ok: false, error: "Unknown action" });
  } catch (err) {
    console.error(`TPA wallet ${action} error:`, err?.message || err);
    return res.status(err?.status || 500).json({ ok: false, error: err?.message || "Wallet error" });
  }
}
