// File: api/tpa/create.js — open (or return) the caller's temporary prepaid account.
import { verifySession } from "../../lib/auth.js";
import { enforce } from "../../lib/rateLimit.js";
import { createTpa, findLatestTpa, publicView, STATUS } from "../../lib/tpa.js";
import { getUserDoc } from "../../lib/accounts.js";

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

  if (!(await enforce(req, res, "tpa-create", 5, 60_000))) return;

  try {
    const userDoc = await getUserDoc(user.$id);

    // PVA owners don't need a temporary wallet.
    if (userDoc?.virtualAccount) {
      return res.status(409).json({
        error: "You already have a permanent prepaid account.",
        code: "PVA_EXISTS",
      });
    }

    const existing = await findLatestTpa(user.$id);
    if (existing) {
      // One temporary account per user: expired rows stay expired, live rows
      // are returned as-is so retries are idempotent.
      if (existing.status === STATUS.EXPIRED) {
        return res.status(409).json({
          error: "Your temporary account has expired. Complete verification to continue.",
          code: "TPA_EXPIRED",
          tpa: publicView(existing),
        });
      }
      return res.status(200).json({ ok: true, tpa: publicView(existing), reused: true });
    }

    const doc = await createTpa(user.$id);
    return res.status(201).json({ ok: true, tpa: publicView(doc), reused: false });
  } catch (err) {
    console.error("TPA create error:", err?.message || err);
    if (err?.status) return res.status(err.status).json({ error: err.message });
    return res.status(500).json({ error: "Could not create a temporary account" });
  }
}
