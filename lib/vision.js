/* global Buffer */ // Vercel Node runtime — server-side only module
// lib/vision.js — server-side vision for KYC: liveness frame checks, face
// match, and the NIN document read. Multi-provider by design: free tiers
// first (Google Gemini → Groq), OpenAI as an optional paid fallback. Every
// configured provider gets one attempt — quota exhaustion, an outage or a
// bad key falls through to the next — and only when all of them fail does
// the caller see an error. The KYC flow turns that error into admin review,
// never a hard block.
//
// Keys stay server-side only. Never expose them to the Expo app.
//
// Free keys (no credit card):
//   GEMINI_API_KEY  https://aistudio.google.com
//   GROQ_API_KEY    https://console.groq.com

const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta/models";
const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
const OPENAI_URL = "https://api.openai.com/v1/chat/completions";

// Priority order: the first configured provider is primary.
const PROVIDERS = [
  { name: "gemini", envKey: "GEMINI_API_KEY", method: "gemini-vision" },
  { name: "groq", envKey: "GROQ_API_KEY", method: "groq-vision" },
  { name: "openai", envKey: "OPENAI_API_KEY", method: "openai-vision" },
];

const PROVIDER_TIMEOUT_MS = 20_000;
const IMAGE_FETCH_TIMEOUT_MS = 15_000;
const MAX_IMAGE_BYTES = 6 * 1024 * 1024;

export function geminiModel() {
  // gemini-2.5-flash is 404 for new keys (Google points to the 3.x family);
  // 3.6-flash verified working against the free tier (slip OCR + face match).
  return process.env.GEMINI_MODEL || "gemini-3.6-flash";
}

export function groqModel() {
  // llama-4-scout is 404 on new free accounts; qwen3.8-27b is the vision
  // model actually served (verified: slip OCR + face match).
  return process.env.GROQ_MODEL || "qwen/qwen3.8-27b";
}

export function openAiModel() {
  return process.env.OPENAI_MODEL || "gpt-4o-mini";
}

function modelFor(name) {
  if (name === "gemini") return geminiModel();
  if (name === "groq") return groqModel();
  return openAiModel();
}

function metaFor(name) {
  return PROVIDERS.find((p) => p.name === name);
}

/** Configured providers in priority order (names only). */
export function configuredProviders() {
  return PROVIDERS.filter((p) => Boolean(process.env[p.envKey])).map((p) => p.name);
}

export function isAiConfigured() {
  return configuredProviders().length > 0;
}

export function aiNotConfiguredMessage() {
  return "AI verification is not configured on the server. Set GEMINI_API_KEY (free: https://aistudio.google.com) or GROQ_API_KEY (free: https://console.groq.com) in the KYC backend environment.";
}

/** Model label of the primary configured provider (health endpoint, logs). */
export function aiEngine() {
  const first = configuredProviders()[0];
  return first ? modelFor(first) : null;
}

/** `<provider>-vision` label of the primary configured provider. */
export function aiMethod() {
  const first = configuredProviders()[0];
  return first ? metaFor(first).method : "unconfigured";
}

function clamp01(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) return 0;
  return Math.max(0, Math.min(1, x));
}

function parseJsonLoose(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(text.slice(start, end + 1));
      } catch {
        return null;
      }
    }
    return null;
  }
}

function jsonParseError() {
  const err = new Error("AI returned an unexpected response. Please try again.");
  err.status = 502;
  return err;
}

// --- image loading ---------------------------------------------------------
// Every image (public Appwrite view URL, data: URL from the liveness camera,
// or bare base64) is normalized once, before the provider chain runs, so all
// adapters share the same bytes and a broken URL fails fast instead of once
// per provider.

function parseDataUrl(v) {
  const m = /^data:([^;,]*)((?:;[^;,]*)*),([\s\S]*)$/.exec(v);
  if (!m) throw new Error("malformed data URL");
  const mimeType = (m[1] || "image/jpeg").split(";")[0] || "image/jpeg";
  if (!/;base64/i.test(m[2] || "")) throw new Error("unsupported data URL encoding");
  const base64 = m[3].replace(/\s+/g, "");
  if (base64.length > (MAX_IMAGE_BYTES * 4) / 3 + 1024) throw new Error("image too large");
  return { mimeType, base64, dataUrl: `data:${mimeType};base64,${base64}` };
}

