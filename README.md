# ruxx-kyc-backend

KYC verification backend (Vercel serverless).

## AI (OpenAI cloud vision)

Face detection, liveness pose checks, and ID-vs-liveness face match run on **OpenAI** via this backend — no on-device ML Kit.

| Endpoint | Purpose |
| --- | --- |
| `POST /api/kyc/ai/frame` | Analyze liveness frame(s) for a pose action |
| `POST /api/kyc/ai/face-match` | Match ID document face vs liveness selfies |
| `GET/POST /api/kyc/ai/health` | Auth + whether OpenAI is configured |
| `POST /api/kyc/submit` | Submit KYC; re-verifies with OpenAI when configured |

All AI routes require an Appwrite session `Authorization: Bearer <token>` and are rate-limited.

### Required env (Vercel project)

```
OPENAI_API_KEY=sk-...
OPENAI_MODEL=gpt-4o-mini          # optional
AI_LIVENESS_THRESHOLD=0.75        # optional
AI_FACE_MATCH_THRESHOLD=0.72      # optional
KYC_AUTO_APPROVE=false            # true = auto-approve when client + server AI both pass
```

Never put `OPENAI_API_KEY` in the Expo app.

### Server AI re-check

On submit, if `OPENAI_API_KEY` is set, the server re-runs liveness frame analysis and face match on the uploaded Cloudinary URLs before any auto-approve. Client scores alone are not enough when server AI is enabled.
