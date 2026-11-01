# ruxx-kyc-backend

KYC verification backend (Vercel serverless). Permanent accounts only — the old temporary-account (TPA) service has been removed.

## Verification flow

1. The app captures the ID, NIN and a guided 5-pose liveness session on-device and posts it to `/api/kyc/submit`.
2. The backend validates the **NIN against NIMC** (Dojah Lookup NIN) — a wrong NIN is rejected immediately with `NIN_NOT_FOUND`.
3. It runs the **facial verification** server-side: the live selfie is face-matched against the ID document (OpenAI vision) — a mismatch is rejected with `FACE_MISMATCH`.
4. Everything passed → the submission is stored `pending` with `autoApproveAt = submit + 60s`: an admin has the full 60-second window to decide, and if nobody does, the account **approves itself**.
5. Any check unavailable (provider outage, non-NIN ID) → plain admin review, no auto-approval.

| Endpoint | Purpose |
| --- | --- |
| `POST /api/kyc/submit` | Submit KYC: NIMC NIN check + face match + 60s auto-approval window |
| `POST /api/kyc/nin-check` | Inline NIN validation (NIMC via Dojah) for the verify screen |
| `POST /api/kyc/status` | Status view; applies a due 60-second auto-approval lazily on read |
| `POST /api/kyc/autoapprove` | Per-minute cron: approves submissions past their 60s window (`CRON_SECRET`) |
| `POST /api/kyc/approve` | Admin approve/reject/reverify |
| `POST /api/wallet/status` | KYC + permanent prepaid account state for the app |
| `POST /api/kyc/ai/frame` | Legacy OpenAI frame analysis (not used by the app) |
| `POST /api/kyc/ai/face-match` | Legacy OpenAI face match (not used by the app) |
| `GET /api/kyc/ai/health` | Whether OpenAI is configured (not used by the app) |

All `/api/kyc/*` routes except `ai/health` require an Appwrite session `Authorization: Bearer <token>` and are rate-limited.

### Required env (Vercel project)

```
DOJAH_APP_ID=...                 # NIMC NIN lookup (Dojah) — sandbox: DOJAH_SANDBOX=true
DOJAH_SECRET_KEY=...
OPENAI_API_KEY=sk-...            # facial verification (face match on submit)
OPENAI_MODEL=gpt-4o-mini         # optional
AI_LIVENESS_THRESHOLD=0.75       # optional
AI_FACE_MATCH_THRESHOLD=0.72     # optional
CRON_SECRET=...                  # REQUIRED for the /api/kyc/autoapprove cron (fails closed)
```

Never put `DOJAH_SECRET_KEY` or `OPENAI_API_KEY` in the Expo app.

### Auto-approve (60 seconds)

A submission is auto-approval-eligible only when **all** checks passed:

- NIN resolved in NIMC with a matching name (`ninVerified` + `ninNameMatch`)
- server-side face match passed (`faceMatchPassed`)
- client liveness score ≥ `AI_LIVENESS_THRESHOLD`

It then carries `autoApproveAt = submittedAt + 60s` and flips to `approved` (level 3) via whichever fires first:

1. the app polling `/api/kyc/status` (approval lands while the user watches), or
2. the every-minute `/api/kyc/autoapprove` cron (works while the app is closed).

Admins can still approve or reject during the 60-second window — a rejection is never overwritten (the auto-approver re-reads the doc right before writing).