async function loadImage(image) {
  const v = typeof image === "string" ? image.trim() : "";
  if (!v) throw new Error("empty image input");

  if (v.startsWith("data:")) return parseDataUrl(v);

  if (v.startsWith("http://") || v.startsWith("https://")) {
    const res = await fetch(v, { signal: AbortSignal.timeout(IMAGE_FETCH_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`image fetch failed (${res.status})`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > MAX_IMAGE_BYTES) throw new Error("image too large");
    const ct = String(res.headers.get("content-type") || "");
    const mimeType = ct.startsWith("image/") ? ct.split(";")[0].trim() : "image/jpeg";
    const base64 = buf.toString("base64");
    return { mimeType, base64, dataUrl: `data:${mimeType};base64,${base64}` };
  }

  if (/^[A-Za-z0-9+/=\s]+$/.test(v) && v.length > 100) {
    const base64 = v.replace(/\s+/g, "");
    return { mimeType: "image/jpeg", base64, dataUrl: `data:image/jpeg;base64,${base64}` };
  }

  throw new Error("unsupported image input");
}

async function loadImages(images) {
  const list = (Array.isArray(images) ? images : []).filter(Boolean);
  return Promise.all(list.map(loadImage));
}

// --- provider HTTP error mapping -------------------------------------------
// Messages stay user-facing (they surface in the app); details are logged
// server-side for ops.

async function providerHttpError(res, providerName) {
  let detail = "";
  try {
    const body = await res.json();
    detail = body?.error?.message || body?.message || "";
  } catch {
    detail = "";
  }
  console.error(`vision:${providerName} HTTP ${res.status}:`, detail);
  const quota = /insufficient_quota|credit_balance|no credits|RESOURCE_EXHAUSTED|rate.?limit|quota/i.test(detail);
  const err = new Error(
    res.status === 401
      ? "AI service credentials are invalid."
      : res.status === 429
      ? quota
        ? "AI verification is temporarily unavailable. Please try again later."
        : "AI service is busy right now. Please try shortly."
      : `AI request failed${detail ? `: ${detail}` : ` (${res.status})`}`
  );
  err.status = res.status === 401 ? 401 : res.status === 429 ? 429 : 502;
  return err;
}

// --- adapters ---------------------------------------------------------------
// Each adapter receives normalized images and must return a parsed JSON
// object or throw; the chain decides what happens next.

async function callGemini({ system, user, images, maxTokens, temperature }) {
  const url = `${GEMINI_BASE}/${geminiModel()}:generateContent`;
  const parts = [
    { text: user },
    ...images.map((img) => ({ inlineData: { mimeType: img.mimeType, data: img.base64 } })),
  ];
  const build = (generationConfig) => ({
    ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
    contents: [{ role: "user", parts }],
    generationConfig,
  });
  const post = (body) =>
    fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": process.env.GEMINI_API_KEY },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
    });

  // responseMimeType keeps the reply parseable; thinkingBudget:0 keeps the
  // deterministic checks fast and inside maxOutputTokens. Some models reject
  // either field — retry once with a bare generation config before failing.
  let res = await post(
    build({
      temperature,
      maxOutputTokens: maxTokens,
      responseMimeType: "application/json",
      thinkingConfig: { thinkingBudget: 0 },
    })
  );
  if (res.status === 400) {
    res = await post(build({ temperature, maxOutputTokens: maxTokens }));
  }
  if (!res.ok) throw await providerHttpError(res, "gemini");

  const data = await res.json();
  if (data?.promptFeedback?.blockedReason) {
    const err = new Error("AI service could not process this image.");
    err.status = 502;
    throw err;
  }
  const text = (data?.candidates?.[0]?.content?.parts || []).map((p) => p?.text || "").join("");
  const parsed = parseJsonLoose(text);
  if (!parsed || typeof parsed !== "object") throw jsonParseError();
  return parsed;
}

async function callGroq({ system, user, images, maxTokens, temperature }) {
  // Conservative image cap: vision limits vary by Groq model; the document
  // and the strongest liveness frames come first.
  const imgs = images.slice(0, 4);
  const res = await fetch(GROQ_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: groqModel(),
      temperature,
      max_tokens: maxTokens,
      messages: [
        ...(system ? [{ role: "system", content: system }] : []),
        {
          role: "user",
          content: [
            { type: "text", text: user },
            ...imgs.map((img) => ({ type: "image_url", image_url: { url: img.dataUrl } })),
          ],
        },
      ],
    }),
    signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
  });
  if (!res.ok) throw await providerHttpError(res, "groq");

  const data = await res.json();
  const text = data?.choices?.[0]?.message?.content || "";
  const parsed = parseJsonLoose(text);
  if (!parsed || typeof parsed !== "object") throw jsonParseError();
  return parsed;
}

