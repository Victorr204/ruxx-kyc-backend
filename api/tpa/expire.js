// File: api/tpa/expire.js — daily cron: close overdue temporary accounts and
// send the 7-day / 1-day / expired notifications.
import { Query } from "node-appwrite";
import {
  DAY_MS,
  PENDING_TTL_DAYS,
  STATUS,
  databaseId,
  db,
  daysLeft,
  markExpired,
  msLeft,
  round2,
  setNotice,
  tpaCollectionId,
} from "../../lib/tpa.js";
import { notifyUser } from "../../lib/push.js";

async function listByStatus(status, limit = 500) {
  const res = await db().listDocuments(databaseId(), tpaCollectionId(), [
    Query.equal("status", status),
    Query.limit(limit),
  ]);
  return res.documents || [];
}

function authOk(req) {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    console.warn("TPA_EXPIRE: CRON_SECRET is not set — the cron endpoint is unauthenticated.");
    return true;
  }
  const header = req.headers?.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : header;
  return token === secret || req.headers?.["x-cron-secret"] === secret;
}

export default async function handler(req, res) {
  if (req.method !== "GET" && req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  if (!authOk(req)) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const summary = { expired: 0, notices7d: 0, notices1d: 0, pendingClosed: 0, errors: 0 };

  try {
    // --- funded accounts: countdown + expiry ---
    for (const tpa of await listByStatus(STATUS.ACTIVE)) {
      try {
        const left = msLeft(tpa);

        if (left <= 0) {
          if (!tpa.noticeExpired) {
            await markExpired(tpa);
            await setNotice(tpa, "noticeExpired");
            summary.expired += 1;
            const balance = round2(tpa.amount);
            await notifyUser({
              userId: tpa.userId,
              title: "Temporary account expired",
              message:
                balance > 0
                  ? `Your temporary account is closed for new deposits. Your ₦${balance.toFixed(2)} is safe — verify your identity to move it into your permanent balance.`
                  : "Your temporary account has expired. Verify your identity to get a permanent prepaid account.",
              type: "warning",
              data: { screen: "/fund" },
            });
          }
          continue;
        }

        const left1d = left <= 1 * DAY_MS;
        const left7d = left <= 7 * DAY_MS;
        const balance = round2(tpa.amount);

        if (left1d && !tpa.notice1d) {
          await setNotice(tpa, "notice1d");
          if (!tpa.notice7d) await setNotice(tpa, "notice7d");
          summary.notices1d += 1;
          await notifyUser({
            userId: tpa.userId,
            title: "Temporary account expires tomorrow",
            message: `Your temporary account closes in less than a day (₦${balance.toFixed(2)} inside). Verify your identity to move that balance to your permanent prepaid account.`,
            type: "warning",
            data: { screen: "/verify" },
          });
        } else if (left7d && !tpa.notice7d) {
          await setNotice(tpa, "notice7d");
          summary.notices7d += 1;
          await notifyUser({
            userId: tpa.userId,
            title: `Temporary account expires in ${daysLeft(tpa)} day${daysLeft(tpa) === 1 ? "" : "s"}`,
            message: `Your temporary account (₦${balance.toFixed(2)}) expires soon. Complete verification and we'll move the balance into your permanent prepaid account.`,
            type: "warning",
            data: { screen: "/verify" },
          });
        }
      } catch (err) {
        summary.errors += 1;
        console.error("TPA expire: active row failed", tpa.$id, err?.message || err);
      }
    }

    // --- never-funded accounts: reap after PENDING_TTL_DAYS ---
    const cutoff = Date.now() - PENDING_TTL_DAYS * DAY_MS;
    for (const tpa of await listByStatus(STATUS.PENDING)) {
      try {
        const created = Date.parse(tpa.createdAt || "");
        if (!Number.isFinite(created) || created > cutoff) continue;
        await markExpired(tpa);
        summary.pendingClosed += 1;
        await notifyUser({
          userId: tpa.userId,
          title: "Temporary account closed",
          message:
            "We closed your temporary account because it was never funded. Verify your identity to open a permanent prepaid account.",
          type: "warning",
          data: { screen: "/verify" },
        });
      } catch (err) {
        summary.errors += 1;
        console.error("TPA expire: pending row failed", tpa.$id, err?.message || err);
      }
    }

    return res.status(200).json({ ok: true, ...summary, checkedAt: new Date().toISOString() });
  } catch (err) {
    console.error("TPA expire cron error:", err?.message || err);
    return res.status(500).json({ error: "Expiry sweep failed" });
  }
}
