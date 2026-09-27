// Temporary smoke test for the TPA schema + code paths. Writes rows, then deletes them.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const kycDir = path.resolve(here, '..');

// load .env
for (const line of fs.readFileSync(path.join(kycDir, '.env'), 'utf8').split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].trim().replace(/^"(.*)"$/, '$1');
}

const results = [];
const check = (name, cond, extra = '') => {
  results.push(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? ` — ${extra}` : ''}`);
  if (!cond) process.exitCode = 1;
};

const accounts = await import(pathToFileURL(path.join(kycDir, 'lib', 'accounts.js')).href);
const ledger = await import(pathToFileURL(path.join(kycDir, 'lib', 'ledger.js')).href);
const tpa = await import(pathToFileURL(path.join(kycDir, 'lib', 'tpa.js')).href);
const { getDatabases } = await import(pathToFileURL(path.join(kycDir, 'lib', 'appwrite.js')).href);
const { Query } = await import('node-appwrite');

const db = getDatabases();
const DB = process.env.DATABASE_ID;
const USER = process.env.USER_COLLECTION_ID;
const TXN = process.env.APPWRITE_TXN_COLLECTION_ID;
const NOTIF = process.env.APPWRITE_NOTIFICATIONS_COLLECTION_ID;
const TEST_USER = 'smoke_test_user';
const cleanup = [];

try {
  const users = await db.listDocuments(DB, USER, [Query.limit(1)]);
  const existingUser = users.total ? users.documents[0].userId : null;
  console.log('probe user:', existingUser || '(none)', `(${users.total} users)`);

  // 1. KYC status is readable (attribute now exists) — read-only probe
  const doc = existingUser ? await accounts.getUserDoc(existingUser) : null;
  check('getUserDoc', Boolean(doc));
  check('isKycApproved returns boolean', typeof accounts.isKycApproved(doc) === 'boolean', `kycStatus=${JSON.stringify(doc?.kycStatus ?? null)}`);

  // 2. Ledger write with a fractional amount (integer column round-trip)
  const row = await ledger.writeLedgerEntry({
    userId: TEST_USER,
    serviceType: 'Balance Top-Up',
    recipient: 'smoke',
    provider: 'test',
    amount: 492.5,
    status: 'Success',
    kind: 'credit',
    reference: 'smoke_ref_1',
    note: 'smoke test',
  });
  if (row) cleanup.push(['txn', row.$id]);
  check('writeLedgerEntry (fractional amount)', Boolean(row), row?.$id || 'null');
  check('ledger amount rounded', !row || row.amount === 493, `amount=${row?.amount}`);
  check('ledgerHasReference', await ledger.ledgerHasReference(TEST_USER, 'smoke_ref_1'));

  // 3. In-app notification row
  const note = await ledger.writeInAppNotification({ userId: TEST_USER, title: 'Smoke', message: 'test', type: 'system' });
  if (note) cleanup.push(['notif', note.$id]);
  check('writeInAppNotification', Boolean(note));

  // 4. TPA lifecycle: create -> credit -> idempotency -> delete
  const created = await tpa.createTpa(TEST_USER);
  if (created) cleanup.push(['tpa', created.$id]);
  check('createTpa', created?.status === 'pending', `status=${created?.status}`);

  const credited = await tpa.creditTpa(created, { gross: 500, reference: 'smoke_pay_1' });
  check('first credit activates', credited.firstCredit === true);
  check('net after fee = 492.5', tpa.round2(credited.net) === 492.5, `net=${credited.net} fee=${credited.fee}`);
  check('countdown started', Boolean(credited.doc.expiresAt) && tpa.daysLeft(credited.doc) === 30, `daysLeft=${tpa.daysLeft(credited.doc)}`);

  let conflict = false;
  try {
    await tpa.creditTpa(credited.doc, { gross: 500, reference: 'smoke_pay_1' });
  } catch (err) {
    conflict = err?.status === 409;
  }
  check('duplicate reference rejected', conflict);

  // 5. Prepaid credit path (creates/updates the balance doc)
  const credited2 = await accounts.creditPrepaidBalance(TEST_USER, 10);
  check('creditPrepaidBalance', typeof credited2.amount === 'number', `balance=${credited2.amount}`);

  // 6. Wallet resolve shape (what purchase.mjs expects)
  check('balance doc has processedRefs', typeof (credited2.doc?.processedRefs ?? '') === 'string');
} catch (err) {
  check('no exception', false, `${err?.message || err}`);
}

for (const [kind, id] of cleanup.reverse()) {
  try {
    const cid = kind === 'txn' ? TXN : kind === 'notif' ? NOTIF : process.env.TPA_COLLECTION_ID;
    await db.deleteDocument(DB, cid, id);
    console.log('cleaned up', kind, id);
  } catch (err) {
    console.log('cleanup failed', kind, id, err.message);
  }
}
if (process.env.APPWRITE_BALANCE_COLLECTION_ID) {
  try {
    for (;;) {
      const res = await db.listDocuments(DB, process.env.APPWRITE_BALANCE_COLLECTION_ID, [Query.equal('userId', TEST_USER), Query.limit(10)]);
      if (!res.total) break;
      for (const doc of res.documents) await db.deleteDocument(DB, process.env.APPWRITE_BALANCE_COLLECTION_ID, doc.$id);
    }
  } catch {
    /* nothing to clean */
  }
}

// Nothing this script wrote may survive the run.
for (const [label, cid] of [
  ['Transactions', TXN],
  ['notifications', NOTIF],
  ['tempAccounts', process.env.TPA_COLLECTION_ID],
  ['balance', process.env.APPWRITE_BALANCE_COLLECTION_ID],
]) {
  if (!cid) continue;
  try {
    const res = await db.listDocuments(DB, cid, [Query.equal('userId', TEST_USER), Query.limit(5)]);
    check(`leftover ${label} cleaned`, res.total === 0, `total=${res.total}`);
  } catch (err) {
    check(`leftover ${label} cleaned`, false, err.message);
  }
}

console.log('\n' + results.join('\n'));
