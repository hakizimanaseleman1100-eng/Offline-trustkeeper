import Dexie from 'dexie';

// Single database instance for the whole app
export const db = new Dexie('SovereignOS');

/*
 * Schema notes:
 * - The string lists ONLY indexed properties. Non-indexed fields
 *   (price, total_price, payment_method) are still stored — they
 *   just can't be used in .where() lookups.
 * - '++id' = auto-incrementing primary key.
 * - synced_status is stored as a NUMBER (0 = unsynced, 1 = synced),
 *   NOT a boolean. IndexedDB cannot index boolean values, so using
 *   0/1 lets you efficiently query unsynced rows later:
 *   db.sales.where('synced_status').equals(0)
 */
const STARTER_MENU = [
  { name: 'Primus Small', category: 'Beverages', price: 1000 },
  { name: 'Mutzig', category: 'Beverages', price: 1500 },
  { name: 'Skol', category: 'Beverages', price: 1200 },
  { name: 'Soda / Fanta', category: 'Beverages', price: 800 },
  { name: 'Water', category: 'Beverages', price: 500 },
  { name: 'Amstel', category: 'Beverages', price: 1800 },
  { name: 'Single Room', category: 'Motel Rooms', price: 15000 },
  { name: 'Double Room', category: 'Motel Rooms', price: 25000 },
  { name: 'VIP Suite', category: 'Motel Rooms', price: 40000 },
];

db.version(1).stores({
  inventory: '++id, name, category',
  sales: '++id, item_id, timestamp, synced_status',
});

// version(2) has the same schema — it exists only to seed inventory for
// browsers that already created the v1 database before seeding was added.
db.version(2)
  .stores({
    inventory: '++id, name, category',
    sales: '++id, item_id, timestamp, synced_status',
  })
  .upgrade(async (tx) => {
    if ((await tx.table('inventory').count()) === 0) {
      await tx.table('inventory').bulkAdd(STARTER_MENU);
    }
  });

/*
 * version(3): adds open-tab support.
 * - active_tabs gets a `status` field ('open' | 'paid') in addition to the
 *   requested id/name/created_at. Without it there'd be no way to tell
 *   which tabs still belong on the home screen vs. which are settled —
 *   and deleting a tab on payment would orphan its sales rows, which still
 *   need tab_id to know what's safe to sync. Tabs are kept around marked
 *   'paid' rather than deleted.
 * - sales gains an indexed tab_id so a tab's order items can be queried
 *   directly with .where('tab_id').equals(id).
 */
db.version(3).stores({
  inventory: '++id, name, category',
  sales: '++id, item_id, tab_id, timestamp, synced_status',
  active_tabs: '++id, name, created_at, status',
});

/*
 * version(4) + version(5): inventory becomes a synced mirror of Supabase
 * `products`, not locally-seeded demo data.
 * - Primary key switches from a locally auto-incrementing '++id' to a
 *   plain 'id' — it must hold the SAME id as the Supabase row, since
 *   sales.item_id has to resolve against it after a down-sync wipes and
 *   refills this table.
 * - Dexie cannot change a table's primary key in a single version step
 *   ("UpgradeError: Not yet support for changing primary key") — the old
 *   object store has to be deleted, then recreated with the new keyPath
 *   in the NEXT version. Hence two steps instead of one. Existing local
 *   inventory rows are lost here either way; that's fine, the next
 *   online load's down-sync repopulates the table from the server.
 * - item_code is indexed for future receipt/barcode lookups. item_name,
 *   unit_price, cost_price, tax_label, tax_rate are stored but unindexed.
 */
db.version(4).stores({
  inventory: null,
});

db.version(5).stores({
  inventory: 'id, item_code, category',
});

/*
 * version(6): adds a local audit trail for destructive POS actions
 * (removing a cart item, voiding a whole tab). Logged BEFORE the delete
 * happens, so even if the rest of the operation fails partway, there's
 * still a record that someone attempted it. Synced to Supabase the same
 * way sales are — synced_status 0/1, never a boolean, for the same
 * indexing reason noted above.
 */
db.version(6).stores({
  audit_logs: '++id, action_type, timestamp, synced_status',
});

/*
 * version(7): local mirror of the Supabase `staff` table for PIN login.
 * - Primary key is a plain 'id' holding the SAME id as the Supabase row (a
 *   uuid) — every staff account, including the owner, is created server-side
 *   (see OwnerPinSetup / the Team tab) and mirrored here. Nothing is seeded
 *   locally: old builds seeded a default-PIN owner, which was a backdoor.
 * - pin_hash is indexed so login is a single .where('pin_hash') lookup.
 *   `active` is stored but not indexed (IndexedDB can't index booleans);
 *   it's checked in JS after the hash match.
 */
db.version(7).stores({
  staff: 'id, business_id, pin_hash',
});

/*
 * version(8): a tiny key/value store for device-local counters and settings.
 * Used for the fiscal receipt sequence ('receipt_seq') and a stable per-device
 * id ('device_id'). Kept separate from business data so it never syncs — these
 * are properties of THIS device, not the business.
 */
