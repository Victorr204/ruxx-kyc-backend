// lib/dojah.js — NIN validation against NIMC through Dojah's Lookup NIN API.
// Keys stay server-side: DOJAH_APP_ID + DOJAH_SECRET_KEY. Requests carry the
// raw secret key in `Authorization` (no Bearer prefix) and the app id in
// `AppId` — Dojah's documented auth scheme.
//
// checkNin() outcomes:
//   'verified'    — NIMC returned the holder's record: the NIN is genuine
//   'not_found'   — NIMC has no record: the number is wrong (safe to reject)
//   'bad_format'  — not an 11-digit number (local format check first)
//   'unavailable' — provider outage / out of credit / not configured: the
//                   submission must still go through, to admin review
//                   instead of the 60-second auto-approval.

const SANDBOX_BASE = "https://sandbox.dojah.io";
const PROD_BASE = "https://api.dojah.io";

export function dojahConfigured() {
  return Boolean(process.env.DOJAH_APP_ID && process.env.DOJAH_SECRET_KEY);
}

export function dojahBaseUrl() {
  const base = String(process.env.DOJAH_BASE_URL || "").trim();
  if (base) return base.replace(/\/+$/, "");
  return String(process.env.DOJAH_SANDBOX || "").toLowerCase() === "true"
    ? SANDBOX_BASE
    : PROD_BASE;
}

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
 * Whether the submitted name and the NIMC record refer to the same person.
 * Either side may be the subset: an Appwrite account name is often
 * "first last" while NIMC returns "first middle last" — every token of the
 * shorter name must appear in the longer one.
 */
export function namesMatch(submitted, official) {
  const a = nameTokens(submitted);
  const b = nameTokens(official);
  if (!a.length || !b.length) return false;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  return short.every((t) => long.includes(t));
}

/**
 * Look a NIN up against NIMC via Dojah.
 * @param {{ nin: string, fullName?: string }} input
 * @returns {Promise<{ status: string, message: string, entity?: object,
 *   officialName?: string, nameMatch?: boolean }>}
 */
export async function checkNin({ nin, fullName } = {}) {
  if (!isNinFormat(nin)) {
    return { status: "bad_format", message: "NIN must be exactly 11 digits." };
  }
  if (!dojahConfigured()) {
    return { status: "unavailable", message: "NIMC check is not configured." };
  }

  const url = `${dojahBaseUrl()}/api/v1/kyc/nin?${new URLSearchParams({ nin: String(nin).trim() })}`;
  let res;
  try {
    res = await fetch(url, {
      headers: {
        Authorization: process.env.DOJAH_SECRET_KEY,
        AppId: process.env.DOJAH_APP_ID,
      },
    });
  } catch (err) {
    return { status: "unavailable", message: `NIMC lookup unreachable: ${err.message}` };
  }

  if (res.status === 404) {
    return { status: "not_found", message: "No NIMC record exists for this NIN." };
  }
  if (res.status === 401 || res.status === 403) {
    return { status: "unavailable", message: "NIMC check credentials were rejected." };
  }
  if (res.status === 402) {
    return { status: "unavailable", message: "NIMC check is out of credit." };
  }
  if (res.status === 424) {
    return { status: "unavailable", message: "The NIMC source is temporarily unavailable." };
  }
  if (res.status === 429) {
    return { status: "unavailable", message: "NIMC check is busy — try again shortly." };
  }
  if (!res.ok) {
    return { status: "unavailable", message: `NIMC lookup failed (${res.status}).` };
  }

  let data = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  const entity = data?.entity || null;
  if (!entity || !entity.first_name) {
    return { status: "not_found", message: "No NIMC record exists for this NIN." };
  }

  const officialName = [entity.first_name, entity.middle_name, entity.last_name]
    .filter(Boolean)
    .join(" ");
  const nameMatch = namesMatch(fullName, officialName);

  return {
    status: "verified",
    entity: {
      firstName: entity.first_name || "",
      middleName: entity.middle_name || "",
      lastName: entity.last_name || "",
      gender: entity.gender || "",
      dateOfBirth: entity.date_of_birth || "",
    },
    officialName,
    nameMatch,
    message: nameMatch
      ? "NIN verified with NIMC."
      : "NIN exists in NIMC but the name does not match the record.",
  };
}
