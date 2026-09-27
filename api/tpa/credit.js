// File: api/tpa/credit.js — internal endpoint the Paystack webhook forwards
// TPA ("Pay with Transfer") settlements to. Authenticated with a shared secret.

import { creditTpa, findTpaById, publicView } from "../../lib/tpa.js";
import { ledgerHasReference, writeLedgerEntry } from "../../lib/ledger.js";
import { notifyUser } from "../../lib/push.js";

function sharedSecret() {
  return process.env.TPA_WEBHOOK_SECRET || process.env.PAYSTACK_SECRET_KEY || "";
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const secret = sharedSecret();
  if (!secret) {
    return res.status(500).json({ error: "TPA webhook secret is not configured" });
  }

  const provided = req.headers["x-ruxx-tpa-secret"] || "";
  if (provided !== secret) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const event = req.body;
  if (!event || event.event !== "charge.success") {
    return res.status(200).json({ ok: true, ignored: event?.event || "unknown" });
  }

  const meta = event.data?.metadata || {};
  const looksLikeTpa = Boolean(meta.ruxxTpa || meta.ruxx_tpa);
  if (!looksLikeTpa) {
    return res.status(200).json({ ok: true, ignored: "not-a-tpa-charge" });
  }

  const tpaId = meta.tpaId;
  const reference = event.data?.reference || event.id || "";

  try {
    const tpa = await findTpaById(tpaId);
    if (!tpa) {
      console.error("TPA credit: unknown tpaId", tpaId, "ref", reference);
      return res.status(404).json({ error: "Temporary account not found" });
    }
    if (meta.userId && meta.userId !== tpa.userId) {
      return res.status(403).json({ error: "Temporary account mismatch" });
    }
    if (tpa.status === "migrated") {
      return res.status(200).json({ ok: true, skipped: "migrated" });
    }

    const gross = (Number(event.data.amount) || 0) / 100;
    const { doc: credited, net, firstCredit, fee } = await creditTpa(tpa, { gross, reference });

    const depositRef = `tpa_deposit_${reference}`;
    if (!(await ledgerHasReference(tpa.userId, depositRef))) {
      await writeLedgerEntry({
        userId: tpa.userId,
        serviceType: "Balance Top-Up",
        recipient: reference,
        provider: "Paystack",
        amount: net,
        status: "Success",
        kind: "credit",
        reference: depositRef,
        note:
          fee > 0
            ? `Temporary account — gross ₦${gross.toFixed(2)}, processing fee ₦${fee.toFixed(2)}`
            : `Temporary account — gross ₦${gross.toFixed(2)}`,
      });
    }

    const view = publicView(credited);

    await notifyUser({
      userId: tpa.userId,
      title: firstCredit ? "Temporary account activated" : "Temporary account funded",
      message: firstCredit
        ? `We received ₦${net.toFixed(2)} (after a ₦${fee.toFixed(2)} fee). Your temporary account is live for ${view.daysLeft} days. Verify your ID anytime to move it to your permanent balance.`
        : `₦${net.toFixed(2)} was added to your temporary account. New balance: ₦${view.balance.toFixed(2)} (${view.daysLeft} days left).`,
      type: "deposit",
      data: { screen: "/fund" },
    });

    return res.status(200).json({ ok: true, net, firstCredit, tpa: view });
  } catch (err) {
    if (err?.status === 409) {
      return res.status(200).json({ ok: true, skipped: "already-processed" });
    }
    console.error("TPA credit error:", err?.message || err);
    if (err?.status) return res.status(err.status).json({ error: err.message });
    return res.status(500).json({ error: "Processing failed" });
  }
}
