import { db } from './db';
import { supabase } from './supabaseClient';
import { getBusinessId } from './session';

// The unified outbox: one queue for every write that has to reach Supabase,
// drained strictly in the order it was raised.
//
// Why one queue rather than a push per feature: the writes depend on each other.
// A sale must land before the stock decrement that refers to it, and a debt
// before its recovery. Separate best-effort pushes had no way to express that,
// and the stock RPC had no retry at all — its failure only reached
// console.error, so station stock silently drifted and the next day's count
// blamed a storeman for a lost network packet.
//
// Rules:
//  1. Local commit first, always. Enqueueing is the LAST step of an action that
//     has already succeeded on this device; the POS never waits for this.
//  2. Every handler must be idempotent — items are retried, and a response lost
//     on 2G is indistinguishable from a request that never arrived
//     (migration 0028 gives stock moves, audit logs and expenses client uids).
//  3. Order is preserved: a retryable failure stops the drain rather than
//     skipping ahead. Only a PERMANENT failure is set aside, so one malformed
//     row can never hold the venue's revenue hostage.

const MAX_ATTEMPTS = 8;
const BASE_BACKOFF_MS = 5_000;
const MAX_BACKOFF_MS = 5 * 60_000;

// Postgres codes that will still be wrong in five minutes. Retrying these is
// just noise: the row is malformed, or it violates a constraint that a retry
// cannot satisfy. 23505 (unique violation) is NOT here — handlers upsert, so a
// unique violation means "already delivered", which is success.
const PERMANENT_PG_CODES = new Set([
  '22P02', // invalid text representation (bad uuid/number in the payload)
  '23502', // not-null violation
  '23503', // foreign key violation
  '23514', // check constraint violation
  '42501', // insufficient privilege / RLS — a retry loop will never fix it
  '42703', // undefined column — client is ahead of the database
  '42P01', // undefined table — same
  'PGRST204', // PostgREST schema cache: column not found
]);

function isPermanent(error) {
  if (!error) return false;
  if (PERMANENT_PG_CODES.has(error.code)) return true;
  // PostgREST surfaces 4xx as strings sometimes; treat explicit 400/403/404 as
  // permanent, everything else (network, 5xx, timeouts) as retryable.
  const status = Number(error.status);
  return status === 400 || status === 403 || status === 404;
}

function backoffFor(attempts) {
  return Math.min(BASE_BACKOFF_MS * 2 ** attempts, MAX_BACKOFF_MS);
}

// The server shape of a local sale row. Shared so the checkout path and the
// one-time migration below cannot drift apart.
export function saleRowForServer(sale) {
  return {
    uid: sale.uid ?? null,
    business_id: getBusinessId(),
    item_id: sale.item_id,
    quantity: sale.quantity ?? 1,
    total_price: sale.total_price,
    payment_method: sale.payment_method,
    cost_price: sale.cost_price,
    tax_label: sale.tax_label,
    tax_rate: sale.tax_rate,
    customer_tin: sale.customer_tin ?? null,
    customer_phone: sale.customer_phone ?? null,
    staff_id: sale.staff_id ?? null,
    staff_name: sale.staff_name ?? null,
    receipt_no: sale.receipt_no ?? null,
    device_id: sale.device_id ?? null,
    momo_ref: sale.momo_ref ?? null,
    discount_amount: sale.discount_amount ?? 0,
    guest_count: sale.guest_count ?? null,
    check_in_date: sale.check_in_date ?? null,
    check_out_date: sale.check_out_date ?? null,
    station_id: sale.station_id ?? null,
    station_name: sale.station_name ?? null,
    customer_id: sale.customer_id ?? null,
    customer_username: sale.customer_username ?? null,
    timestamp: new Date(sale.timestamp).toISOString(),
  };
}

// ---- handlers --------------------------------------------------------------
// One per kind. Each takes the frozen payload and performs an idempotent write.
// Throwing (or returning a Supabase error) marks the attempt failed.

