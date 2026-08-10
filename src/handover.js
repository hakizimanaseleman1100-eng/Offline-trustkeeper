import { db } from './db';

// Waiter → barman round handover, offline, over a QR code.
//
// The contract between two phones that may never be online at the same time —
// so it has to be self-contained, small enough to scan on a cheap camera, and
// impossible to apply twice. Keys are short because every character is pixels
// on a screen a barman has to focus on in bar lighting.
//
//   { v, h, t, tn, n, w:{i,n}, l:[{i,q,p,n}], ts }
//     v  format version   h  handover id (uuid, the idempotency key)
//     t  tab uid (stable across devices)   tn  tab name   n  round number
//     w  waiter { id, name }               l   lines { item id, qty, unit price, name }
//     ts when the round was raised, by the waiter's clock
//
// The money clock is deliberately NOT this one: the barman's device stamps the
// sale when he confirms payment, because he is the one answerable for it and
// cheap Android clocks drift.

export const HANDOVER_VERSION = 1;

// Guard rails for anything arriving from a camera. Generous enough for a real
// round, tight enough that a malformed or hostile code cannot flood the tab.
const MAX_LINES = 40;
const MAX_QTY = 999;
const MAX_UNIT_PRICE = 10_000_000; // RWF

export function buildRoundPayload({ tabUid, tabName, round, waiter, lines }) {
  return {
    v: HANDOVER_VERSION,
    h: crypto.randomUUID(),
    t: tabUid,
    tn: tabName ?? '',
    n: round,
    w: { i: waiter?.id ?? null, n: waiter?.name ?? '' },
    l: lines.map((line) => ({
      i: String(line.item_id),
      q: Number(line.quantity) || 1,
      p: Math.round(Number(line.unit_price) || 0),
      n: line.name ?? '',
    })),
    ts: Date.now(),
  };
}

export function encodeHandover(payload) {
  return JSON.stringify(payload);
}

// Parses and validates a scanned code. Returns { payload } or { error } — never
// throws, because the caller is a camera loop pointed at whatever is in frame.
export function decodeHandover(text) {
  let raw;
  try {
    raw = JSON.parse(String(text));
  } catch {
    return { error: 'That is not an order code.' };
  }

  if (!raw || typeof raw !== 'object') return { error: 'That is not an order code.' };
  if (raw.v !== HANDOVER_VERSION) {
    return { error: `This code is version ${raw.v ?? '?'} — update both phones to the same app version.` };
  }
  if (typeof raw.h !== 'string' || raw.h.length < 8) return { error: 'Order code is missing its id.' };
  if (typeof raw.t !== 'string' || raw.t.length < 8) return { error: 'Order code is missing its tab.' };

  const round = Number(raw.n);
  if (!Number.isInteger(round) || round < 1) return { error: 'Order code has no round number.' };

  if (!Array.isArray(raw.l) || raw.l.length === 0) return { error: 'That round is empty.' };
  if (raw.l.length > MAX_LINES) return { error: 'That code carries too many lines to be a real round.' };

  const lines = [];
  for (const line of raw.l) {
    const qty = Number(line?.q);
    const price = Number(line?.p);
    if (!line?.i || typeof line.i !== 'string') return { error: 'A line in that round has no item.' };
    if (!Number.isFinite(qty) || qty <= 0 || qty > MAX_QTY) return { error: 'A line in that round has a bad quantity.' };
    if (!Number.isFinite(price) || price < 0 || price > MAX_UNIT_PRICE) return { error: 'A line in that round has a bad price.' };
    lines.push({
      item_id: line.i,
      quantity: Math.round(qty),
      unit_price: Math.round(price),
      name: typeof line.n === 'string' ? line.n.slice(0, 60) : '',
    });
  }

  return {
    payload: {
      id: raw.h,
      tab_uid: raw.t,
      tab_name: typeof raw.tn === 'string' ? raw.tn.slice(0, 40) : '',
      round,
      waiter: { id: raw.w?.i ?? null, name: typeof raw.w?.n === 'string' ? raw.w.n.slice(0, 40) : '' },
      lines,
      ordered_at: Number(raw.ts) || Date.now(),
    },
  };
}

export function payloadTotal(payload) {
  return payload.lines.reduce((sum, l) => sum + l.quantity * l.unit_price, 0);
}

// Applies a scanned round on the BARMAN's device: finds (or opens) the tab that
// the waiter's tab uid refers to, and adds the round's lines to it.
//
// Idempotent by handover id. Scanning the same code again returns
// { duplicate: true } and touches nothing — the natural reaction to an unsure
// scan is to scan again, and that must never issue the bottles twice.
export async function applyHandover(payload, { barman } = {}) {
  const already = await db.received_rounds.get(payload.id);
  if (already) return { duplicate: true, received_at: already.received_at };

  return db.transaction('rw', db.active_tabs, db.sales, db.received_rounds, db.inventory, async () => {
    // Re-check inside the transaction: two quick scans can race.
    if (await db.received_rounds.get(payload.id)) return { duplicate: true };

    let tab = await db.active_tabs.where('uid').equals(payload.tab_uid).first();
    if (!tab) {
      const id = await db.active_tabs.add({
        uid: payload.tab_uid,
        name: payload.tab_name || `Waiter ${payload.waiter.name || ''}`.trim(),
        created_at: Date.now(),
        status: 'open',
        current_round: payload.round,
        // The tab belongs to the waiter who raised it — that is who owes the
        // money until this tab is settled at the counter.
        waiter_id: payload.waiter.id,
        waiter_name: payload.waiter.name,
      });
      tab = await db.active_tabs.get(id);
    }

    for (const line of payload.lines) {
      // Cost and tax come from THIS device's product mirror: they are the
      // barman's stock facts, not something a scanned code should get to
      // assert. Price comes from the code so the customer is charged what the
      // waiter quoted at the table.
      const product = await db.inventory.get(line.item_id);
      await db.sales.add({
        uid: crypto.randomUUID(),
        item_id: line.item_id,
        tab_id: tab.id,
        round: payload.round,
        quantity: line.quantity,
        total_price: line.unit_price * line.quantity,
        cost_price: product?.cost_price ?? null,
        tax_label: product?.tax_label ?? null,
        tax_rate: product?.tax_rate ?? null,
        // The line is owned by the WAITER who took the order — reports and the
        // per-waiter settle both need to point at him, not at the barman who
        // happened to key it in.
        staff_id: payload.waiter.id,
        staff_name: payload.waiter.name,
        timestamp: Date.now(),
        synced_status: 0,
      });
    }

    // Never let the barman's next manual line reuse a round the waiter has
    // already used on this tab.
    await db.active_tabs.update(tab.id, {
      current_round: Math.max(tab.current_round ?? 1, payload.round + 1),
    });

    await db.received_rounds.add({
      id: payload.id,
      tab_uid: payload.tab_uid,
      tab_id: tab.id,
      round: payload.round,
      waiter_name: payload.waiter.name,
      lines: payload.lines.length,
      total: payloadTotal(payload),
      received_by: barman?.name ?? null,
      received_at: Date.now(),
    });

    return { tabId: tab.id, tabName: tab.name, total: payloadTotal(payload) };
  });
}
