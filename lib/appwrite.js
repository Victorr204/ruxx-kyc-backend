import { Client, Databases } from "node-appwrite";
import { requireEnv } from "./env.js";

let databasesCache = null;

// Lazy init: never run Client setup at module load, so a missing env var
// surfaces as a JSON 500 from the handler instead of a load-time crash.
export function getDatabases() {
  if (databasesCache) return databasesCache;
  const client = new Client()
    .setEndpoint(requireEnv("APPWRITE_ENDPOINT"))
    .setProject(requireEnv("APPWRITE_PROJECT_ID"))
    .setKey(requireEnv("APPWRITE_API_KEY"));
  databasesCache = new Databases(client);
  return databasesCache;
}
