import { db } from './db';

// The reconcile screen's data, computed entirely from this device's Dexie
// mirrors — the fallback that lets a venue close its day with no network.
//
// Returns the same shape the server path builds, so the panel renders one way
// and only the SOURCE differs. Where the two can disagree is documented on each
// field rather than hidden: an offline sheet is an honest account of what this
// device knows, not a pretence that it knows everything.
//
// The load-bearing assumption is the one the floor workflow already enforces:
// the barman's device is the single writer of money for its station, so its
// local sales ARE the station's sales. If a venue ever runs two tills on one
// station, an offline close from either of them would only see half the night —
// which is why the panel labels the sheet as offline.

export function dayWindow(day) {
  const start = new Date(`${day}T00:00:00`);
  return { start: start.getTime(), end: start.getTime() + 86400000 };
}

export async function loadLocalDay(stationId, day) {
  const { start, end } = dayWindow(day);
  const inDay = (ms) => ms >= start && ms < end;

  const [products, stockRows, moves, sales, expenses, debts, payments, saved] = await Promise.all([
    db.inventory.toArray(),
    db.station_stock.where('station_id').equals(stationId).toArray(),
    db.stock_moves.where('station_id').equals(stationId).toArray(),
    db.sales.where('timestamp').between(start, end).toArray(),
    db.expenses.toArray(),
    db.debts.toArray(),
    db.debt_payments.toArray(),
    db.reconciliations.get([stationId, day]),
  ]);

  const onHand = Object.fromEntries(stockRows.map((r) => [String(r.product_id), Number(r.quantity)]));

  // Today's movements: total change (to reconstruct opening) and issues (what
  // came IN). Identical arithmetic to the server path.
  const deltaSum = {};
  const issued = {};
  for (const m of moves) {
    if (!inDay(m.created_at)) continue;
    const k = String(m.product_id);
    deltaSum[k] = (deltaSum[k] ?? 0) + Number(m.delta);
    // 'purchase' counts as stock IN too — a recorded delivery is the `purchases`
    // term in opening + purchases − sales.
    if (m.reason === 'issue' || m.reason === 'purchase') {
      issued[k] = (issued[k] ?? 0) + Number(m.delta);
    }
  }

  // Only checked-out lines are revenue: a line sitting in an open tab has been
  // ordered, not sold. `payment_method` is stamped at checkout.
  const soldQty = {};
  const itemRev = {};
  let cashSum = 0;
  let momoSum = 0;
  let creditSum = 0;
  let salesSum = 0;
  for (const s of sales) {
    if (!s.payment_method) continue;
    if (String(s.station_id ?? '') !== String(stationId)) continue;
    const amount = s.total_price ?? 0;
    salesSum += amount;
    if (s.payment_method === 'cash') cashSum += amount;
    else if (s.payment_method === 'momo') momoSum += amount;
    else if (s.payment_method === 'debt') creditSum += amount;
    const id = String(s.item_id);
    soldQty[id] = (soldQty[id] ?? 0) + (s.quantity ?? 1);
    itemRev[id] = (itemRev[id] ?? 0) + amount;
  }

  const expensesTotal = expenses
    .filter((e) => inDay(e.created_at))
    .reduce((a, e) => a + (e.amount ?? 0), 0);

  // Debts are venue-wide in the mirror, so scope them to this station the same
  // way the server query does.
  const stationDebts = debts.filter((d) => String(d.station_id ?? '') === String(stationId));
  const stationPays = payments.filter((p) => String(p.station_id ?? '') === String(stationId));
  const started = stationDebts.filter((d) => inDay(d.created_at)).reduce((a, d) => a + (d.amount ?? 0), 0);
  const recovered = stationPays.filter((p) => inDay(p.created_at)).reduce((a, p) => a + (p.amount ?? 0), 0);
  const owed = stationDebts
    .filter((d) => d.status !== 'void' && (d.created_at ?? 0) < end)
    .reduce((a, d) => a + (d.amount ?? 0), 0);
  const paid = stationPays.filter((p) => (p.created_at ?? 0) < end).reduce((a, p) => a + (p.amount ?? 0), 0);

  const rows = products
    .map((p) => {
      const id = String(p.id);
      const tracked = onHand[id] !== undefined;
      const oh = onHand[id] ?? 0;
      return {
        id,
        name: p.item_name,
        price: Number(p.unit_price ?? 0),
        cost: Number(p.cost_price ?? 0),
        tracked,
        received: tracked ? issued[id] ?? 0 : 0,
        opening: tracked ? oh - (deltaSum[id] ?? 0) : 0,
        sold: soldQty[id] ?? 0,
        revenue: itemRev[id] ?? 0,
      };
    })
    .filter((r) => r.tracked || r.sold > 0 || r.revenue > 0)
    .sort((a, b) => (a.name ?? '').localeCompare(b.name ?? ''));

  return {
    rows,
    salesTotal: Math.round(salesSum),
    cash: Math.round(cashSum),
    momo: Math.round(momoSum),
    credit: Math.round(creditSum),
    expenses: Math.round(expensesTotal),
    debts: {
      recovered: Math.round(recovered),
      started: Math.round(started),
      outstanding: Math.round(owed - paid),
      shortfallDebts: stationDebts.filter(
        (d) => d.source === 'reconciliation' && d.business_day === day && d.status !== 'void'
      ),
    },
    saved: saved ?? null,
  };
}

// Records a movement this device just applied, so the reconcile sheet can
// reconstruct opening stock offline. Keyed by the SAME uid the outbox sends, so
// when the server copy comes back down it lands on this row instead of beside
// it.
export async function recordLocalMoves(moves) {
  if (!moves?.length) return;
  try {
    await db.stock_moves.bulkPut(
      moves.map((m) => ({
        uid: m.uid,
        station_id: m.station_id,
        product_id: String(m.product_id),
        delta: Number(m.delta),
        reason: m.reason ?? 'adjust',
        staff_name: m.staff_name ?? null,
        created_at: Date.now(),
        synced_status: 0,
      }))
    );
  } catch (err) {
    // A missing local movement costs an accurate offline opening figure; it
    // must never cost the sale that caused it.
    console.error('Local stock movement not recorded:', err);
  }
}
