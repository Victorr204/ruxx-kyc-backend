# ruxx-kyc-backend

KYC verification backend (Vercel serverless). Permanent accounts only — the old temporary-account (TPA) service has been removed.

## Verification flow

1. The app captures the ID, NIN and a guided 5-pose liveness session on-device and posts it to `/api/kyc/submit`.
2. The backend validates the **NIN against the ID photo the user submitted** (in-app vision AI — no third-party NIMC lookup): the entered number must match what is printed on the document, otherwise it is rejected immediately with `NIN_MISMATCH`.
3. It runs the **facial verification** server-side: the live selfie is face-matched against the ID document (vision AI) — a mismatch is rejected with `FACE_MISMATCH`.
4. Everything passed → the submission is stored `pending` with `autoApproveAt = submit + 60s`: an admin has the full 60-second window to decide, and if nobody does, the account **approves itself**.
5. Any check unavailable (unreadable ID photo, non-NIN ID) → plain admin review, no auto-approval.

| Endpoint | Purpose |
| --- | --- |
| `POST /api/kyc/submit` | Submit KYC: NIN ↔ ID photo cross-check + face match + 60s auto-approval window |
| `POST /api/kyc/nin-check` | Inline NIN format pre-check for the verify screen (the cross-check runs on submit) |
| `POST /api/kyc/status` | Status view; applies a due 60-second auto-approval lazily on read |
| `POST /api/kyc/autoapprove` | Daily cron (Hobby-plan limit): approves submissions past their 60s window (`CRON_SECRET`). Lazy approval on `/api/kyc/status` reads is the primary path. |
| `POST /api/kyc/approve` | Admin approve/reject/reverify |
| `POST /api/wallet/status` | KYC + permanent prepaid account state for the app |
| `POST /api/kyc/ai/frame` | Legacy liveness frame analysis (not used by the app) |
| `POST /api/kyc/ai/face-match` | Legacy face match (not used by the app) |
| `GET /api/kyc/ai/health` | Whether the vision AI is configured (not used by the app) |

All `/api/kyc/*` routes except `ai/health` require an Appwrite session `Authorization: Bearer <token>` and are rate-limited.

### Required env (Vercel project)

Vision AI runs on a **provider chain — free tiers first** (`lib/vision.js`):
Gemini (one attempt per model in `GEMINI_MODELS`, then) → Groq → OpenAI.
Quota exhaustion or an outage falls through to the next model/provider, a
short announced 429 wait ("retry in 17.7s") is honored once instead of
failing, and if everything fails the submission degrades to admin review
(never a hard block). Verified free-tier limits on a fresh key:
`gemini-3.6-flash` = 20 req/day (why the lite models are primary),
lite models = 15 req/min with far higher daily caps, Groq qwen = 7k input
tokens/min.

```
GEMINI_API_KEY=...               # primary — FREE, no card: https://aistudio.google.com
GEMINI_MODELS=gemini-3.1-flash-lite,gemini-3.5-flash-lite  # optional (verified free-tier defaults)
GROQ_API_KEY=...                 # fallback — FREE, no card: https://console.groq.com
GROQ_MODEL=qwen/qwen3.8-27b      # optional
OPENAI_API_KEY=sk-...            # optional paid fallback (only if the free tiers fail)
OPENAI_MODEL=gpt-4o-mini         # optional
AI_LIVENESS_THRESHOLD=0.75       # optional
AI_FACE_MATCH_THRESHOLD=0.72     # optional
CRON_SECRET=...                  # REQUIRED for the /api/kyc/autoapprove cron (fails closed)
```

At least one vision key is REQUIRED for face match + the NIN ↔ ID photo
cross-check. Never put any AI key in the Expo app.

### Auto-approve (60 seconds)

A submission is auto-approval-eligible only when **all** checks passed:

- the entered NIN matches what is printed on the ID photo, and the printed name matches the account name (`ninVerified` + `ninNameMatch`)
- server-side face match passed (`faceMatchPassed`)
- client liveness score ≥ `AI_LIVENESS_THRESHOLD`

It then carries `autoApproveAt = submittedAt + 60s` and flips to `approved` (level 3) via whichever fires first:

1. the app polling `/api/kyc/status` (approval lands while the user watches), or
2. the daily `/api/kyc/autoapprove` cron (backstop — the status poll is the primary path).

Admins can still approve or reject during the 60-second window — a rejection is never overwritten (the auto-approver re-reads the doc right before writing).
