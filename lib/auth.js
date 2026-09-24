// lib/auth.js — Server-side authentication helper (KYC backend, local copy)
// Verifies the Appwrite session token from the Authorization header
// and returns the authenticated user.

import { Client, Account, Databases, Query } from "node-appwrite";
import { requireEnv } from "./env.js";

let clientCache = null;

function getClient() {
  if (clientCache) return clientCache;
  clientCache = new Client()
    .setEndpoint(requireEnv("APPWRITE_ENDPOINT"))
    .setProject(requireEnv("APPWRITE_PROJECT_ID"))
    .setKey(requireEnv("APPWRITE_API_KEY"));
  return clientCache;
}

/**
 * Verify the request has a valid Appwrite session.
 * Returns the authenticated user object or throws.
 */
export async function verifySession(req) {
  const authHeader = req.headers?.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    throw { status: 401, message: "Missing or invalid Authorization header" };
  }

  const secret = authHeader.replace("Bearer ", "");

  // Appwrite omits `secret` from client-side session responses, so the app may
  // send a short-lived JWT minted from the user's active session instead.
  // JWTs have three dot-separated segments; session secrets do not.
  if (secret.split(".").length === 3) {
    try {
      const resp = await fetch(`${requireEnv("APPWRITE_ENDPOINT")}/account`, {
        headers: {
          "X-Appwrite-Project": requireEnv("APPWRITE_PROJECT_ID"),
          "X-Appwrite-JWT": secret,
        },
      });
      if (!resp.ok) throw new Error("JWT rejected");
      return await resp.json();
    } catch {
      throw { status: 401, message: "Invalid or expired session" };
    }
  }

  const userClient = new Client()
    .setEndpoint(requireEnv("APPWRITE_ENDPOINT"))
    .setProject(requireEnv("APPWRITE_PROJECT_ID"))
    .setSession(secret);

  const account = new Account(userClient);
  try {
    const user = await account.get();
    return user;
  } catch {
    throw { status: 401, message: "Invalid or expired session" };
  }
}

/**
 * Verify the request has a valid Appwrite session AND the user is an admin.
 * Returns the authenticated user or throws.
 */
export async function verifyAdmin(req) {
  const user = await verifySession(req);

  const client = getClient();
  const databases = new Databases(client);

  const docs = await databases.listDocuments(
    process.env.DATABASE_ID,
    process.env.USER_COLLECTION_ID,
    [Query.equal("userId", user.$id)]
  );

  if (!docs.total || docs.documents[0].role !== "admin") {
    throw { status: 403, message: "Admin access required" };
  }

  return user;
}

/**
 * Verify session and return the user, ensuring it matches the
 * requested userId in the body (if provided).
 */
export async function verifySessionUser(req, requestedUserId) {
  const user = await verifySession(req);

  if (requestedUserId && requestedUserId !== user.$id) {
    throw { status: 403, message: "userId does not match authenticated user" };
  }

  return user;
}
