# ruxx-kyc-backend

KYC verification backend (Vercel serverless).

## Verification flow

Liveness runs fully in-app (guided capture, scored on-device). This backend validates and stores KYC submissions as `pending` and handles admin approval — the app does not call any cloud AI.

| Endpoint | Purpose |
| --- | --- |
| `POST /api/kyc/submit` | Submit KYC; stored as `pending` for admin review |
| `POST /api/kyc/approve` | Admin approve/reject a submission |
| `POST /api/kyc/ai/frame` | Legacy OpenAI frame analysis (not used by the app) |
| `POST /api/kyc/ai/face-match` | Legacy OpenAI face match (not used by the app) |
| `GET /api/kyc/ai/health` | Whether OpenAI is configured (not used by the app) |

All routes require an Appwrite session `Authorization: Bearer <token>` (health is public) and are rate-limited.

### Required env (Vercel project)

```
OPENAI_API_KEY=sk-...             # optional — only for the legacy ai/* endpoints
OPENAI_MODEL=gpt-4o-mini          # optional
AI_LIVENESS_THRESHOLD=0.75        # optional
KYC_AUTO_APPROVE=false            # true = auto-approve when the client liveness score passes
```

Never put `OPENAI_API_KEY` in the Expo app.

### Auto-approve

`KYC_AUTO_APPROVE` defaults to `false` — every submission goes to admin review. If set to `true`, a submission is auto-approved when the in-app liveness score is at least `AI_LIVENESS_THRESHOLD`. No server-side face match runs anymore.
