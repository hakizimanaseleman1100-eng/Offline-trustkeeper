import { db } from './db';
import { enqueue } from './outbox';
import { getBusinessId } from './session';
import { nextPoNumber } from './receipts';
import { recordLocalMoves } from './reconcileLocal';

// Purchases: recording what came IN, so a stock variance means something.
//
// expected = opening + purchases − sales. Without the middle term, "a crate
// arrived and nobody wrote it down" is always available as an explanation for a
// gap — and it is often the true one, which is worse: the system accuses an
// honest storeman and he learns to distrust it.
//
// Everything here is local-first and queued, like every other write in the app.
// A delivery arrives at the store door, which is exactly where the signal dies.

// Weighted average cost. The whole point of the feature: supplier prices move,
// and a margin computed against a stale cost is a comfortable lie.
export function weightedAverageCost(stockQty, oldCost, incomingQty, incomingUnitCost) {
  const denominator = (stockQty ?? 0) + (incomingQty ?? 0);
  if (!denominator) return Math.round(incomingUnitCost ?? oldCost ?? 0);
  return Math.round((((stockQty ?? 0) * (oldCost ?? 0)) + incomingQty * incomingUnitCost) / denominator);
}

// Unit cost from what the barman actually knows: the price of a crate. Bars
// quote crate prices, so the UI asks for that and this does the division.
export function unitCostFromPackage(packageCost, unitsPerPackage) {
  const per = Math.max(1, Number(unitsPerPackage) || 1);
  return Math.round((Number(packageCost) || 0) / per);
}

export function lineQuantity(line) {
  return (Number(line.packages) || 0) * (Number(line.units_per_package_snapshot) || 1) + (Number(line.loose_units) || 0);
}

// The server shape of a purchase line. `quantity` and `line_cost` are GENERATED
// ALWAYS columns — Postgres rejects any write that includes them, so they are
// stripped here rather than at each call site.
export function serverLineRow(line) {
  return {
    uid: line.uid,
    business_id: line.business_id,
    purchase_uid: line.purchase_uid,
    product_id: line.product_id,
    product_name: line.product_name ?? null,
    packages: line.packages,
    loose_units: line.loose_units,
    units_per_package_snapshot: line.units_per_package_snapshot,
    unit_cost: line.unit_cost,
  };
}

// Saves a delivery: local first (stock is up the moment the crates are on the
// floor), then queued as header → lines → receive. The queue's ordering is what
// makes that safe; the lines carry a foreign key to the header's uid.
export async function savePurchase({ header, lines, station_id, staff, receive = true }) {
  const uid = crypto.randomUUID();
  const po_number = header.po_number ?? (await nextPoNumber());
  const now = Date.now();

  const cleanLines = lines
    .map((l) => {
      const units_per_package_snapshot = Math.max(1, Number(l.units_per_package_snapshot) || 1);
      const packages = Math.max(0, Math.round(Number(l.packages) || 0));
      const loose_units = Math.max(0, Math.round(Number(l.loose_units) || 0));
      const quantity = packages * units_per_package_snapshot + loose_units;
      const unit_cost = Math.round(Number(l.unit_cost) || 0);
      return {
        uid: crypto.randomUUID(),
        business_id: getBusinessId(),
        purchase_uid: uid,
        product_id: String(l.product_id),
        product_name: l.product_name ?? null,
        packages,
        loose_units,
        units_per_package_snapshot,
        quantity,
        unit_cost,
        line_cost: quantity * unit_cost,
      };
    })
    .filter((l) => l.quantity > 0);

  if (cleanLines.length === 0) throw new Error('Add at least one line');

  const total_cost = cleanLines.reduce((sum, l) => sum + l.line_cost, 0);
  const status = receive ? 'received' : 'draft';

  const purchase = {
    uid,
    business_id: getBusinessId(),
    station_id: station_id ?? null,
    po_number,
    supplier_name: header.supplier_name?.trim() || null,
    status,
    notes: header.notes?.trim() || null,
    ordered_at: receive ? null : new Date(now).toISOString(),
    received_at: receive ? new Date(now).toISOString() : null,
    total_cost,
    created_by_staff_id: staff?.id ?? null,
    created_by_staff_name: staff?.name ?? null,
  };

  await db.purchases.add({ ...purchase, created_at: now, synced_status: 0 });
  await db.purchase_lines.bulkAdd(cleanLines.map((l) => ({ ...l, synced_status: 0 })));

  // Header, then lines, then the RPC that moves stock — in that order, always.
  await enqueue('purchase', { row: purchase });
  await enqueue('purchase_lines', { rows: cleanLines.map(serverLineRow) });

  if (receive) {
    await applyReceiveLocally({ purchase, lines: cleanLines, staff });
    await enqueue('purchase_receive', { uid });
    await enqueue('audit_log', {
      row: {
        uid: crypto.randomUUID(),
        business_id: getBusinessId(),
        action_type: 'PURCHASE_RECEIVED',
        details: `${po_number} · ${cleanLines.length} line(s) · ${total_cost.toLocaleString()} RWF${
          purchase.supplier_name ? ` · ${purchase.supplier_name}` : ''
        }`,
        staff_id: staff?.id ?? null,
        staff_name: staff?.name ?? null,
        timestamp: new Date(now).toISOString(),
      },
    });
  }

  return { uid, po_number, total_cost, lines: cleanLines.length };
}