const handlers = {
  // A whole checkout in one item: every line of the tab, plus the local ids so
  // they can be marked synced once the server has them.
  async sale({ rows, localIds }) {
    const { error } = await supabase
      .from('hospitality_sales')
      .upsert(rows, { onConflict: 'uid', ignoreDuplicates: true });
    if (error) throw error;
    if (localIds?.length) {
      await db.sales.bulkUpdate(localIds.map((id) => ({ key: id, changes: { synced_status: 1 } })));
    }
  },

  async debt({ row, localId }) {
    const { error } = await supabase.from('debts').upsert(row, { onConflict: 'id', ignoreDuplicates: true });
    if (error) throw error;
    if (localId) await db.debts.update(localId, { synced_status: 1 });
  },

  async debt_payment({ row, localId }) {
    // The client supplies `id`, so a retry collides with itself rather than
    // recording the customer's money twice.
    const { error } = await supabase.from('debt_payments').upsert(row, { onConflict: 'id', ignoreDuplicates: true });
    if (error) throw error;
    if (localId) await db.debt_payments.update(localId, { synced_status: 1 });
  },

  // A waiter's round, offered to the counter over the network. Same id as the
  // QR carries, so whichever transport arrives first wins and the other is
  // recognised as already-received rather than served twice.
  async handover({ row }) {
    const { error } = await supabase.from('handovers').upsert(row, { onConflict: 'id', ignoreDuplicates: true });
    if (error) throw error;
  },

  // A delivery, in three queued steps that MUST arrive in this order: header,
  // then lines (they carry a foreign key to the header's uid), then the receive
  // RPC that moves the stock and recomputes cost. The queue's ordering is what
  // makes that safe — this is the clearest case for why it drains in sequence.
  async purchase({ row }) {
    const { error } = await supabase.from('purchases').upsert(row, { onConflict: 'uid', ignoreDuplicates: true });
    if (error) throw error;
    await db.purchases.update(row.uid, { synced_status: 1 });
  },

  async purchase_lines({ rows }) {
    const { error } = await supabase.from('purchase_lines').upsert(rows, { onConflict: 'uid', ignoreDuplicates: true });
    if (error) throw error;
    await db.purchase_lines.bulkUpdate(rows.map((r) => ({ key: r.uid, changes: { synced_status: 1 } })));
  },

  // Idempotent server-side: a purchase already marked received returns without
  // touching stock again (migration 0030).
  async purchase_receive({ uid }) {
    const { error } = await supabase.rpc('receive_purchase', { p_uid: uid });
    if (error) throw error;
  },

  async purchase_void({ uid, staff }) {
    const { error } = await supabase.rpc('void_purchase', { p_uid: uid, p_staff: staff ?? null });
    if (error) throw error;
  },

  // Flipping a fully-paid debt to 'settled'. Naturally idempotent — setting the
  // same status twice is the same as once — and queued BEHIND its payment, so
  // it can never mark a debt settled before the money that settled it arrives.
  async debt_settle({ id }) {
    const { error } = await supabase.from('debts').update({ status: 'settled' }).eq('id', id);
    if (error) throw error;
  },

  // Deltas, not absolutes — so this is the one that MUST not be applied twice.
  // Each move carries a uid; the server writes the movement row as a receipt
  // and skips the balance update if that uid is already present (0028).
  async stock_move({ moves }) {
    const { error } = await supabase.rpc('apply_station_stock', { p_moves: moves });
    if (error) throw error;
  },

  async audit_log({ row }) {
    const { error } = await supabase.from('audit_logs').upsert(row, { onConflict: 'uid', ignoreDuplicates: true });
    if (error) throw error;
  },

  async expense({ row, localId }) {
    const { error } = await supabase.from('expenses').upsert(row, { onConflict: 'uid', ignoreDuplicates: true });
    if (error) throw error;
    if (localId) await db.expenses.update(localId, { synced_status: 1 });
  },

  // The day's closing sheet. Upserted on the same (business, station, day) the
  // table is keyed by, so re-saving a day the venue re-opened replaces it
  // rather than growing a second record of the same night.
  async reconciliation({ row, localKey }) {
    const { error } = await supabase
      .from('reconciliations')
      .upsert(row, { onConflict: 'business_id,station_id,business_day' });
    if (error) throw error;
    if (localKey) await db.reconciliations.update(localKey, { synced_status: 1 });
  },
};

// ---- queue -----------------------------------------------------------------

// Adds an item to the queue. Never throws: a failure to enqueue must not undo
// the sale the staff member just made.
export async function enqueue(kind, payload) {
  if (!handlers[kind]) {
    console.error(`Outbox: unknown kind "${kind}" — not queued`);
    return null;
  }
  try {
    const seq = await db.outbox.add({
      kind,
      payload,
      business_id: getBusinessId(),
      state: 'pending',
      attempts: 0,
      last_error: null,
      created_at: Date.now(),
      next_try_at: 0,
    });
    // Opportunistic: if there's network, this leaves before the staff member
    // has put the phone down. If not, the drain on 'online' picks it up.
    if (navigator.onLine) void drain();
    return seq;
  } catch (err) {
    console.error('Outbox enqueue failed:', err);
    return null;
  }
}

export function pendingQuery() {
  return db.outbox.where('state').equals('pending');
}

export async function pendingCount() {
  return pendingQuery().count();
}

export async function deadCount() {
  return db.outbox.where('state').equals('dead').count();
}

export async function deadItems() {
  return db.outbox.where('state').equals('dead').toArray();
}

