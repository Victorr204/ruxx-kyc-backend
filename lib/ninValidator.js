// lib/ninValidator.js — in-app NIN validation. No third-party lookup:
// NIMC's database is only reachable through licensed providers, so the
// number is validated against the ID document the user photographed.
// The document is read server-side with vision AI (readNinSlip — Gemini /
// Groq free tiers, see lib/vision.js).
//
// checkNin() outcomes:
//   'format_ok'   — pre-photo mode (no image yet): exactly 11 digits.
//                   The cross-check runs on /api/kyc/submit, once the ID
//                   photo exists.
//   'verified'    — the ID photo was read and the printed NIN matches the
//                   entered number: the entry matches the document.
//   'mismatch'    — the ID photo was read and the printed NIN differs
//                   (safe to reject: the user retypes the correct number).
//   'bad_format'  — not an 11-digit number (local format check first).
//   'unavailable' — the photo could not be read (glare / blur) or the AI
//                   is not configured: the submission must still go
//                   through, to admin review instead of the 60-second
//                   auto-approval.

import { isAiConfigured, readNinSlip } from "./vision.js";

/** Local format gate: a NIN is exactly 11 digits. */
export function isNinFormat(value) {
  return /^\d{11}$/.test(String(value || "").trim());
}

const HONORIFICS = new Set([
  "mr", "mrs", "miss", "ms", "dr", "prof", "chief", "alhaji", "alhaja",
  "hon", "engr", "barr", "bar", "rev", "pastor", "imam",
]);

/** Lowercased alphabetic tokens — drops punctuation, titles and extra spaces. */
export function nameTokens(name) {
  return String(name || "")
    .toLowerCase()
    .replace(/[^a-z\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 1 && !HONORIFICS.has(t));
}

/**
 * Whether the submitted name and the document name refer to the same person.
 * Either side may be the subset: an Appwrite account name is often
 * "first last" while the document prints "first middle last" — every token
 * of the shorter name must appear in the longer one.
 */
export function namesMatch(submitted, official) {
  const a = nameTokens(submitted);
  const b = nameTokens(official);
  if (!a.length || !b.length) return false;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  return short.every((t) => long.includes(t));
}

/**
 * Validate a submitted NIN against the photographed ID document (in-app).
 * @param {{ nin: string, fullName?: string, imageUrl?: string }} input
 *   imageUrl present → submit mode (cross-check against what's printed on
 *   the document); absent → verify-screen chip mode (format check only).
 * @returns {Promise<{ status: string, message: string,
 *   officialName?: string, nameMatch?: boolean }>}
 */
export async function checkNin({ nin, fullName, imageUrl } = {}) {
  if (!isNinFormat(nin)) {
    return { status: "bad_format", message: "NIN must be exactly 11 digits." };
  }
  if (!imageUrl) {
    return {
      status: "format_ok",
      message: "11-digit format OK — we'll confirm it against your ID photo when you submit.",
    };
  }
  if (!isAiConfigured()) {
    return { status: "unavailable", message: "NIN check is not configured." };
  }

  let slip;
  try {
    slip = await readNinSlip(imageUrl);
  } catch (err) {
    return {
      status: "unavailable",
      message: `We couldn't read your ID photo (${err.message}). A reviewer will verify it manually.`,
    };
  }
  if (!slip.readable) {
    return {
      status: "unavailable",
      message: slip.reason || "We couldn't read the NIN on your ID photo — a reviewer will verify it manually.",
    };
  }
  if (slip.nin !== String(nin).trim()) {
    return {
      status: "mismatch",
      message: "The NIN printed on your ID photo doesn't match the number you entered. Check the number and try again.",
    };
  }

  // The NIN matches the document. The printed name is a second, softer
  // signal: a mismatch never rejects (nicknames, maiden names) — it only
  // withholds the 60-second auto-approval and leaves the file to a reviewer.
  const officialName = slip.fullName;
  const nameMatch = officialName ? namesMatch(fullName, officialName) : null;

  return {
    status: "verified",
    officialName,
    nameMatch,
    message: nameMatch === true
      ? "NIN confirmed against your ID photo."
      : "NIN confirmed against your ID photo — the name will be confirmed by a reviewer.",
  };
}