async function callOpenAi({ system, user, images, maxTokens, temperature }) {
  const res = await fetch(OPENAI_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: openAiModel(),
      temperature,
      max_tokens: maxTokens,
      response_format: { type: "json_object" },
      messages: [
        ...(system ? [{ role: "system", content: system }] : []),
        {
          role: "user",
          content: [
            { type: "text", text: user },
            ...images.map((img) => ({ type: "image_url", image_url: { url: img.dataUrl, detail: "auto" } })),
          ],
        },
      ],
    }),
    signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
  });
  if (!res.ok) throw await providerHttpError(res, "openai");

  const data = await res.json();
  const text = data?.choices?.[0]?.message?.content || "";
  const parsed = parseJsonLoose(text);
  if (!parsed || typeof parsed !== "object") throw jsonParseError();
  return parsed;
}

const ADAPTERS = { gemini: callGemini, groq: callGroq, openai: callOpenAi };

function aggregateError(failures) {
  const credsOnly = failures.every((f) => f.status === 401);
  const quotaOnly = failures.every((f) => f.status === 429);
  const err = new Error(
    credsOnly
      ? "AI service credentials are invalid."
      : "AI verification is temporarily unavailable. Please try again later."
  );
  err.status = credsOnly ? 401 : quotaOnly ? 429 : 502;
  return err;
}

/**
 * One vision-JSON call across the configured provider chain.
 * @returns {Promise<{ data: object, provider: string, engine: string }>}
 *   data is the model's JSON object; provider/engine name which one served it.
 * @throws if no provider is configured, the images cannot be loaded, or every
 *   configured provider fails (details of each attempt are logged).
 */
export async function visionJson({ system, user, images = [], maxTokens = 600, temperature = 0.1 } = {}) {
  const providers = configuredProviders();
  if (!providers.length) {
    const err = new Error(aiNotConfiguredMessage());
    err.status = 503;
    throw err;
  }

  let loaded;
  try {
    loaded = await loadImages(images);
  } catch (e) {
    const err = new Error(`We couldn't load the verification image (${e.message}).`);
    err.status = 502;
    throw err;
  }

  const failures = [];
  for (const name of providers) {
    try {
      const data = await ADAPTERS[name]({ system, user, images: loaded, maxTokens, temperature });
      return { data, provider: name, engine: modelFor(name) };
    } catch (err) {
      failures.push({ provider: name, status: err.status || 500, message: err.message });
      console.error(`vision:${name} failed (${err.status || "n/a"}):`, err.message);
    }
  }
  throw aggregateError(failures);
}

// --- liveness ---------------------------------------------------------------

const LIVENESS_SYSTEM = [
  "You are a strict KYC liveness detection engine.",
  "You receive one or more selfie-camera frames (JPEG).",
  "The front camera may be mirrored: judge LEFT/RIGHT from the PERSON's own left/right shoulder, not the image.",
  "Exactly one face must be visible for a pass. Reject multiple faces, no face, heavy blur, or faces too small.",
  "Respond with JSON only.",
].join(" ");

const ACTION_RULES = {
  front:
    "Action 'front': the person looks straight into the camera, head upright, eyes open, face centered.",
  left:
    "Action 'left': the person has turned their head toward THEIR OWN left (nose toward left shoulder). Moderate turn (about 20–60 degrees). Not extreme.",
  right:
    "Action 'right': the person has turned their head toward THEIR OWN right (nose toward right shoulder). Moderate turn (about 20–60 degrees). Not extreme.",
  blink:
    "Action 'blink': at least one frame shows eyes clearly closed or mid-blink (or a clear open→closed→open sequence across frames). If all frames only show wide-open eyes with no blink, ok=false.",
  up:
    "Action 'up': the person has tilted their head upward (chin lifted, gaze slightly up). Moderate tilt. Not extreme.",
};

