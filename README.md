# ruxx-kyc-backend

KYC verification backend (Vercel serverless). Permanent accounts only — the old temporary-account (TPA) service has been removed.

## Verification flow

1. The app captures the ID, NIN and a guided 5-pose liveness session on-device and posts it to `/api/kyc/submit`.
2. The backend validates the **NIN against the ID photo the user submitted** (in-app OpenAI vision — no third-party NIMC lookup): the entered number must match what is printed on the document, otherwise it is rejected immediately with `NIN_MISMATCH`.
3. It runs the **facial verification** server-side: the live selfie is face-matched against the ID document (OpenAI vision) — a mismatch is rejected with `FACE_MISMATCH`.
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
| `POST /api/kyc/ai/frame` | Legacy OpenAI frame analysis (not used by the app) |
| `POST /api/kyc/ai/face-match` | Legacy OpenAI face match (not used by the app) |
| `GET /api/kyc/ai/health` | Whether OpenAI is configured (not used by the app) |

All `/api/kyc/*` routes except `ai/health` require an Appwrite session `Authorization: Bearer <token>` and are rate-limited.

### Required env (Vercel project)

```
OPENAI_API_KEY=sk-...            # REQUIRED: face match + NIN ↔ ID photo cross-check
OPENAI_MODEL=gpt-4o-mini         # optional
AI_LIVENESS_THRESHOLD=0.75       # optional
AI_FACE_MATCH_THRESHOLD=0.72     # optional
CRON_SECRET=...                  # REQUIRED for the /api/kyc/autoapprove cron (fails closed)
```

Never put `OPENAI_API_KEY` in the Expo app.

### Auto-approve (60 seconds)

A submission is auto-approval-eligible only when **all** checks passed:

- the entered NIN matches what is printed on the ID photo, and the printed name matches the account name (`ninVerified` + `ninNameMatch`)
- server-side face match passed (`faceMatchPassed`)
- client liveness score ≥ `AI_LIVENESS_THRESHOLD`

It then carries `autoApproveAt = submittedAt + 60s` and flips to `approved` (level 3) via whichever fires first:

1. the app polling `/api/kyc/status` (approval lands while the user watches), or
2. the daily `/api/kyc/autoapprove` cron (backstop — the status poll is the primary path).

Admins can still approve or reject during the 60-second window — a rejection is never overwritten (the auto-approver re-reads the doc right before writing).
