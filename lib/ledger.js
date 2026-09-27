// lib/ledger.js — server-side ledger + notification writers (TPA backend copy).
// Kept in sync with paystack-backend/lib/ledger.js so history and the
// Notifications tab behave identically no matter which backend wrote the row.

import { Client, Databases, ID, Permission, Query, Role } from "node-appwrite";

let dbs = null;

function env(...names) {
  for (const name of names) {
    if (process.env[name]) return process.env[name];
  }
  return "";
}

function ids() {
  return {
    database: env("DATABASE_ID", "APPWRITE_DATABASE_ID"),
    txn: env("APPWRITE_TXN_COLLECTION_ID", "TXN_COLLECTION_ID"),
    notifications: env("APPWRITE_NOTIFICATIONS_COLLECTION_ID", "NOTIFICATIONS_COLLECTION_ID"),
    profiles: env("USER_PROFILES_COLLECTION", "APPWRITE_USER_PROFILES_COLLECTION"),
  };
}

function db() {
  if (dbs) return dbs;
  const client = new Client()
    .setEndpoint(env("APPWRITE_ENDPOINT"))
    .setProject(env("APPWRITE_PROJECT_ID"))
    .setKey(env("APPWRITE_API_KEY"));
  dbs = new Databases(client);
  return dbs;
}

/**
 * Append a row to the shared transaction ledger (shown in Transaction History).
 * Failures are logged but never break the money path.
 */
export async function writeLedgerEntry(entry) {
  const c = ids();
  if (!c.txn || !c.database || !entry.userId) return null;

  const data = {
    userId: entry.userId,
    serviceType: entry.serviceType,
    recipient: entry.recipient || "",
    provider: entry.provider || "",
    // `Transactions.amount` is an integer column — round so a fractional TPA
    // net amount (1.5% fee) never makes the whole ledger write fail.
    amount: Math.round(Number(entry.amount) || 0),
    status: entry.status || "Success",
    kind: entry.kind || "debit",
    reference: entry.reference || "",
    note: entry.note || "",
    createdAt: new Date().toISOString(),
    source: "server",
  };

  try {
    return await db().createDocument(c.database, c.txn, ID.unique(), data, [
      Permission.read(Role.user(entry.userId)),
    ]);
  } catch (err) {
    console.error("Ledger write failed:", err.message, data);
    return null;
  }
}

/** True when this reference was already recorded for the user. */
export async function ledgerHasReference(userId, reference) {
  if (!reference) return false;
  const c = ids();
  if (!c.txn || !c.database) return false;
  try {
    const existing = await db().listDocuments(c.database, c.txn, [
      Query.equal("userId", userId),
      Query.equal("reference", reference),
      Query.limit(1),
    ]);
    return existing.total > 0;
  } catch {
    return false;
  }
}

/** In-app notification row (Notifications tab). */
export async function writeInAppNotification({ userId, title, message, type = "system" }) {
  const c = ids();
  if (!c.notifications || !c.database || !userId) return null;
  try {
    return await db().createDocument(
      c.database,
      c.notifications,
      ID.unique(),
      {
        userId,
        title,
        message,
        type,
        read: false,
        createdAt: new Date().toISOString(),
      },
      [Permission.read(Role.user(userId))]
    );
  } catch (err) {
    console.error("In-app notification failed:", err.message);
    return null;
  }
}

/** Stored Expo push token (userProfiles collection). */
export async function getPushTokenForUser(userId) {
  const c = ids();
  if (!c.profiles || !c.database) return null;
  try {
    const docs = await db().listDocuments(c.database, c.profiles, [
      Query.equal("userId", userId),
      Query.limit(1),
    ]);
    if (!docs.total) return null;
    return docs.documents[0].expoPushToken || null;
  } catch {
    return null;
  }
}
