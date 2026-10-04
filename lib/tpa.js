// lib/tpa.js — Temporary Prepaid Account (TPA) core helpers.
// A TPA is a one-time wallet for users who want to use the app before their
// KYC is approved. It is funded through Paystack "Pay with Transfer" accounts,
// lives for 30 days from its FIRST successful deposit, and is migrated into
// the permanent prepaid balance once KYC is approved.

import { ID, Permission, Query, Role } from "node-appwrite";
import { getDatabases } from "./appwrite.js";
import { requireEnv } from "./env.js";

export const DAY_MS = 86_400_000;
export const TPA_TTL_DAYS = 30;
export const TPA_TTL_MS = TPA_TTL_DAYS * DAY_MS;
// A TPA that is never funded must not linger forever: pending rows are
// reaped after this many days with no deposit.
export const PENDING_TTL_DAYS = 7;

export const STATUS = {
  PENDING: "pending",
  ACTIVE: "active",
  EXPIRED: "expired",
};

export function db() {
  return getDatabases();
}

export function databaseId() {
  return requireEnv("DATABASE_ID");
}

export function tpaCollectionId() {
  return requireEnv("TPA_COLLECTION_ID");
}

export function collection(name) {
  return process.env[name] || "";
}

/** Same fee rule as prepaid deposits: 1.5% + ₦50 levy from ₦10,000. */
export function depositFee(gross) {
  const g = Number(gross) || 0;
  if (g <= 0) return 0;
  let fee = g * 0.015;
  if (g >= 10000) fee += 50;
  return Math.round(fee * 100) / 100;
}

/** Net amount credited to the wallet after the deposit fee. */
export function netAmount(gross) {
  const g = Number(gross) || 0;
  return Math.round((g - depositFee(g)) * 100) / 100;
}

export function round2(value) {
  return Math.round((Number(value) || 0) * 100) / 100;
}

// --- idempotency -----------------------------------------------------------