db.version(8).stores({
  meta: 'key',
});

/*
 * version(9): local mirrors for multi-station support.
 * - stations: the venue's selling points (for names + station picker).
 * - station_stock: per-station on-hand, keyed by a compound [station_id+
 *   product_id] so a station's stock is one .where('station_id') lookup and a
 *   single line updates by [station_id, product_id]. product_id is stored as a
 *   string to stay type-agnostic against products.id.
 */
db.version(9).stores({
  stations: 'id, business_id',
  station_stock: '[station_id+product_id], station_id, product_id',
});

/*
 * version(10): local mirror of the Supabase `customers` table so a signed-in
 * customer can be recognised on the self-service screen even when the tablet is
 * offline. Same rationale (and same safety) as the `staff` mirror in v7: the
 * pw_hash is a salted SHA-256, never a plaintext password, so caching it locally
 * is fine. `uname` holds lower(username) for a single .where() login lookup;
 * `active` is stored but not indexed (IndexedDB can't index booleans). The
 * mirror is refreshed from the server whenever the tablet is online.
 */
db.version(10).stores({
  customers: 'id, business_id, uname',
});

/*
 * version(11): local mirror for debts created at the POS (a customer takes goods
 * on credit). Primary key is a client-generated uuid ('id') so the same id is
 * used locally and on the server — recoveries (debt_payments, server-side) can
 * reference it. synced_status 0/1 (number, never boolean) drives the sync push,
 * exactly like sales/audit_logs. station_id is indexed for per-station lookups.
 * Debt recoveries are recorded online from the owner's Debts tab, so they have
 * no local table.
 */
db.version(11).stores({
  debts: 'id, synced_status, station_id',
});

/*
 * version(12): waiter → barman handover, offline, over QR.
 *
 * The real floor workflow: the waiter takes the order at the table on his own
 * phone, walks to the counter, and the BARMAN issues the stock and later
 * confirms the payment — he is the one accountable for both. Two phones with no
 * network cannot reach each other through Supabase, so the round travels as a
 * QR code the waiter shows and the barman scans. Orders arrive in rounds, so a
 * code carries ONE round's increment, never the whole tab (re-scanning a tab
 * would re-issue bottles that already left the counter).
 *
 * - active_tabs gains an indexed `uid`: a client-generated uuid that is stable
 *   ACROSS devices, so round 2 lands on the same tab the barman opened for
 *   round 1. The auto-increment `id` is device-local and cannot do that job.
 * - handovers (waiter side): every round this device has emitted, so the same
 *   QR can be re-shown without minting a new id — showing it twice must not
 *   let the barman receive it twice.
 * - received_rounds (barman side): the idempotency ledger, keyed by the
 *   handover id. A second scan of the same code is a no-op with a clear
 *   message, which matters because the natural reaction to an unsure scan is
 *   to scan again.
 */
db.version(12).stores({
  active_tabs: '++id, name, created_at, status, uid',
  handovers: 'id, tab_uid, created_at',
  received_rounds: 'id, tab_uid, received_at',
});

/*
 * version(13): the unified outbox — one queue for every write that must reach
 * the server, drained in the order it was raised (see outbox.js).
 *
 * Before this, each kind of write had its own ad-hoc push and the stock RPC had
 * none at all: it was fired after the sales push and its failure only reached
 * console.error, so a sale could upload while its stock decrement was lost —
 * phantom shrinkage in the next day's count, blamed on whoever held the keys.
 *
 * - '++seq' is the primary key ON PURPOSE: an auto-incrementing integer is the
 *   queue's order. A sale must reach the server before the stock move that
 *   depends on it, and insertion order is the only honest expression of that.
 * - `state` is indexed for the drain query and the pending badge; it is a
 *   string ('pending' | 'dead'), never a boolean (IndexedDB can't index those).
 * - `next_try_at` lets a failed item back off without blocking the queue scan.
 * Successful items are deleted — the domain tables are the record, this is
 * only the intent to send.
 */
db.version(13).stores({
  outbox: '++seq, state, next_try_at, kind',
});

/*
 * version(14): debt recovery at the counter, offline.
 *
 * A customer walks in at 9pm to pay off part of their amadeni. That is the
 * moment the debt ledger earns its keep, and until now it could only be
 * recorded from the owner's dashboard, online — so in practice it went on paper
 * and sometimes never made it back into the system.
 *
 * - debt_payments mirrors the server table. Primary key is a client-generated
 *   uuid so the row keeps one identity from the counter to the cloud, and
 *   synced_status is the usual 0/1 number.
 * - debts is no longer only what THIS device created: the whole venue's open
 *   debts are down-synced into it, because the customer who owes is rarely
 *   standing in front of the phone that recorded the debt.
 */
db.version(14).stores({
  debt_payments: 'id, debt_id, synced_status, created_at',
});