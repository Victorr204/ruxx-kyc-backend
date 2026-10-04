// lib/accounts.js — user profile + prepaid balance lookups shared by the TPA flow.

import { ID, Query } from "node-appwrite";
import { getDatabases } from "./appwrite.js";
import { requireEnv } from "./env.js";

function db() {
  return getDatabases();
}

function env(...names) {
  for (const name of names) {
    if (process.env[name]) return process.env[name];
  }
  return "";
}

export async function getUserDoc(userId) {
  const res = await db().listDocuments(requireEnv("DATABASE_ID"), requireEnv("USER_COLLECTION_ID"), [
    Query.equal("userId", userId),
    Query.limit(1),
  ]);
  return res.total ? res.documents[0] : null;
}

export function isKycApproved(doc) {
  const status = String(doc?.kycStatus || "").toLowerCase();
  return status === "approved" || status === "verified";
}

export function hasVirtualAccount(doc) {
  const raw = doc?.virtualAccount;
  if (!raw) return false;
  if (typeof raw === "object") return Boolean(raw.account_number);
  try {
    return Boolean(JSON.parse(raw)?.account_number);
  } catch {
    return false;
  }
}

export async function getBalanceDoc(userId) {
  const balanceCollection = env("APPWRITE_BALANCE_COLLECTION_ID", "BALANCE_COLLECTION_ID");
  const database = env("DATABASE_ID", "APPWRITE_DATABASE_ID");
  if (!balanceCollection || !database) return null;
  const res = await db().listDocuments(database, balanceCollection, [
    Query.equal("userId", userId),
    Query.limit(1),
  ]);
  return res.total ? res.documents[0] : null;
}

export function balanceAmountOf(doc) {
  return Math.round((Number(doc?.amount) || 0) * 100) / 100;
}

/**
 * Add a positive amount to the user's prepaid balance, creating the document
 * when the user has never been credited before.
 *
 * @returns {{ amount: number, doc: object|null }}
 */
export async function creditPrepaidBalance(userId, amount, seed = {}) {
  const balanceCollection = env("APPWRITE_BALANCE_COLLECTION_ID", "BALANCE_COLLECTION_ID");
  const database = env("DATABASE_ID", "APPWRITE_DATABASE_ID");
  const value = Math.round((Number(amount) || 0) * 100) / 100;
  if (!balanceCollection || !database) {
    throw { status: 500, message: "Server config error: balance collection is not configured" };
  }

  const existing = await getBalanceDoc(userId);
  if (existing) {
    // Legacy rows may carry a null amount — repair those absolutely (the
    // value is 0), everything else takes the relative, race-free path.
    if (existing.amount === null || existing.amount === undefined || existing.amount === "") {
      const doc = await db().updateDocument(database, balanceCollection, existing.$id, {
        amount: value,
        ...seed,
      });
      return { amount: value, doc };
    }
    const doc = await db().incrementDocumentAttribute(database, balanceCollection, existing.$id, "amount", value);
    if (seed && Object.keys(seed).length) {
      await db().updateDocument(database, balanceCollection, existing.$id, seed);
    }
    return { amount: Math.round((Number(doc.amount) || 0) * 100) / 100, doc };
  }

  const created = await db().createDocument(database, balanceCollection, ID.unique(), {
    userId,
    amount: value,
    cumulative: value,
    spent: 0,
    referralRewardGiven: false,
    processedRefs: "[]",
    ...seed,
  });
  return { amount: value, doc: created };
}