const FRAME_SCHEMA =
  'JSON shape: {"ok":boolean,"reason":string,"faceCount":number,"confidence":number,"eyesOpen":boolean,"eyesClosed":boolean} ' +
  "confidence is 0..1. reason is a short user-facing hint (e.g. 'Look straight ahead'). ok must be true only when the pose clearly matches.";

/**
 * Evaluate liveness frame(s) for a given action.
 * @param {"front"|"left"|"right"|"blink"|"up"} action
 * @param {string[]} images data: URLs or https URLs
 */
export async function analyzeLivenessFrames(action, images) {
  const rules = ACTION_RULES[action];
  if (!rules) {
    const err = new Error("Unknown liveness action");
    err.status = 400;
    throw err;
  }
  if (!images?.length) {
    const err = new Error("No images provided for liveness analysis");
    err.status = 400;
    throw err;
  }

  const user = [
    rules,
    action === "blink" && images.length > 1
      ? `You received ${images.length} frames captured in sequence for blink detection.`
      : "You received a single frame for this pose check.",
    FRAME_SCHEMA,
  ].join("\n");

  const { data: result, provider, engine } = await visionJson({
    system: LIVENESS_SYSTEM,
    user,
    images: images.slice(0, 4),
    maxTokens: 400,
  });

  const faceCount = Number.isFinite(Number(result.faceCount)) ? Math.max(0, Math.round(Number(result.faceCount))) : 0;
  const confidence = clamp01(result.confidence);
  const ok = result.ok === true && faceCount === 1 && confidence >= 0.45;

  return {
    ok,
    reason: ok
      ? "Pose confirmed"
      : String(result.reason || "Hold the pose and try again").slice(0, 160),
    faceCount,
    confidence,
    eyesOpen: result.eyesOpen !== false,
    eyesClosed: result.eyesClosed === true,
    action,
    method: metaFor(provider).method,
    engine,
  };
}

// --- face match --------------------------------------------------------------

const FACE_MATCH_SYSTEM = [
  "You are a KYC identity face-matching engine.",
  "Image 1 is a photo of an ID document (or a portrait from it).",
  "The remaining images are live selfie frames from a liveness check.",
  "Decide whether the live face is the SAME PERSON as the ID face.",
  "Judge identity from bone structure, eyes, nose, mouth, face shape — not skin tone, lighting, or photo quality alone.",
  "Reject if either side has no clear single face, or if faces clearly differ.",
  "Respond with JSON only.",
].join(" ");

const FACE_MATCH_SCHEMA =
  'JSON shape: {"passed":boolean,"score":number,"reason":string,"documentFaceFound":boolean,"livenessFaceFound":boolean} ' +
  "score is 0..1 similarity (>=0.72 usually passes for the same person). reason is short and user-facing.";

/**
 * Match an ID document face against liveness selfie frame(s).
 * @param {string} documentImage https or data: URL
 * @param {string[]} livenessImages https or data: URLs
 */
export async function matchFaces(documentImage, livenessImages) {
  if (!documentImage) {
    const err = new Error("Document image is required");
    err.status = 400;
    throw err;
  }
  const lives = (Array.isArray(livenessImages) ? livenessImages : []).filter(Boolean).slice(0, 4);
  if (!lives.length) {
    const err = new Error("At least one liveness image is required");
    err.status = 400;
    throw err;
  }

  const user = [
    FACE_MATCH_SCHEMA,
    `Liveness frames provided: ${lives.length}.`,
  ].join("\n");

  const { data: result, provider, engine } = await visionJson({
    system: FACE_MATCH_SYSTEM,
    user,
    images: [documentImage, ...lives],
    maxTokens: 400,
    temperature: 0,
  });

  const score = clamp01(result.score);
  const documentFaceFound = result.documentFaceFound !== false;
  const livenessFaceFound = result.livenessFaceFound !== false;
  const threshold = Number(process.env.AI_FACE_MATCH_THRESHOLD) || 0.72;
  const passed =
    result.passed === true && documentFaceFound && livenessFaceFound && score >= threshold;

  return {
    passed,
    score: Math.round(score * 100) / 100,
    documentFaceFound,
    livenessFaceFound,
    framesCompared: lives.length,
    method: metaFor(provider).method,
    engine,
    reason: String(
      result.reason ||
        (passed ? "Document face matches liveness" : "Face similarity too low")
    ).slice(0, 200),
    threshold,
  };
}

// --- NIN document read -------------------------------------------------------

