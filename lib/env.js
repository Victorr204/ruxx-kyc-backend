// lib/env.js — Validated environment access for serverless handlers.
// Throws a structured error so callers can return a clear JSON response
// instead of a FUNCTION_INVOCATION_FAILED crash at module load.

export function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw {
      status: 500,
      message: `Server config error: missing ${name}. Set APPWRITE_ENDPOINT, APPWRITE_PROJECT_ID, APPWRITE_API_KEY, DATABASE_ID, KYC_COLLECTION_ID and USER_COLLECTION_ID in the KYC backend environment on Vercel (all environments).`,
    };
  }
  return value;
}