// The optimistic half of receiving: stock and cost move on this device now, so
// the storeman sees the crates he is holding. The server RPC is authoritative
// and recomputes the same numbers when the queue drains.
async function applyReceiveLocally({ purchase, lines, staff }) {
  const moves = [];
  for (const line of lines) {
    // Same weighted average the server will compute, over this device's view of
    // on-hand. If they disagree, the server wins at the next down-sync.
    const stockRows = await db.station_stock.where('product_id').equals(line.product_id).toArray();
    const onHand = stockRows.reduce((sum, r) => sum + Number(r.quantity ?? 0), 0);
    const product = await db.inventory.get(line.product_id);
    if (product) {
      await db.inventory.update(line.product_id, {
        cost_price: weightedAverageCost(onHand, product.cost_price, line.quantity, line.unit_cost),
      });
    }

    if (purchase.station_id) {
      const key = [purchase.station_id, line.product_id];
      const existing = await db.station_stock.get(key);
      if (existing) {
        await db.station_stock.update(key, { quantity: Number(existing.quantity ?? 0) + line.quantity });
      } else {
        await db.station_stock.add({
          station_id: purchase.station_id,
          product_id: line.product_id,
          business_id: getBusinessId(),
          quantity: line.quantity,
        });
      }
      // Uses the LINE's uid, matching what receive_purchase writes server-side,
      // so the local movement and its server twin converge instead of doubling.
      moves.push({
        uid: line.uid,
        station_id: purchase.station_id,
        product_id: line.product_id,
        delta: line.quantity,
        reason: 'purchase',
        staff_name: staff?.name ?? null,
      });
    }
  }
  await recordLocalMoves(moves);
}

// Receiving a draft when the goods actually turn up — which is rarely what was
// ordered. The supplier is out of Fanta, brings 8 crates instead of 10, and the
// price moved since the order. So `edits` carries what ACTUALLY arrived, keyed
// by line uid: { packages, loose_units, unit_cost }. A line edited to zero is
// kept, not deleted — "ordered but not delivered" is worth knowing about a
// supplier, and deleting it would erase that.
//
// The lines are corrected on the server BEFORE the receive RPC runs, because
// the RPC reads them to decide what to add to stock. The queue's ordering is
// what makes that safe.
export async function receiveDraft(purchase, staff, edits = null) {
  let lines = await db.purchase_lines.where('purchase_uid').equals(purchase.uid).toArray();

  if (edits) {
    const changed = [];
    lines = lines.map((line) => {
      const edit = edits[line.uid];
      if (!edit) return line;
      const per = Math.max(1, Number(line.units_per_package_snapshot) || 1);
      const packages = Math.max(0, Math.round(Number(edit.packages) || 0));
      const loose_units = Math.max(0, Math.round(Number(edit.loose_units) || 0));
      const unit_cost = Math.round(Number(edit.unit_cost ?? line.unit_cost) || 0);
      const quantity = packages * per + loose_units;
      const next = { ...line, packages, loose_units, unit_cost, quantity, line_cost: quantity * unit_cost };
      const untouched =
        next.packages === line.packages && next.loose_units === line.loose_units && next.unit_cost === line.unit_cost;
      if (!untouched) changed.push(next);
      return next;
    });

    if (changed.length) {
      await db.purchase_lines.bulkPut(changed.map((l) => ({ ...l, synced_status: 0 })));
      await enqueue('purchase_lines_update', { rows: changed.map(serverLineRow) });
    }
  }

  // Only what actually arrived moves stock. A zero line is a record of a
  // shortfall, not a delivery.
  const delivered = lines.filter((l) => l.quantity > 0);
  const total_cost = lines.reduce((sum, l) => sum + (l.line_cost ?? 0), 0);

  await applyReceiveLocally({ purchase, lines: delivered, staff });
  await db.purchases.update(purchase.uid, { status: 'received', received_at: Date.now(), total_cost });
  await enqueue('purchase_receive', { uid: purchase.uid });
  await enqueue('audit_log', {
    row: {
      uid: crypto.randomUUID(),
      business_id: getBusinessId(),
      action_type: 'PURCHASE_RECEIVED',
      details: `${purchase.po_number} received from draft · ${Number(purchase.total_cost ?? 0).toLocaleString()} RWF`,
      staff_id: staff?.id ?? null,
      staff_name: staff?.name ?? null,
      timestamp: new Date().toISOString(),
    },
  });
}