const NIN_SLIP_SYSTEM = [
  "You are a KYC document reader for Nigerian identity documents.",
  "Image 1 is a photo of a NIN slip or NIN card.",
  "Extract the 11-digit NIN and the full name exactly as printed on it.",
  "The NIN never starts with 0 — a phone number printed on the document does.",
  "If the image is unreadable, missing, or not a NIN document, set readable=false.",
  "Respond with JSON only.",
].join(" ");

const NIN_SLIP_SCHEMA =
  'JSON shape: {"readable":boolean,"nin":string,"fullName":string,"reason":string} ' +
  "nin is the 11-digit NIN printed on the document, digits only; fullName is the printed name. " +
  "reason is a short user-facing hint, used only when readable=false.";

/**
 * Read the NIN and the printed name off a photographed NIN slip/card.
 * Used by the in-app NIN validator: the entered number must match what is
 * printed on the document the user photographed.
 * @param {string} documentImage https or data: URL
 */
export async function readNinSlip(documentImage) {
  if (!documentImage) {
    const err = new Error("Document image is required");
    err.status = 400;
    throw err;
  }

  const { data: result, provider, engine } = await visionJson({
    system: NIN_SLIP_SYSTEM,
    user: NIN_SLIP_SCHEMA,
    images: [documentImage],
    maxTokens: 300,
    temperature: 0,
  });

  const nin = String(result.nin || "").replace(/\D/g, "");
  // A NIN never starts with 0 — if the model latched onto a phone number
  // printed on the document, treat the photo as unreadable (admin review,
  // never a hard reject).
  const readable = result.readable === true && /^[1-9]\d{10}$/.test(nin);

  return {
    readable,
    nin,
    fullName: readable ? String(result.fullName || "").trim().slice(0, 120) : "",
    reason:
      String(result.reason || "").trim().slice(0, 160) ||
      "The NIN printed on your ID photo is unclear — retake the photo in good light.",
    method: metaFor(provider).method,
    engine,
  };
}

/**
 * Server-side re-check used on KYC submit (inbuilt AI verification).
 * Re-validates liveness frames against expected step order + re-matches ID vs live face.
 */
export async function verifySubmissionWithAi({ documentUrl, livenessUrls, stepActions = [] }) {
  const lives = (livenessUrls || []).filter(Boolean);
  const steps = stepActions.length
    ? stepActions
    : ["front", "left", "right", "blink", "up"].slice(0, Math.max(lives.length, 0));

  const frameResults = [];
  for (let i = 0; i < lives.length; i++) {
    const action = steps[i] || "front";
    try {
      const evaluated = await analyzeLivenessFrames(action, [lives[i]]);
      frameResults.push({ index: i, action, ...evaluated });
    } catch (e) {
      frameResults.push({
        index: i,
        action,
        ok: false,
        reason: e.message || "Frame analysis failed",
        confidence: 0,
      });
    }
  }

  const livenessPassed = frameResults.length > 0 && frameResults.every((f) => f.ok);
  const avgConfidence = frameResults.length
    ? frameResults.reduce((a, f) => a + (f.confidence || 0), 0) / frameResults.length
    : 0;

  let faceMatch;
  try {
    faceMatch = await matchFaces(documentUrl, lives);
  } catch (e) {
    faceMatch = {
      passed: false,
      score: 0,
      reason: e.message || "Face match failed",
      method: aiMethod(),
      engine: aiEngine(),
    };
  }

  const livenessThreshold = Number(process.env.AI_LIVENESS_THRESHOLD) || 0.75;
  const livenessScore = Math.min(
    1,
    Math.round((avgConfidence * 0.7 + (livenessPassed ? 0.3 : 0)) * 100) / 100
  );

  const passed =
    livenessPassed &&
    livenessScore >= livenessThreshold &&
    faceMatch.passed &&
    faceMatch.score >= (faceMatch.threshold || 0.72);

  return {
    passed,
    livenessPassed,
    livenessScore,
    livenessThreshold,
    frameResults,
    faceMatch,
    method: faceMatch.method || aiMethod(),
    engine: faceMatch.engine || aiEngine(),
    verifiedAt: new Date().toISOString(),
    reason: passed
      ? "Server AI confirmed liveness and ID face match"
      : !livenessPassed
      ? "Server AI rejected one or more liveness frames"
      : !faceMatch.passed
      ? `Server AI face match failed: ${faceMatch.reason}`
      : "Server AI score below threshold",
  };
}