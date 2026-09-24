// lib/rateLimit.js — fixed-window in-memory rate limiter (ESM) for Vercel functions.

const buckets = new Map();
const SWEEP_MS = 60_000;
let lastSweep = Date.now();

function sweep(now) {
  if (now - lastSweep < SWEEP_MS) return;
  lastSweep = now;
  for (const [key, bucket] of buckets) {
    if (bucket.resetAt <= now) buckets.delete(key);
  }
}

export function rateLimit(key, max = 10, windowMs = 60_000) {
  const now = Date.now();
  sweep(now);

  let bucket = buckets.get(key);
  if (!bucket || bucket.resetAt <= now) {
    bucket = { count: 0, resetAt: now + windowMs };
    buckets.set(key, bucket);
  }

  if (bucket.count >= max) {
    return {
      ok: false,
      remaining: 0,
      retryAfterSec: Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)),
    };
  }

  bucket.count += 1;
  return { ok: true, remaining: max - bucket.count, retryAfterSec: 0 };
}

export async function clientKey(req, prefix) {
  const auth = req.headers?.authorization || "";
  if (auth.startsWith("Bearer ")) {
    const crypto = await import("node:crypto");
    const short = crypto.createHash("sha256").update(auth).digest("hex").slice(0, 16);
    return `${prefix}:sess:${short}`;
  }
  const ip =
    (req.headers?.["x-forwarded-for"] || "").split(",")[0].trim() ||
    req.socket?.remoteAddress ||
    "unknown";
  return `${prefix}:ip:${ip}`;
}

export async function enforce(req, res, prefix, max, windowMs) {
  const key = await clientKey(req, prefix);
  const result = rateLimit(key, max, windowMs);
  if (!result.ok) {
    res.setHeader("Retry-After", String(result.retryAfterSec));
    res.status(429).json({ error: "Too many requests. Please try again shortly." });
    return false;
  }
  return true;
}