// Voiding: reverse the stock, put the costs back to the snapshot taken at
// receive. Deliberately not a retroactive recalculation — a report that changes
// after the fact is worse than one that is slightly stale.
export async function voidPurchase(purchase, staff) {
  const lines = await db.purchase_lines.where('purchase_uid').equals(purchase.uid).toArray();
  const moves = [];

  for (const line of lines) {
    if (purchase.station_id) {
      const key = [purchase.station_id, line.product_id];
      const existing = await db.station_stock.get(key);
      if (existing) {
        await db.station_stock.update(key, { quantity: Number(existing.quantity ?? 0) - line.quantity });
      }
      moves.push({
        uid: crypto.randomUUID(),
        station_id: purchase.station_id,
        product_id: line.product_id,
        delta: -line.quantity,
        reason: 'purchase_void',
        staff_name: staff?.name ?? null,
      });
    }
  }

  await recordLocalMoves(moves);
  await db.purchases.update(purchase.uid, { status: 'void', voided_by: staff?.name ?? null, voided_at: Date.now() });
  await enqueue('purchase_void', { uid: purchase.uid, staff: staff?.name ?? null });
  await enqueue('audit_log', {
    row: {
      uid: crypto.randomUUID(),
      business_id: getBusinessId(),
      action_type: 'PURCHASE_VOID',
      details: `${purchase.po_number} voided · ${Number(purchase.total_cost ?? 0).toLocaleString()} RWF`,
      staff_id: staff?.id ?? null,
      staff_name: staff?.name ?? null,
      timestamp: new Date().toISOString(),
    },
  });
}

// One row per product, ready to type into: what is on the shelf, what the last
// supplier charged, and how many crates the sales history says to buy. Ordering
// should be reading down a list and correcting numbers, not searching for
// twenty products one at a time and remembering last month's prices.
export async function buildOrderRows({ stationId = null, targetDays = 7 } = {}) {
  const [suggestions, lastCosts, stockRows] = await Promise.all([
    buildSuggestions({ targetDays }),
    lastUnitCostByProduct(),
    db.station_stock.toArray(),
  ]);

  // Stock at the station the goods will land at; venue-wide when there is none.
  const stationStock = {};
  for (const r of stockRows) {
    if (stationId && String(r.station_id) !== String(stationId)) continue;
    const id = String(r.product_id);
    stationStock[id] = (stationStock[id] ?? 0) + Number(r.quantity ?? 0);
  }

  return suggestions.map((s) => {
    const lastUnitCost = lastCosts[s.id] ?? s.cost_price ?? 0;
    return {
      ...s,
      stationStock: stationId ? stationStock[s.id] ?? 0 : s.stock,
      lastUnitCost,
      // Bars quote crate prices, so that is what the field holds.
      packageCost: Math.round(lastUnitCost * s.units_per_package),
      // True when this price came from a real previous delivery rather than
      // the product's standing cost — worth showing, so nobody trusts a guess.
      pricedFromHistory: lastCosts[s.id] !== undefined,
    };
  });
}

