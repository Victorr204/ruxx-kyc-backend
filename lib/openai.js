// lib/openai.js — OpenAI vision helpers for KYC liveness + face match.
// API key stays server-side only. Never expose OPENAI_API_KEY to the client.

const OPENAI_URL = "https://api.openai.com/v1/chat/completions";

export function openAiModel() {
  return process.env.OPENAI_MODEL || "gpt-4o-mini";
}

export function isAiConfigured() {
  return !!process.env.OPENAI_API_KEY;
}

export function aiNotConfiguredMessage() {
  return "OpenAI is not configured on the server. Set OPENAI_API_KEY in the KYC backend environment.";
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

/**
 * Call OpenAI chat completions with optional image URLs/data-URLs.
 * Forces JSON object output.
 */
export async function openAiJson({ system, user, images = [], maxTokens = 600, temperature = 0.1 }) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    const err = new Error(aiNotConfiguredMessage());
    err.status = 503;
    throw err;
  }

  const content = [{ type: "text", text: user }];
  for (const url of images) {
    if (!url) continue;
    content.push({
      type: "image_url",
      image_url: { url, detail: "auto" },
    });
  }

  const body = {
    model: openAiModel(),
    temperature,
    max_tokens: maxTokens,
    response_format: { type: "json_object" },
    messages: [
      ...(system ? [{ role: "system", content: system }] : []),
      { role: "user", content },
    ],
  };

  const res = await fetch(OPENAI_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    let detail = "";
    try {
      const errBody = await res.json();
      detail = errBody?.error?.message || "";
    } catch {
      detail = await res.text().catch(() => "");
    }
    const err = new Error(
      res.status === 401
        ? "OpenAI API key is invalid."
        : res.status === 429
        ? "OpenAI rate limit reached. Please try again shortly."
        : `OpenAI request failed${detail ? `: ${detail}` : ` (${res.status})`}`
    );
    err.status = res.status === 401 || res.status === 429 ? res.status : 502;
    throw err;
  }

  const data = await res.json();
  const text = data?.choices?.[0]?.message?.content || "";
  const parsed = parseJsonLoose(text);
  if (!parsed || typeof parsed !== "object") {
    const err = new Error("OpenAI returned an unexpected response. Please try again.");
    err.status = 502;
    throw err;
  }
  return parsed;
}

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

  const result = await openAiJson({
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
    method: "openai-vision",
    engine: openAiModel(),
  };
}

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

  const result = await openAiJson({
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
    method: "openai-vision",
    engine: openAiModel(),
    reason: String(
      result.reason ||
        (passed ? "Document face matches liveness" : "Face similarity too low")
    ).slice(0, 200),
    threshold,
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
    const images = action === "blink" && i + 1 < lives.length ? [lives[i], lives[i + 1]] : [lives[i]];
    try {
      const evaluated = await analyzeLivenessFrames(action, images);
      frameResults.push({ index: i, action, ...evaluated });
      if (action === "blink" && images.length > 1) i += 1;
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
      method: "openai-vision",
      engine: openAiModel(),
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
    method: "openai-vision",
    engine: openAiModel(),
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
