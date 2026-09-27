// scripts/setup-schema.mjs — one-shot Appwrite schema setup for everything the
// app + paystack-backend + kyc-backend expect to exist.
//
// Safe to re-run: existing collections, attributes and indexes are skipped.
//
// Usage:
//   APPWRITE_ENDPOINT=https://fra.cloud.appwrite.io/v1 \
//   APPWRITE_PROJECT_ID=... \
//   APPWRITE_API_KEY=... \
//   DATABASE_ID=... \
//   TPA_COLLECTION_ID=tempAccounts \
//   node scripts/setup-schema.mjs

const endpoint = (process.env.APPWRITE_ENDPOINT || "https://fra.cloud.appwrite.io/v1").replace(/\/+$/, "");
const projectId = process.env.APPWRITE_PROJECT_ID;
const apiKey = process.env.APPWRITE_API_KEY;
const databaseId = process.env.DATABASE_ID || process.env.APPWRITE_DATABASE_ID;
const tpaCollectionId = process.env.TPA_COLLECTION_ID || "tempAccounts";

if (!projectId || !apiKey || !databaseId) {
  console.error("Missing APPWRITE_PROJECT_ID, APPWRITE_API_KEY or DATABASE_ID.");
  process.exit(1);
}

const headers = {
  "content-type": "application/json",
  "X-Appwrite-Project": projectId,
  "X-Appwrite-Key": apiKey,
};

async function call(method, url, body) {
  const res = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let data = null;
  try {
    data = JSON.parse(text);
  } catch {
    data = { message: text };
  }
  return { status: res.status, data };
}

const exists = (r) => r.status === 409 || /already_exists|already exists/i.test(r.data?.message || "");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- attributes
const str = (key, size, def = "") => ({ type: "string", key, size, required: false, default: def });
const int = (key, def = 0, min = 0, max = 1000000) => ({
  type: "integer",
  key,
  required: false,
  default: def,
  min,
  max,
});
const bool = (key) => ({ type: "boolean", key, required: false, default: false });
const date = (key) => ({ type: "datetime", key, required: false, default: "" });
const double = (key, def = 0) => ({ type: "double", key, required: false, default: def, min: 0 });

const TPA_STRING = [
  str("userId", 255),
  str("status", 20),
  double("amount"),
  double("spent"),
  double("deposited"),
  str("expiresAt", 64),
  str("processedRefs", 4000),
  bool("notice7d"),
  bool("notice1d"),
  bool("noticeExpired"),
  str("createdAt", 64),
  str("updatedAt", 64),
];

const PLAN = [
  {
    label: "users",
    collectionId: process.env.USER_COLLECTION_ID || "6840684e001b7e2a3190",
    // Written by /api/kyc/submit and /api/kyc/approve; read by the app's KYC
    // badge and by the PVA creation gate.
    attributes: [str("kycStatus", 32), int("kycLevel")],
  },
  {
    label: "KYC Submissions",
    collectionId: process.env.KYC_COLLECTION_ID || "6866ca550022ff21e9dc",
    // Fields /api/kyc/submit and /api/kyc/approve write.
    attributes: [
      int("verificationLevel"),
      str("reviewNote", 500),
      date("reviewedAt"),
      date("createdAt"),
      date("updatedAt"),
      str("livenessUrls", 65535),
      str("livenessScores", 65535),
      bool("aiLivenessPassed"),
    ],
  },
  {
    label: "Transactions",
    collectionId: process.env.APPWRITE_TXN_COLLECTION_ID || "6866caf00030b1c752a0",
    attributes: [str("reference", 128), str("kind", 16), str("note", 500), str("source", 32)],
  },
  {
    label: "balance",
    collectionId: process.env.APPWRITE_BALANCE_COLLECTION_ID || "688485f60013ffff20c6",
    attributes: [str("processedRefs", 4000), bool("referralRewardGiven")],
  },
  {
    label: "Temporary Accounts",
    collectionId: tpaCollectionId,
    create: true,
    attributes: TPA_STRING,
    indexes: [{ key: "userId", attributes: ["userId"] }, { key: "status", attributes: ["status"] }],
  },
];

async function ensureCollection(collectionId, name) {
  const r = await call("POST", `${endpoint}/databases/${databaseId}/collections`, {
    collectionId,
    name,
    permissions: [],
  });
  if (exists(r)) return console.log(`collection "${collectionId}" already exists`);
  if (r.status >= 400) throw new Error(`create collection failed: ${r.status} ${r.data?.message}`);
  console.log(`collection "${collectionId}" created`);
}

// REST route name differs from the stored schema type for floating point.
const routeType = (type) => (type === "double" ? "float" : type);
const msg = (data) => String(data?.message || "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").slice(0, 160);

async function ensureAttribute(collectionId, attr) {
  const { type, key, ...rest } = attr;
  const url = `${endpoint}/databases/${databaseId}/collections/${collectionId}/attributes/${routeType(type)}`;
  let r = await call("POST", url, { key, ...rest });
  if (exists(r)) return console.log(`  ${key} ok`);
  // Some attribute types reject a default value on creation — retry without it.
  if (r.status >= 400 && "default" in rest) {
    const { default: _drop, ...noDefault } = rest;
    r = await call("POST", url, { key, ...noDefault });
    if (exists(r)) return console.log(`  ${key} ok`);
  }
  if (r.status >= 400) {
    console.error(`  ${key} FAILED: ${r.status} ${msg(r.data)}`);
    process.exitCode = 1;
    return;
  }
  console.log(`  ${key} created`);
}

async function ensureIndex(collectionId, key, attributes) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const r = await call("POST", `${endpoint}/databases/${databaseId}/collections/${collectionId}/indexes`, {
      key,
      type: "key",
      status: "available",
      attributes,
      orders: attributes.map(() => "ASC"),
    });
    if (exists(r)) return console.log(`  index ${key} ok`);
    if (r.status >= 400 && attempt < 4 && /processing|available/i.test(r.data?.message || "")) {
      await sleep(1500);
      continue;
    }
    if (r.status >= 400) {
      console.error(`  index ${key} FAILED: ${r.status} ${msg(r.data)}`);
      process.exitCode = 1;
      return;
    }
    console.log(`  index ${key} created`);
    return;
  }
}

async function main() {
  for (const group of PLAN) {
    console.log(`\n${group.label} (${group.collectionId})`);
    if (group.create) await ensureCollection(group.collectionId, group.label);
    for (const attr of group.attributes) await ensureAttribute(group.collectionId, attr);
    for (const idx of group.indexes || []) await ensureIndex(group.collectionId, idx.key, idx.attributes);
  }
  console.log("\ndone");
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
