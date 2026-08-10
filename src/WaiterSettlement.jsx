import { useLiveQuery } from 'dexie-react-hooks';
import { db } from './db';

// The counter's answer to "who still owes me?".
//
// In this venue's workflow the waiter collects the customer's money and brings
// it to the barman, who confirms it. So an open tab is not just an unfinished
// order — it is money a named person is holding. This groups both sides of that
// by waiter: what is still outstanding, and what he has already settled today.
//
// Entirely local (Dexie): it has to answer at 11pm with no network, which is
// exactly when the question gets asked.
function WaiterSettlement({ onOpenTab, onClose }) {
  const data = useLiveQuery(async () => {
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);

    const [openTabs, todaysSales] = await Promise.all([
      db.active_tabs.where('status').equals('open').toArray(),
      // Indexed range scan rather than a full table read — this list grows all
      // night and the barman opens this screen often.
      db.sales.where('timestamp').above(startOfDay.getTime()).toArray(),
    ]);

    const openTabIds = openTabs.map((t) => t.id);
    const openTabIdSet = new Set(openTabIds);
    // Only the open tabs' lines, via the tab_id index — an open tab can be
    // hours old, so this cannot be limited to today, and it must not become a
    // full scan of every sale the device has ever recorded.
    const openLines = await db.sales.where('tab_id').anyOf(openTabIds).toArray();
    const totalsByTab = {};
    for (const sale of openLines) {
      totalsByTab[sale.tab_id] = (totalsByTab[sale.tab_id] ?? 0) + (sale.total_price ?? 0);
    }

    // One bucket per waiter. Keyed by name: a tab scanned from a waiter's phone
    // and a line stamped by the same waiter must land together, and the name is
    // what both carry (staff ids differ between a local seed and the server).
    const byWaiter = new Map();
    const bucket = (name) => {
      const key = name || 'Counter';
      if (!byWaiter.has(key)) {
        byWaiter.set(key, {
          name: key,
          openTabs: [],
          openTotal: 0,
          settled: { cash: 0, momo: 0, debt: 0, total: 0 },
        });
      }
      return byWaiter.get(key);
    };

    for (const tab of openTabs) {
      const total = totalsByTab[tab.id] ?? 0;
      if (total === 0) continue; // an empty tab is a false start, not money owed
      const entry = bucket(tab.waiter_name);
      entry.openTabs.push({ id: tab.id, name: tab.name, total });
      entry.openTotal += total;
    }

    // Settled = the tab was closed against a payment method. The line carries
    // the waiter who took the order, which is who should get the credit.
    for (const sale of todaysSales) {
      if (openTabIdSet.has(sale.tab_id)) continue; // still outstanding
      if (!sale.payment_method) continue; // never checked out
      const entry = bucket(sale.staff_name);
      const amount = sale.total_price ?? 0;
      if (entry.settled[sale.payment_method] !== undefined) entry.settled[sale.payment_method] += amount;
      entry.settled.total += amount;
    }

    return [...byWaiter.values()]
      .filter((w) => w.openTotal > 0 || w.settled.total > 0)
      .sort((a, b) => b.openTotal - a.openTotal);
  }, [], null);

  const money = (n) => Math.round(n || 0).toLocaleString();

  return (
    <div className="fixed inset-0 z-40 bg-slate-900/95 overflow-y-auto">
      <div className="max-w-2xl mx-auto p-4 space-y-4">
        <div className="flex items-center justify-between sticky top-0 bg-slate-900 py-3">
          <div>
            <p className="text-white text-xl font-extrabold">Waiters</p>
            <p className="text-slate-400 text-sm">Who is still holding money</p>
          </div>
          <button
            onClick={onClose}
            aria-label="Close"
            className="w-10 h-10 rounded-full bg-white/10 text-white text-2xl leading-none"
          >
            ×
          </button>
        </div>

        {data === null ? (
          <p className="text-slate-400">Loading…</p>
        ) : data.length === 0 ? (
          <p className="text-slate-400">Nothing outstanding, and nothing settled yet today.</p>
        ) : (
          data.map((w) => (
            <div key={w.name} className="bg-white rounded-2xl shadow-md p-4 space-y-3">
              <div className="flex items-start justify-between gap-3">
                <p className="font-extrabold text-slate-800 text-lg">{w.name}</p>
                <div className="text-right shrink-0">
                  <p className={`font-extrabold text-lg ${w.openTotal > 0 ? 'text-amber-600' : 'text-emerald-600'}`}>
                    {money(w.openTotal)} RWF
                  </p>
                  <p className="text-[11px] uppercase tracking-wide text-slate-400">
                    {w.openTabs.length ? `${w.openTabs.length} tab${w.openTabs.length > 1 ? 's' : ''} not settled` : 'all settled'}
                  </p>
                </div>
              </div>

              {/* Tap a tab to take the payment — this is the checkout the waiter
                  came to the counter for, so it is one tap from here. */}
              {w.openTabs.length > 0 && (
                <div className="flex flex-wrap gap-2">
                  {w.openTabs.map((t) => (
                    <button
                      key={t.id}
                      onClick={() => onOpenTab(t.id)}
                      className="px-3 py-2 rounded-xl bg-amber-50 border border-amber-200 text-sm font-semibold text-amber-800 active:scale-95"
                    >
                      {t.name} · {money(t.total)}
                    </button>
                  ))}
                </div>
              )}

              <div className="grid grid-cols-4 gap-2 text-center border-t border-gray-100 pt-3">
                {[
                  ['Cash', w.settled.cash],
                  ['MoMo', w.settled.momo],
                  ['Credit', w.settled.debt],
                  ['Settled', w.settled.total],
                ].map(([label, value], i) => (
                  <div key={label}>
                    <p className="text-[10px] uppercase tracking-wide text-slate-400">{label}</p>
                    <p className={`font-bold text-sm ${i === 3 ? 'text-slate-800' : 'text-slate-600'}`}>
                      {money(value)}
                    </p>
                  </div>
                ))}
              </div>
            </div>
          ))
        )}

        <p className="text-slate-500 text-xs text-center pb-6">
          Not settled = the order is served but no payment has been confirmed at the counter yet.
        </p>
      </div>
    </div>
  );
}

export default WaiterSettlement;