export function readRefs(doc) {
  try {
    const parsed = JSON.parse(doc?.processedRefs || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function hasRef(doc, reference) {
  if (!reference) return false;
  return readRefs(doc).includes(reference);
}

export function withRef(doc, reference) {
  // Kept short on purpose: `processedRefs` is a 4000-char Appwrite attribute,
  // so only the most recent references are retained (older ones are still
  // protected by the ledger `reference` check).
  return JSON.stringify([...readRefs(doc), reference].slice(-100));
}

// --- lifecycle -------------------------------------------------------------

export function isActive(doc) {
  if (!doc || doc.status !== STATUS.ACTIVE) return false;
  const ends = Date.parse(doc.expiresAt || "");
  return Number.isFinite(ends) && ends > Date.now();
}

export function msLeft(doc) {
  if (!doc) return 0;
  const ends = Date.parse(doc.expiresAt || "");
  if (!Number.isFinite(ends)) return 0;
  return Math.max(0, ends - Date.now());
}

/** Whole days remaining, rounded up — "1 day left" until <24h is truly gone. */
export function daysLeft(doc) {
  return Math.ceil(msLeft(doc) / DAY_MS);
}

export function isMigratable(doc) {
  return Boolean(doc) && doc.status !== "migrated";
}

// --- queries ---------------------------------------------------------------

/**
 * Every TPA row for a user, newest first. Filtered in JS so the only
 * required index is `userId`.
 */
export async function listTpas(userId) {
  const res = await db().listDocuments(databaseId(), tpaCollectionId(), [
    Query.equal("userId", userId),
    Query.limit(20),
  ]);
  const docs = res.documents || [];
  return docs.sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
}

export async function findLatestTpa(userId) {
  const docs = await listTpas(userId);
  return docs[0] || null;
}

export async function findLiveTpa(userId) {
  const docs = await listTpas(userId);
  return docs.find((d) => d.status === STATUS.PENDING || isActive(d)) || null;
}

export async function findTpaById(tpaId) {
  if (!tpaId) return null;
  try {
    return await db().getDocument(databaseId(), tpaCollectionId(), tpaId);
  } catch {
    return null;
  }
}

// --- mutations -------------------------------------------------------------

export async function createTpa(userId) {
  const now = new Date().toISOString();
  const doc = await db().createDocument(
    databaseId(),
    tpaCollectionId(),
    ID.unique(),
    {
      userId,
      status: STATUS.PENDING,
      amount: 0,
      spent: 0,
      deposited: 0,
      expiresAt: "",
      processedRefs: "",
      notice7d: false,
      notice1d: false,
      noticeExpired: false,
      createdAt: now,
      updatedAt: now,
    },
    [Permission.read(Role.user(userId))]
  );
  return doc;
}

/**
 * Credit a TPA from a settled Paystack transfer.
 * The first credit starts the 30-day countdown.
 *
 * The idempotency marker lands FIRST and the credits are relative (atomic
 * increments), so a concurrent debit can never be clobbered. If the credit
 * itself fails transiently the marker is rolled back so the webhook retry
 * can run again; a hard crash between marker and credit leaves a
 * Paystack-visible deposit for support to restore — the safe direction
 * (the reverse would double-credit on retry).
 *
 * @returns {{ doc, net, firstCredit, fee }}
 * @throws  {{ status, message }} when the reference was already processed.
 */
export async function creditTpa(doc, { gross, reference }) {
  const net = netAmount(gross);
  if (net <= 0) throw { status: 400, message: "Deposit amount too small" };

  if (hasRef(doc, reference)) {
    throw { status: 409, message: "Deposit already processed" };
  }

  const now = Date.now();
  const firstCredit = doc.status !== STATUS.ACTIVE;
  const expiresAt =
    firstCredit && !doc.expiresAt
      ? new Date(now + TPA_TTL_MS).toISOString()
      : doc.expiresAt || new Date(now + TPA_TTL_MS).toISOString();

  await db().updateDocument(databaseId(), tpaCollectionId(), doc.$id, {
    status: STATUS.ACTIVE,
    expiresAt,
    processedRefs: withRef(doc, reference),
    notice7d: false,
    notice1d: false,
    noticeExpired: false,
    updatedAt: new Date().toISOString(),
  });

  let updated;
  try {
    updated = await db().incrementDocumentAttribute(databaseId(), tpaCollectionId(), doc.$id, "amount", net);
    updated = await db().incrementDocumentAttribute(databaseId(), tpaCollectionId(), doc.$id, "deposited", net);
  } catch (err) {
    // Transient failure: unmark so the webhook retry re-runs this deposit.
    await db()
      .updateDocument(databaseId(), tpaCollectionId(), doc.$id, {
        processedRefs: doc.processedRefs || "",
        updatedAt: new Date().toISOString(),
      })
      .catch(() => {});
    throw { status: 500, message: `Deposit credit failed: ${err?.message || err}` };
  }

  return { doc: updated, net, firstCredit, fee: depositFee(gross) };
}

/**
 * Debit an active TPA. Returns the balance before and after the debit.
 * The debit is a server-side decrement with min 0: overdraft is rejected
 * atomically and concurrent debits cannot both win (no read-modify-write).
 */
export async function debitTpa(doc, amount) {
  const value = round2(amount);
  if (value <= 0) throw { status: 400, message: "Invalid amount" };
  if (!isActive(doc)) {
    throw { status: 400, message: "Temporary account is not active" };
  }
  const previousAmount = round2(doc.amount);
  const previousSpent = round2(doc.spent);
  if (previousAmount < value) {
    throw { status: 400, message: "Insufficient temporary balance" };
  }

  let updated;
  try {
    updated = await db().decrementDocumentAttribute(
      databaseId(),
      tpaCollectionId(),
      doc.$id,
      "amount",
      value,
      0
    );
  } catch (err) {
    if (/reached the minimum/i.test(String(err?.message || ""))) {
      throw { status: 400, message: "Insufficient temporary balance" };
    }
    throw err;
  }
  try {
    updated = await db().incrementDocumentAttribute(databaseId(), tpaCollectionId(), doc.$id, "spent", value);
  } catch {
    // Stats only — never fail a purchase that already moved money.
  }

  return { doc: updated, previousAmount, previousSpent, newBalance: round2(updated.amount) };
}

/**
 * Credit a failed purchase back to a TPA.
 * Relative (atomic increments): stays correct even when other transactions
 * happened between the debit and the reversal (reconciliation).
 */
export async function refundTpa(doc, amount) {
  const value = round2(amount);
  if (value <= 0) throw { status: 400, message: "Invalid refund amount" };
  let updated = await db().incrementDocumentAttribute(databaseId(), tpaCollectionId(), doc.$id, "amount", value);
  try {
    updated = await db().decrementDocumentAttribute(databaseId(), tpaCollectionId(), doc.$id, "spent", value, 0);
  } catch {
    // Stats only: spent already below the refund — leave it.
  }
  return { doc: updated, newBalance: round2(updated.amount) };
}

export async function markExpired(doc) {
  if (doc.status === STATUS.EXPIRED) return doc;
  return db().updateDocument(databaseId(), tpaCollectionId(), doc.$id, {
    status: STATUS.EXPIRED,
    updatedAt: new Date().toISOString(),
  });
}

export async function setNotice(doc, field) {
  return db().updateDocument(databaseId(), tpaCollectionId(), doc.$id, {
    [field]: true,
    updatedAt: new Date().toISOString(),
  });
}

export async function deleteTpa(doc) {
  await db().deleteDocument(databaseId(), tpaCollectionId(), doc.$id);
}

// --- shaping ---------------------------------------------------------------

/** Client-safe snapshot (also used by purchase pages for display). */
export function publicView(doc) {
  if (!doc) return null;
  const active = isActive(doc);
  return {
    id: doc.$id,
    status: doc.status,
    active,
    amount: round2(doc.amount),
    spent: round2(doc.spent),
    deposited: round2(doc.deposited),
    balance: round2(doc.amount),
    expiresAt: doc.expiresAt || null,
    daysLeft: active ? daysLeft(doc) : 0,
    createdAt: doc.createdAt || null,
  };
}
