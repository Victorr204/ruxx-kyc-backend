// lib/auth.js — Server-side authentication helper (KYC backend, local copy)
// Verifies the Appwrite session token from the Authorization header
// and returns the authenticated user.

import { Client, Account, Databases, Query } from "node-appwrite";

let clientCache = null;

function getClient() {
  if (clientCache) return clientCache;
  clientCache = new Client()
    .setEndpoint(process.env.APPWRITE_ENDPOINT)
    .setProject(process.env.APPWRITE_PROJECT_ID)
    .setKey(process.env.APPWRITE_API_KEY);
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

  const userClient = new Client()
    .setEndpoint(process.env.APPWRITE_ENDPOINT)
    .setProject(process.env.APPWRITE_PROJECT_ID)
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