// The most recent unit cost actually paid per product, from purchase history.
async function lastUnitCostByProduct() {
  const purchases = await db.purchases.orderBy('created_at').reverse().limit(40).toArray();
  const byUid = new Map(purchases.filter((p) => p.status !== 'void').map((p) => [p.uid, p.created_at]));
  if (byUid.size === 0) return {};

  const lines = await db.purchase_lines.where('purchase_uid').anyOf([...byUid.keys()]).toArray();
  const newest = {};
  for (const l of lines) {
    const when = byUid.get(l.purchase_uid) ?? 0;
    const id = String(l.product_id);
    if (!newest[id] || when > newest[id].when) newest[id] = { when, cost: l.unit_cost };
  }
  return Object.fromEntries(Object.entries(newest).map(([id, v]) => [id, v.cost]));
}

// The document the supplier actually receives — WhatsApp is how these orders
// travel in practice, so plain text is the primary format, not a PDF.
//
// No EBM disclaimer here on purpose: engineering rule 4 governs customer bills,
// and this is an order TO a supplier, not a receipt for a sale.
export function orderText({ purchase, lines, venueName }) {
  const money = (n) => Math.round(n || 0).toLocaleString();
  const body = lines.map((l) => {
    const per = Math.max(1, Number(l.units_per_package_snapshot) || 1);
    const qty =
      per > 1
        ? `${l.packages} ${l.package_name || 'case'}${l.loose_units ? ` + ${l.loose_units}` : ''}`
        : `${l.quantity}`;
    return `${l.product_name} — ${qty} (${l.quantity} units) · ${money(l.line_cost)} RWF`;
  });

  return [
    venueName || 'Order',
    `ORDER ${purchase.po_number}`,
    purchase.supplier_name ? `Supplier: ${purchase.supplier_name}` : null,
    new Date(purchase.created_at ?? Date.now()).toLocaleDateString(),
    '',
    ...body,
    '',
    `TOTAL: ${money(purchase.total_cost)} RWF`,
    purchase.notes ? `Note: ${purchase.notes}` : null,
  ]
    .filter(Boolean)
    .join('\n');
}

// ---- Suggested order (amacupa) ---------------------------------------------

const VELOCITY_DAYS = 14;

// What to buy, from what actually sold. Local sales only — the same assumption
// the offline reconcile makes: this device is its station's record of the night.
export async function buildSuggestions({ targetDays = 7 } = {}) {
  const since = Date.now() - VELOCITY_DAYS * 86400000;
  const [products, stockRows, sales] = await Promise.all([
    db.inventory.toArray(),
    db.station_stock.toArray(),
    db.sales.where('timestamp').above(since).toArray(),
  ]);

  const soldByProduct = {};
  for (const s of sales) {
    if (!s.payment_method) continue; // an open tab is ordered, not sold
    const id = String(s.item_id);
    soldByProduct[id] = (soldByProduct[id] ?? 0) + (s.quantity ?? 1);
  }

  const onHandByProduct = {};
  for (const r of stockRows) {
    const id = String(r.product_id);
    onHandByProduct[id] = (onHandByProduct[id] ?? 0) + Number(r.quantity ?? 0);
  }

  return products
    .map((p) => {
      const id = String(p.id);
      const perPackage = Math.max(1, Number(p.units_per_package) || 1);
      const sold = soldByProduct[id] ?? 0;
      const dailyVelocity = sold / VELOCITY_DAYS;
      const stock = onHandByProduct[id] ?? 0;
      const daysLeft = dailyVelocity > 0 ? stock / dailyVelocity : null;
      const need = targetDays * dailyVelocity - stock;
      return {
        id,
        name: p.item_name,
        package_name: p.package_name || 'case',
        units_per_package: perPackage,
        cost_price: Number(p.cost_price ?? 0),
        sold,
        dailyVelocity,
        stock,
        stockPackages: stock / perPackage,
        daysLeft,
        suggestedPackages: need > 0 ? Math.ceil(need / perPackage) : 0,
      };
    })
    .sort((a, b) => {
      // Most urgent first: anything that runs out soonest.
      if (a.daysLeft === null && b.daysLeft === null) return 0;
      if (a.daysLeft === null) return 1;
      if (b.daysLeft === null) return -1;
      return a.daysLeft - b.daysLeft;
    });
}
