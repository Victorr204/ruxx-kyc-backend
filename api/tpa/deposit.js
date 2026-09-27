// File: api/tpa/deposit.js — generate a one-time Paystack "Pay with Transfer"
// account for topping up the temporary prepaid account.
import { verifySession } from "../../lib/auth.js";
import { enforce } from "../../lib/rateLimit.js";
import { createTpa, depositFee, findLatestTpa, netAmount, publicView, STATUS } from "../../lib/tpa.js";
import { getUserDoc } from "../../lib/accounts.js";

const MIN_AMOUNT = 100;
const MAX_AMOUNT = 1_000_000;
// Paystack clamps bank_transfer accounts to 15 minutes – 8 hours.
const ACCOUNT_TTL_MS = 8 * 60 * 60 * 1000;

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

  if (!(await enforce(req, res, "tpa-deposit", 5, 60_000))) return;

  const amount = Number(req.body?.amount);
  if (!amount || isNaN(amount) || amount < MIN_AMOUNT || amount > MAX_AMOUNT) {
    return res.status(400).json({
      error: `Amount must be between ₦${MIN_AMOUNT.toLocaleString()} and ₦${MAX_AMOUNT.toLocaleString()}`,
    });
  }

  const secret = process.env.PAYSTACK_SECRET_KEY;
  if (!secret) {
    return res.status(500).json({ error: "Payments are not configured" });
  }

  try {
    const userDoc = await getUserDoc(user.$id);

    if (userDoc?.virtualAccount) {
      return res.status(409).json({
        error: "You already have a permanent prepaid account.",
        code: "PVA_EXISTS",
      });
    }

    let tpa = await findLatestTpa(user.$id);
    if (tpa && tpa.status === STATUS.EXPIRED) {
      return res.status(409).json({
        error: "Your temporary account has expired. Complete verification to continue.",
        code: "TPA_EXPIRED",
        tpa: publicView(tpa),
      });
    }
    if (!tpa) tpa = await createTpa(user.$id);

    const email = userDoc?.email || user.email;
    if (!email) {
      return res.status(400).json({ error: "No email address on this account" });
    }

    const expiresAt = new Date(Date.now() + ACCOUNT_TTL_MS).toISOString();

    const resp = await fetch("https://api.paystack.co/charge", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${secret}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        email,
        amount: Math.round(amount * 100),
        currency: "NGN",
        bank_transfer: { account_expires_at: expiresAt },
        metadata: {
          ruxxTpa: 1,
          kind: "tpa-deposit",
          tpaId: tpa.$id,
          userId: user.$id,
        },
      }),
    });

    const payload = await resp.json().catch(() => ({}));
    if (!resp.ok || !payload?.data?.account_number) {
      console.error("Paystack charge error:", payload?.message || payload);
      return res.status(502).json({
        error: payload?.message || "Could not create a deposit account. Please try again.",
      });
    }

    const charge = payload.data;
    return res.status(200).json({
      ok: true,
      tpa: publicView(tpa),
      reference: charge.reference,
      account_number: charge.account_number,
      account_name: charge.account_name,
      bank: charge.bank?.name || "",
      bank_slug: charge.bank?.slug || "",
      expires_at: charge.account_expires_at || expiresAt,
      amount,
      fee: depositFee(amount),
      net: netAmount(amount),
    });
  } catch (err) {
    console.error("TPA deposit error:", err?.message || err);
    if (err?.status) return res.status(err.status).json({ error: err.message });
    return res.status(500).json({ error: "Could not create a deposit account" });
  }
}
