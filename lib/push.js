// lib/push.js — in-app notification row + Expo push, both best-effort.

import { getPushTokenForUser, writeInAppNotification } from "./ledger.js";

const EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send";

export async function sendPushToUser({ userId, title, body, data = {} }) {
  try {
    if (!userId || !title || !body) return { sent: false, error: "missing args" };

    const token = await getPushTokenForUser(userId);
    if (!token) return { sent: false, error: "no token" };

    const resp = await fetch(EXPO_PUSH_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        to: token,
        title,
        body,
        sound: "default",
        data,
        priority: "high",
      }),
    });

    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      console.error("Expo push HTTP error:", resp.status, text.slice(0, 200));
      return { sent: false, error: `http ${resp.status}` };
    }

    const json = await resp.json().catch(() => ({}));
    const ticket = Array.isArray(json?.data) ? json.data[0] : json?.data;
    if (ticket?.status === "error") {
      console.error("Expo push ticket error:", ticket.message, ticket.details);
      return { sent: false, error: ticket.message };
    }
    return { sent: true, ticket };
  } catch (err) {
    console.error("sendPushToUser failed:", err.message);
    return { sent: false, error: err.message };
  }
}

/** In-app row + push. Never throws. */
export async function notifyUser({ userId, title, message, type = "system", data = {} }) {
  try {
    await writeInAppNotification({ userId, title, message, type });
  } catch (err) {
    console.error("notifyUser in-app failed:", err.message);
  }
  try {
    await sendPushToUser({ userId, title, body: message, data });
  } catch (err) {
    console.error("notifyUser push failed:", err.message);
  }
}
