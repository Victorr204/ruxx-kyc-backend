// File: api/tpa/migrate.js — after KYC approval, move the temporary balance into
// the permanent prepaid balance and close the temporary account.
import { verifySession } from "../../lib/auth.js";
import { enforce } from "../../lib/rateLimit.js";
import { deleteTpa, findLatestTpa, round2 } from "../../lib/tpa.js";
import { creditPrepaidBalance, getUserDoc, hasVirtualAccount, isKycApproved } from "../../lib/accounts.js";
import { ledgerHasReference, writeLedgerEntry } from "../../lib/ledger.js";
import { notifyUser } from "../../lib/push.js";

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

  if (!(await enforce(req, res, "tpa-migrate", 5, 60_000))) return;

  try {
    const userDoc = await getUserDoc(user.$id);

    if (!isKycApproved(userDoc)) {
      return res.status(403).json({
        error: "Verify your identity before moving your temporary balance.",
        code: "KYC_REQUIRED",
      });
    }

    if (!hasVirtualAccount(userDoc)) {
      return res.status(400).json({
        error: "Create your permanent prepaid account first.",
        code: "PVA_REQUIRED",
      });
    }

    const tpa = await findLatestTpa(user.$id);
    if (!tpa) {
      return res.status(404).json({ error: "No temporary account found", code: "NO_TPA" });
    }

    const amount = round2(tpa.amount);
    let newBalance = 0;

    if (amount > 0) {
      const credited = await creditPrepaidBalance(user.$id, amount);
      newBalance = credited.amount;

      const outRef = `tpa_migrate_out_${tpa.$id}`;
      const inRef = `tpa_migrate_in_${tpa.$id}`;

      if (!(await ledgerHasReference(user.$id, outRef))) {
        await writeLedgerEntry({
          userId: user.$id,
          serviceType: "Balance Top-Up",
          recipient: "Temporary account",
          provider: "ruxx prepaid",
          amount,
          status: "Success",
          kind: "debit",
          reference: outRef,
          note: "Temporary account closed — balance moved to prepaid",
        });
      }
      if (!(await ledgerHasReference(user.$id, inRef))) {
        await writeLedgerEntry({
          userId: user.$id,
          serviceType: "Balance Top-Up",
          recipient: tpa.$id,
          provider: "ruxx prepaid",
          amount,
          status: "Success",
          kind: "credit",
          reference: inRef,
          note: "Transferred from your temporary account after verification",
        });
      }
    }

    await deleteTpa(tpa);

    await notifyUser({
      userId: user.$id,
      title: "Temporary account migrated 🎉",
      message:
        amount > 0
          ? `Your ₦${amount.toFixed(2)} temporary balance is now part of your permanent prepaid balance. New balance: ₦${newBalance.toFixed(2)}. Your dedicated account is ready to use.`
          : "Your temporary account is closed and your permanent prepaid account is ready to use.",
      type: "success",
      data: { screen: "/fund" },
    });

    return res.status(200).json({
      ok: true,
      migrated: amount,
      newBalance,
    });
  } catch (err) {
    console.error("TPA migrate error:", err?.message || err);
    if (err?.status) return res.status(err.status).json({ error: err.message, code: err.code });
    return res.status(500).json({ error: "Could not migrate your temporary account" });
  }
}
