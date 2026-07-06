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
 * - Primary key is a plain 'id' holding the SAME id as the Supabase row
 *   (a uuid), or the fixed 'local-default-owner' id for the offline
 *   bootstrap owner — the app must resolve staff_id the same way whether a
 *   row came from the server or was seeded locally.
 * - pin_hash is indexed so login is a single .where('pin_hash') lookup.
 *   `active` is stored but not indexed (IndexedDB can't index booleans);
 *   it's checked in JS after the hash match.
 */
db.version(7).stores({
  staff: 'id, business_id, pin_hash',
});