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
const myflow = {
  flows: process.env.MYFLOW_FLOWS_COLLECTION || "myflowFlows",
  auths: process.env.MYFLOW_AUTHS_COLLECTION || "myflowAuths",
  execs: process.env.MYFLOW_EXECS_COLLECTION || "myflowExecs",
  events: process.env.MYFLOW_EVENTS_COLLECTION || "myflowEvents",
  settings: process.env.MYFLOW_SETTINGS_COLLECTION || "myflowSettings",
  flags: process.env.MYFLOW_FLAGS_COLLECTION || "myflowUserFlags",
};

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

  // -------------------------------------------------- MyFlow (scheduled purchases)
  {
    label: "MyFlow Flows",
    collectionId: myflow.flows,
    create: true,
    attributes: [
      str("userId", 64),
      str("name", 120),
      str("service", 20),
      str("providerId", 64),
      str("providerName", 60),
      str("productId", 64),
      str("recipient", 64),
      str("recipientType", 20),
      str("recipientName", 255),
      str("meterType", 20),
      double("amount"),
      str("plan", 120),
      str("validity", 60),
      str("priceProtection", 12),
      double("priceCapPct"),
      double("maxPriceCap"),
      str("scheduleType", 16),
      str("scheduleConfig", 4000),
      str("timezone", 64),
      str("startAt", 64),
      str("endAt", 64),
      str("nextRunAt", 64),
      str("status", 16),
      str("pauseCode", 40),
      str("pauseReason", 500),
      str("authorizationId", 64),
      double("perExecutionLimit"),
      double("dailyLimit"),
      double("monthlyLimit"),
      int("maxConsecutiveFailures", 3),
      int("failureCount"),
      int("runCount"),
      str("lastRunAt", 64),
      str("lastResult", 200),
      str("notifyPrefs", 4000),
      str("createdAt", 64),
      str("updatedAt", 64),
      str("stoppedAt", 64),
      str("stopReason", 200),
    ],
    indexes: [
      { key: "userId", attributes: ["userId"] },
      { key: "userIdStatus", attributes: ["userId", "status"] },
      { key: "statusNextRun", attributes: ["status", "nextRunAt"] },
    ],
  },
  {
    label: "MyFlow Authorizations",
    collectionId: myflow.auths,
    create: true,
    attributes: [
      str("userId", 64),
      str("flowId", 64),
      str("method", 16),
      str("signature", 128),
      str("limits", 1000),
      str("status", 16),
      str("authorizedAt", 64),
      str("revokedAt", 64),
    ],
    indexes: [
      { key: "userId", attributes: ["userId"] },
      { key: "flowId", attributes: ["flowId"] },
    ],
  },
  {
    label: "MyFlow Executions",
    collectionId: myflow.execs,
    create: true,
    attributes: [
      str("flowId", 64),
      str("userId", 64),
      str("scheduledFor", 64),
      str("idempotencyKey", 128),
      str("status", 32),
      str("errorCode", 64),
      str("message", 500),
      str("reference", 128),
      str("providerRequestId", 128),
      double("amount"),
      double("faceValue"),
      str("wallet", 16),
      double("balanceBefore"),
      double("balanceAfter"),
      int("retryCount"),
      str("emailStatus", 20),
      str("artifact", 65535),
      str("triggeredBy", 16),
      str("startedAt", 64),
      str("finishedAt", 64),
      str("createdAt", 64),
      str("updatedAt", 64),
    ],
    indexes: [
      // One execution per scheduled run — the money-safety invariant.
      { key: "idempotencyKey", attributes: ["idempotencyKey"], type: "unique" },
      { key: "flowId", attributes: ["flowId"] },
      { key: "userId", attributes: ["userId"] },
      { key: "statusStarted", attributes: ["status", "startedAt"] },
    ],
  },
  {
    label: "MyFlow Events",
    collectionId: myflow.events,
    create: true,
    attributes: [
      str("executionId", 64),
      str("flowId", 64),
      str("type", 40),
      str("at", 64),
      str("data", 2000),
    ],
    indexes: [
      { key: "executionId", attributes: ["executionId"] },
      { key: "flowId", attributes: ["flowId"] },
    ],
  },
  {
    // Singleton doc id "global": platform pause + kill switch, per-service
    // kill switches, configurable platform risk limits, provider circuit state.
    label: "MyFlow Settings",
    collectionId: myflow.settings,
    create: true,
    attributes: [
      bool("paused"),
      bool("killSwitch"),
      str("pauseReason", 500),
      str("disabledServices", 200),
      str("disabledProviders", 2000),
      str("providerHealth", 4000),
      double("platformMaxPerTxn"),
      double("platformMaxPerDay"),
      double("platformMaxPerMonth"),
      str("updatedAt", 64),
    ],
  },
  {
    // Per-user emergency Pause All (§49): one doc per user, id "u_<userId>".
    label: "MyFlow User Flags",
    collectionId: myflow.flags,
    create: true,
    attributes: [
      str("userId", 64),
      bool("paused"),
      str("pausedAt", 64),
      str("resumedAt", 64),
      str("updatedAt", 64),
    ],
    indexes: [{ key: "userId", attributes: ["userId"], type: "unique" }],
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

async function ensureIndex(collectionId, key, attributes, type = "key") {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const r = await call("POST", `${endpoint}/databases/${databaseId}/collections/${collectionId}/indexes`, {
      key,
      type,
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
    for (const idx of group.indexes || []) await ensureIndex(group.collectionId, idx.key, idx.attributes, idx.type);
  }

  // MyFlow settings singleton: created once, never overwritten.
  const settingsR = await call(
    "POST",
    `${endpoint}/databases/${databaseId}/collections/${myflow.settings}/documents`,
    { documentId: "global", data: { paused: false, killSwitch: false, pauseReason: "", updatedAt: "" } }
  );
  if (settingsR.status < 400) console.log(`\n${myflow.settings}: singleton "global" created`);
  else if (exists(settingsR)) console.log(`\n${myflow.settings}: singleton "global" already exists`);
  else console.error(`\n${myflow.settings}: singleton FAILED ${settingsR.status} ${msg(settingsR.data)}`);

  console.log("\ndone");
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