// Puts a set-aside item back at the FRONT of nothing — it keeps its original
// seq, so retrying it restores its place in the original order.
export async function retryDead(seq) {
  await db.outbox.update(seq, { state: 'pending', attempts: 0, next_try_at: 0 });
  if (navigator.onLine) void drain();
}

let draining = false;

// Sends everything pending, oldest first. Returns a summary so the UI can say
// something honest. Safe to call from anywhere, including concurrently — the
// second caller returns immediately rather than racing the first.
export async function drain() {
  if (draining) return { skipped: true };
  if (!navigator.onLine) return { offline: true };

  draining = true;
  let sent = 0;
  let failed = 0;
  try {
    // Ordered by seq: the primary key IS the queue order.
    const items = await db.outbox.where('state').equals('pending').sortBy('seq');
    const now = Date.now();

    for (const item of items) {
      // A backing-off item blocks the ones behind it on purpose — they may
      // depend on it. Waiting is correct; skipping would reorder the queue.
      if (item.next_try_at > now) break;

      try {
        await handlers[item.kind](item.payload);
        await db.outbox.delete(item.seq);
        sent += 1;
      } catch (error) {
        failed += 1;
        const attempts = (item.attempts ?? 0) + 1;
        const permanent = isPermanent(error);
        const exhausted = attempts >= MAX_ATTEMPTS;

        await db.outbox.update(item.seq, {
          attempts,
          last_error: error?.message ?? String(error),
          // Set aside only what cannot succeed later. Everything else keeps its
          // place and waits — losing a sale is worse than a slow queue.
          state: permanent || exhausted ? 'dead' : 'pending',
          next_try_at: Date.now() + backoffFor(attempts),
        });

        if (permanent || exhausted) {
          console.error(`Outbox: ${item.kind} set aside after ${attempts} attempt(s):`, error?.message ?? error);
          continue; // a poison item must not hold up the rest
        }
        break; // retryable: stop here, preserve order, try again later
      }
    }
  } finally {
    draining = false;
  }
  return { sent, failed };
}

// A device upgrading with a night's takings already queued had them in the old
// per-table pending flags, not here. Move them across once, oldest first, so an
// upgrade never strands a sale. Runs exactly once per device.
export async function migrateLegacyPending() {
  const done = await db.meta.get('outbox_migrated');
  if (done?.value) return;

  try {
    const paidTabIds = new Set(
      (await db.active_tabs.where('status').equals('paid').toArray()).map((t) => t.id)
    );
    const sales = (await db.sales.where('synced_status').equals(0).toArray()).filter((s) =>
      paidTabIds.has(s.tab_id)
    );
    if (sales.length) {
      await enqueue('sale', {
        localIds: sales.map((s) => s.id),
        rows: sales.map(saleRowForServer),
      });
    }

    for (const d of await db.debts.where('synced_status').equals(0).toArray()) {
      await enqueue('debt', {
        localId: d.id,
        row: {
          id: d.id,
          business_id: getBusinessId(),
          customer_id: d.customer_id ?? null,
          customer_name: d.customer_name,
          amount: d.amount,
          staff_id: d.staff_id ?? null,
          staff_name: d.staff_name ?? null,
          station_id: d.station_id ?? null,
          station_name: d.station_name ?? null,
          receipt_no: d.receipt_no ?? null,
          note: d.note ?? null,
          status: d.status ?? 'open',
          created_at: new Date(d.created_at).toISOString(),
        },
      });
    }

    for (const log of await db.audit_logs.where('synced_status').equals(0).toArray()) {
      await enqueue('audit_log', {
        localId: log.id,
        row: {
          uid: log.uid ?? crypto.randomUUID(),
          business_id: getBusinessId(),
          action_type: log.action_type,
          details: log.details,
          staff_id: log.staff_id ?? null,
          staff_name: log.staff_name ?? null,
          timestamp: new Date(log.timestamp).toISOString(),
        },
      });
    }

    await db.meta.put({ key: 'outbox_migrated', value: true });
  } catch (err) {
    // Leave the flag unset so the next start tries again — the old rows are
    // still sitting in their tables, nothing is lost by retrying.
    console.error('Outbox legacy migration failed:', err);
  }
}

// Wires the automatic triggers once, at app start. Sync is passive: staff never
// press anything (engineering rule 7).
let started = false;
export function startOutbox() {
  if (started) return;
  started = true;

  void migrateLegacyPending();
  window.addEventListener('online', () => void drain());
  // A periodic nudge covers the cases 'online' misses: a captive portal that
  // lets go, a backoff that has expired, a tab left open all evening.
  setInterval(() => {
    if (navigator.onLine) void drain();
  }, 30_000);

  if (navigator.onLine) void drain();
}
