import { useState, useEffect, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from './db';
import { can } from './permissions';
// purchaseOps, not "purchases": a module named purchases.js next to
// Purchases.jsx resolves to the wrong file on a case-insensitive filesystem
// (Windows/macOS), and the import silently picks up the module with no default
// export.
import {
  savePurchase,
  voidPurchase,
  receiveDraft,
  buildSuggestions,
  buildOrderRows,
  orderText,
} from './purchaseOps';

// Purchase management — its own module, deliberately NOT inside the 3k-line
// OwnerDashboard.
//
// The framing that should stay visible in the copy: this completes
// `expected = opening + purchases − sales`. Until deliveries are recorded, a
// stock gap proves nothing, because "a crate came in and nobody wrote it down"
// is always available as an answer — and is often the true one.
//
// Ordering is a LIST you read down, not a search box you use twenty times.
// Stock, the last price the supplier charged, and how many crates the sales
// history says to buy are all on the row before anyone types anything.

const money = (n) => Math.round(n || 0).toLocaleString();

function Purchases({ currentUser, notify }) {
  const [screen, setScreen] = useState('new'); // new | history | suggest
  const [prefill, setPrefill] = useState(null); // { [product_id]: packages }
  const [orderSheet, setOrderSheet] = useState(null); // a saved order to send/print
  const canVoid = can(currentUser?.role, 'purchases.void');

  return (
    <div className="space-y-5">
      <p className="text-slate-500 text-sm">
        Ibicuruzwa byinjiye — recording what came in is what makes a stock gap mean something:
        <span className="font-semibold text-slate-700"> expected = opening + purchases − sales</span>.
      </p>

      <div className="flex gap-2">
        {[
          ['new', '🧾 Order / delivery'],
          ['history', '📋 History'],
          ['suggest', '📊 Stock analysis'],
        ].map(([key, label]) => (
          <button
            key={key}
            onClick={() => setScreen(key)}
            className={`px-4 py-2 rounded-xl text-sm font-semibold active:scale-95 ${
              screen === key ? 'bg-slate-900 text-white' : 'bg-white text-slate-600 shadow-sm'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {screen === 'new' && (
        <NewPurchase
          currentUser={currentUser}
          notify={notify}
          prefill={prefill}
          onConsumedPrefill={() => setPrefill(null)}
          onSaved={(sheet) => {
            if (sheet) setOrderSheet(sheet);
            else setScreen('history');
          }}
        />
      )}
      {screen === 'history' && (
        <PurchaseHistory
          currentUser={currentUser}
          notify={notify}
          canVoid={canVoid}
          onSend={setOrderSheet}
        />
      )}
      {screen === 'suggest' && (
        <StockAnalysis
          onOrderThese={(map) => {
            setPrefill(map);
            setScreen('new');
          }}
        />
      )}

      {orderSheet && <OrderSheet {...orderSheet} notify={notify} onClose={() => setOrderSheet(null)} />}
    </div>
  );
}

// ---- 1. Order / delivery — one row per product ------------------------------

function NewPurchase({ currentUser, notify, onSaved, prefill, onConsumedPrefill }) {
  const stations = useLiveQuery(() => db.stations.toArray(), [], []);
  const recentSuppliers = useLiveQuery(async () => {
    const rows = await db.purchases.orderBy('created_at').reverse().limit(50).toArray();
    return [...new Set(rows.map((r) => r.supplier_name).filter(Boolean))];
  }, [], []);

  const [supplier, setSupplier] = useState('');
  const [notes, setNotes] = useState('');
  const [stationId, setStationId] = useState(currentUser?.station_id ?? '');
  const [search, setSearch] = useState('');
  const [showAll, setShowAll] = useState(false);
  const [entries, setEntries] = useState({}); // product_id -> { packages, loose, packageCost }
  const [busy, setBusy] = useState(false);

  const effectiveStation = stationId || stations.find((s) => s.active !== false)?.id || '';
  const rows = useLiveQuery(() => buildOrderRows({ stationId: effectiveStation || null }), [effectiveStation], null);

  // Costs are prefilled from what the supplier last actually charged; quantities
  // are NOT, because a list that arrives pre-filled with quantities is an order
  // nobody decided to place.
  useEffect(() => {
    if (!rows) return;
    setEntries((current) => {
      const next = { ...current };
      for (const r of rows) {
        if (!next[r.id]) next[r.id] = { packages: '', loose: '', packageCost: String(r.packageCost || '') };
      }
      return next;
    });
  }, [rows]);

  // Arriving from the analysis screen with "order these".
  useEffect(() => {
    if (!prefill || !rows) return;
    setEntries((current) => {
      const next = { ...current };
      for (const [id, packages] of Object.entries(prefill)) {
        const row = rows.find((r) => r.id === id);
        next[id] = {
          packages: String(packages),
          loose: next[id]?.loose ?? '',
          packageCost: next[id]?.packageCost || String(row?.packageCost || ''),
        };
      }
      return next;
    });
    onConsumedPrefill?.();
  }, [prefill, rows, onConsumedPrefill]);

  const patch = (id, changes) =>
    setEntries((current) => ({ ...current, [id]: { ...current[id], ...changes } }));

  const fillSuggested = () => {
    if (!rows) return;
    setEntries((current) => {
      const next = { ...current };
      for (const r of rows) {
        if (r.suggestedPackages > 0) {
          next[r.id] = { ...next[r.id], packages: String(r.suggestedPackages) };
        }
      }
      return next;
    });
  };

  const visible = useMemo(() => {
    if (!rows) return [];
    const q = search.trim().toLowerCase();
    return rows.filter((r) => {
      if (q && !(r.name ?? '').toLowerCase().includes(q)) return false;
      if (showAll) return true;
      // By default: things a venue actually restocks — crated goods, anything
      // held in stock, and anything already typed into this order.
      const typed = Number(entries[r.id]?.packages) > 0 || Number(entries[r.id]?.loose) > 0;
      return r.units_per_package > 1 || r.stationStock > 0 || typed;
    });
  }, [rows, search, showAll, entries]);

  const lines = useMemo(() => {
    if (!rows) return [];
    return rows
      .map((r) => {
        const e = entries[r.id] ?? {};
        const packages = Number(e.packages) || 0;
        const loose = Number(e.loose) || 0;
        const quantity = packages * r.units_per_package + loose;
        if (quantity <= 0) return null;
        const unit_cost = Math.round((Number(e.packageCost) || 0) / Math.max(1, r.units_per_package));
        return {
          product_id: r.id,
          product_name: r.name,
          package_name: r.package_name,
          packages,
          loose_units: loose,
          units_per_package_snapshot: r.units_per_package,
          quantity,
          unit_cost,
          line_cost: quantity * unit_cost,
        };
      })
      .filter(Boolean);
  }, [rows, entries]);

  const total = lines.reduce((sum, l) => sum + l.line_cost, 0);

  const save = async ({ receive }) => {
    if (lines.length === 0) return notify('Enter how many crates to order');
    setBusy(true);
    try {
      const result = await savePurchase({
        header: { supplier_name: supplier, notes },
        lines,
        station_id: effectiveStation || null,
        staff: currentUser,
        receive,
      });
      setEntries({});
      setSupplier('');
      setNotes('');
      if (receive) {
        notify(`${result.po_number} received · ${money(result.total_cost)} RWF`);
        onSaved?.(null);
      } else {
        // A draft is an ORDER: hand back a document to send to the supplier.
        notify(`Order ${result.po_number} saved`);
        onSaved?.({
          purchase: { ...result, supplier_name: supplier, notes, created_at: Date.now(), total_cost: result.total_cost },
          lines,
        });
      }
    } catch (err) {
      console.error('Purchase save failed:', err);
      notify(err.message ?? 'Could not save');
    } finally {
      setBusy(false);
    }
  };

  if (rows === null) return <p className="text-slate-400">Loading…</p>;

  return (
    <div className="space-y-4 pb-24">
      <div className="bg-white rounded-2xl shadow-md p-4 grid grid-cols-1 sm:grid-cols-2 gap-3">
        <input
          list="recent-suppliers"
          value={supplier}
          onChange={(e) => setSupplier(e.target.value)}
          placeholder="Supplier (e.g. Bralirwa depot)"
          className="px-4 py-2 rounded-lg border border-gray-300"
        />
        <datalist id="recent-suppliers">
          {recentSuppliers.map((s) => (
            <option key={s} value={s} />
          ))}
        </datalist>
        <select
          value={effectiveStation}
          onChange={(e) => setStationId(e.target.value)}
          className="px-4 py-2 rounded-lg border border-gray-300"
        >
          <option value="">No station</option>
          {stations
            .filter((s) => s.active !== false)
            .map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
        </select>
        <input
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="Note (delivery note number, driver…)"
          className="px-4 py-2 rounded-lg border border-gray-300 sm:col-span-2"
        />
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Filter the list…"
          className="flex-1 min-w-[12rem] px-4 py-2 rounded-lg border border-gray-300"
        />
        <button
          onClick={fillSuggested}
          className="px-3 py-2 rounded-lg bg-white text-slate-700 text-sm font-semibold shadow-sm active:scale-95"
        >
          ✨ Fill suggested
        </button>
        <button
          onClick={() => setShowAll((v) => !v)}
          className="px-3 py-2 rounded-lg bg-white text-slate-600 text-sm font-semibold shadow-sm active:scale-95"
        >
          {showAll ? 'Stocked only' : 'Show all products'}
        </button>
      </div>

      <div className="overflow-x-auto bg-white rounded-2xl shadow-md">
        <table className="w-full text-left text-sm whitespace-nowrap">
          <thead className="bg-slate-100 text-slate-600 text-[11px]">
            <tr>
              <th className="px-3 py-2">IBICURUZWA<div className="font-normal text-slate-400 normal-case">Item</div></th>
              <th className="px-3 py-2 text-right">Stock</th>
              <th className="px-3 py-2 text-right">Suggested</th>
              <th className="px-3 py-2 text-right">AMAKASE<div className="font-normal text-slate-400 normal-case">Order</div></th>
              <th className="px-3 py-2 text-right">Loose</th>
              <th className="px-3 py-2 text-right">Cost / case</th>
              <th className="px-3 py-2 text-right">Line</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {visible.map((r) => {
              const e = entries[r.id] ?? {};
              const packages = Number(e.packages) || 0;
              const loose = Number(e.loose) || 0;
              const quantity = packages * r.units_per_package + loose;
              const unitCost = Math.round((Number(e.packageCost) || 0) / Math.max(1, r.units_per_package));
              return (
                <tr key={r.id} className={quantity > 0 ? 'bg-emerald-50/40' : ''}>
                  <td className="px-3 py-2">
                    <p className="font-semibold text-slate-700">{r.name}</p>
                    <p className="text-[11px] text-slate-400">
                      {r.units_per_package > 1 ? `${r.units_per_package} / ${r.package_name}` : 'by unit'}
                      {r.daysLeft !== null && r.daysLeft < 3 && (
                        <span className="text-red-600 font-semibold"> · {r.daysLeft.toFixed(1)}d left</span>
                      )}
                    </p>
                  </td>
                  <td className="px-3 py-2 text-right text-slate-500">{Math.round(r.stationStock)}</td>
                  <td className="px-3 py-2 text-right">
                    {r.suggestedPackages > 0 ? (
                      <button
                        onClick={() => patch(r.id, { packages: String(r.suggestedPackages) })}
                        className="px-2 py-1 rounded-lg bg-amber-100 text-amber-700 font-bold text-xs active:scale-95"
                      >
                        {r.suggestedPackages}
                      </button>
                    ) : (
                      <span className="text-slate-300">—</span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-right">
                    <input
                      type="number"
                      min="0"
                      inputMode="numeric"
                      value={e.packages ?? ''}
                      onChange={(ev) => patch(r.id, { packages: ev.target.value })}
                      className="w-16 px-2 py-1.5 rounded border border-gray-300 text-right font-bold"
                    />
                  </td>
                  <td className="px-3 py-2 text-right">
                    {r.units_per_package > 1 ? (
                      <input
                        type="number"
                        min="0"
                        inputMode="numeric"
                        value={e.loose ?? ''}
                        onChange={(ev) => patch(r.id, { loose: ev.target.value })}
                        className="w-14 px-2 py-1.5 rounded border border-gray-300 text-right"
                      />
                    ) : (
                      <span className="text-slate-300">—</span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-right">
                    <input
                      type="number"
                      min="0"
                      inputMode="numeric"
                      value={e.packageCost ?? ''}
                      onChange={(ev) => patch(r.id, { packageCost: ev.target.value })}
                      className="w-24 px-2 py-1.5 rounded border border-gray-300 text-right"
                    />
                    {/* Say when the price is a real one the supplier charged, so
                        nobody mistakes the product's standing cost for it. */}
                    {!r.pricedFromHistory && Number(e.packageCost) > 0 && (
                      <span className="block text-[10px] text-slate-400">from product cost</span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-right font-semibold text-slate-800">
                    {quantity > 0 ? `${money(quantity * unitCost)}` : <span className="text-slate-300">—</span>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {visible.length === 0 && (
          <p className="px-4 py-6 text-slate-400 text-sm">
            Nothing to show. Set “per case” on a product in Inventory, or tap “Show all products”.
          </p>
        )}
      </div>

      {/* Sticky action bar: the totals and both endings of the flow. */}
      <div className="fixed bottom-0 inset-x-0 md:left-64 bg-slate-900 text-white px-4 py-3 flex items-center justify-between gap-3 z-20">
        <div>
          <p className="text-[11px] uppercase tracking-wide text-slate-400">
            {lines.length} line{lines.length === 1 ? '' : 's'}
          </p>
          <p className="text-xl font-extrabold">{money(total)} RWF</p>
        </div>
        <div className="flex gap-2">
          <button
            onClick={() => save({ receive: false })}
            disabled={busy}
            className="px-4 py-2.5 rounded-xl bg-white/10 font-bold text-sm active:scale-95 disabled:opacity-50"
          >
            📤 Save order
          </button>
          <button
            onClick={() => save({ receive: true })}
            disabled={busy}
            className="px-4 py-2.5 rounded-xl bg-emerald-500 font-bold text-sm active:scale-95 disabled:opacity-50"
          >
            {busy ? '…' : '✔ Received now'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ---- The document the supplier gets ----------------------------------------

function OrderSheet({ purchase, lines, notify, onClose }) {
  const [venue, setVenue] = useState('');
  useEffect(() => {
    db.meta.get('business').then((row) => setVenue(row?.value?.name ?? ''));
  }, []);

  const text = orderText({ purchase, lines, venueName: venue });

  const share = async () => {
    const data = { title: `Order ${purchase.po_number}`, text };
    if (navigator.share && (!navigator.canShare || navigator.canShare(data))) {
      try {
        await navigator.share(data);
        return;
      } catch (err) {
        if (err?.name === 'AbortError') return;
      }
    }
    try {
      await navigator.clipboard.writeText(text);
      notify?.('Order copied — paste it to the supplier');
    } catch {
      notify?.('Could not share the order');
    }
  };

  // Print by hiding everything else on the page: the sheet is portalled to the
  // body so no ancestor's `display:none` can swallow it (a descendant cannot
  // override a hidden ancestor).
  const print = () => {
    document.body.classList.add('printing-order');
    window.print();
    document.body.classList.remove('printing-order');
  };

  return (
    <>
      <div className="fixed inset-0 z-50 bg-slate-900/80 flex items-center justify-center p-4">
        <div className="bg-white rounded-2xl shadow-xl w-full max-w-md p-5 space-y-4">
          <div>
            <p className="font-extrabold text-slate-800 text-lg">Order {purchase.po_number}</p>
            <p className="text-slate-500 text-sm">Send this to the supplier. Mark it received when it arrives.</p>
          </div>
          <pre className="bg-slate-50 rounded-xl p-3 text-xs text-slate-700 whitespace-pre-wrap max-h-64 overflow-y-auto">
            {text}
          </pre>
          <div className="grid grid-cols-3 gap-2">
            <button onClick={share} className="h-12 rounded-xl bg-amber-500 text-white font-bold active:scale-95">
              ↗ Send
            </button>
            <button onClick={print} className="h-12 rounded-xl bg-slate-900 text-white font-bold active:scale-95">
              🖨 Print
            </button>
            <button onClick={onClose} className="h-12 rounded-xl bg-slate-100 text-slate-600 font-bold active:scale-95">
              Close
            </button>
          </div>
        </div>
      </div>

      {createPortal(
        <div id="order-print" className="hidden print:block p-8 font-mono text-black whitespace-pre-wrap">
          {text}
        </div>,
        document.body
      )}
    </>
  );
}

// ---- 2. History -------------------------------------------------------------

function PurchaseHistory({ currentUser, notify, canVoid, onSend }) {
  const [openUid, setOpenUid] = useState(null);
  const purchases = useLiveQuery(
    () => db.purchases.orderBy('created_at').reverse().limit(100).toArray(),
    [],
    null
  );
  const lines = useLiveQuery(
    () => (openUid ? db.purchase_lines.where('purchase_uid').equals(openUid).toArray() : []),
    [openUid],
    []
  );

  const doVoid = async (purchase) => {
    if (!window.confirm(`Void ${purchase.po_number}? Stock goes back down and costs return to what they were.`)) return;
    try {
      await voidPurchase(purchase, currentUser);
      notify(`${purchase.po_number} voided`);
    } catch (err) {
      notify(err.message ?? 'Could not void');
    }
  };

  const doReceive = async (purchase) => {
    try {
      await receiveDraft(purchase, currentUser);
      notify(`${purchase.po_number} received — stock updated`);
    } catch (err) {
      notify(err.message ?? 'Could not receive');
    }
  };

  const doSend = async (purchase) => {
    const rows = await db.purchase_lines.where('purchase_uid').equals(purchase.uid).toArray();
    onSend?.({ purchase, lines: rows });
  };

  if (purchases === null) return <p className="text-slate-400">Loading…</p>;
  if (purchases.length === 0) {
    return <div className="bg-white rounded-2xl shadow-md px-5 py-6 text-slate-400">No orders or deliveries yet.</div>;
  }

  return (
    <div className="bg-white rounded-2xl shadow-md divide-y divide-gray-100">
      {purchases.map((p) => (
        <div key={p.uid}>
          <button
            onClick={() => setOpenUid(openUid === p.uid ? null : p.uid)}
            className="w-full flex items-center justify-between gap-3 px-5 py-4 text-left"
          >
            <div className="min-w-0">
              <p className={`font-semibold truncate ${p.status === 'void' ? 'text-slate-400 line-through' : 'text-slate-800'}`}>
                {p.supplier_name || 'Supplier not named'}
                {p.status === 'draft' && (
                  <span className="ml-2 text-[10px] uppercase tracking-wide bg-amber-100 text-amber-700 rounded px-1.5 py-0.5">
                    ordered
                  </span>
                )}
              </p>
              <p className="text-xs text-slate-400 truncate">
                {p.po_number} · {new Date(p.created_at).toLocaleDateString()}
                {p.synced_status === 0 && ' · waiting to upload'}
              </p>
            </div>
            <span className="font-bold text-slate-800 shrink-0">{money(p.total_cost)} RWF</span>
          </button>

          {openUid === p.uid && (
            <div className="px-5 pb-4 space-y-2">
              {lines.map((l) => (
                <div key={l.uid} className="flex justify-between text-sm text-slate-600">
                  <span className="truncate pr-2">
                    {l.product_name}
                    <span className="text-slate-400">
                      {' '}
                      · {l.packages > 0 ? `${l.packages} × ${l.units_per_package_snapshot}` : ''}
                      {l.loose_units > 0 ? ` +${l.loose_units}` : ''} = {l.quantity} units
                    </span>
                  </span>
                  <span className="shrink-0">{money(l.line_cost)}</span>
                </div>
              ))}
              <div className="flex flex-wrap gap-2 pt-2">
                <button
                  onClick={() => doSend(p)}
                  className="px-4 py-2 rounded-lg bg-slate-100 text-slate-700 text-sm font-semibold active:scale-95"
                >
                  ↗ Send / print
                </button>
                {p.status === 'draft' && (
                  <button
                    onClick={() => doReceive(p)}
                    className="px-4 py-2 rounded-lg bg-emerald-600 text-white text-sm font-semibold active:scale-95"
                  >
                    ✔ Mark received — update stock
                  </button>
                )}
                {canVoid && p.status !== 'void' && (
                  <button
                    onClick={() => doVoid(p)}
                    className="px-4 py-2 rounded-lg bg-red-50 text-red-600 text-sm font-semibold active:scale-95"
                  >
                    Void
                  </button>
                )}
                {p.status === 'void' && (
                  <span className="text-xs text-slate-400 self-center">Voided by {p.voided_by ?? '—'}</span>
                )}
              </div>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

// ---- 3. Stock analysis (amacupa) -------------------------------------------

function StockAnalysis({ onOrderThese }) {
  const [targetDays, setTargetDays] = useState(7);
  const [empties, setEmpties] = useState({}); // product_id -> counted empties
  const rows = useLiveQuery(() => buildSuggestions({ targetDays }), [targetDays], null);
  const crated = useMemo(() => (rows ?? []).filter((r) => r.units_per_package > 1), [rows]);

  const orderThese = () => {
    const map = Object.fromEntries(
      crated.filter((r) => r.suggestedPackages > 0).map((r) => [r.id, r.suggestedPackages])
    );
    onOrderThese?.(map);
  };

  if (rows === null) return <p className="text-slate-400">Loading…</p>;

  return (
    <div className="space-y-4">
      <div className="bg-white rounded-2xl shadow-md p-4 flex flex-wrap items-center gap-3">
        <label className="text-sm text-slate-600">
          Cover for
          <input
            type="number"
            min="1"
            value={targetDays}
            onChange={(e) => setTargetDays(Math.max(1, Number(e.target.value) || 1))}
            className="mx-2 w-16 px-2 py-1 rounded border border-gray-300 text-center"
          />
          days
        </label>
        <span className="text-xs text-slate-400">Velocity from the last 14 days of recorded sales.</span>
        <button
          onClick={orderThese}
          className="ml-auto px-4 py-2 rounded-lg bg-amber-500 text-white text-sm font-semibold active:scale-95"
        >
          Order these →
        </button>
      </div>

      <div className="overflow-x-auto bg-white rounded-2xl shadow-md">
        <table className="w-full text-left text-sm whitespace-nowrap">
          <thead className="bg-slate-100 text-slate-600 text-[11px]">
            <tr>
              <th className="px-3 py-2">IBICURUZWA<div className="font-normal text-slate-400 normal-case">Item</div></th>
              <th className="px-3 py-2 text-right">Sold/day</th>
              <th className="px-3 py-2 text-right">Stock</th>
              <th className="px-3 py-2 text-right">Days left</th>
              <th className="px-3 py-2 text-right">AMAKASE<div className="font-normal text-slate-400 normal-case">Suggested</div></th>
              <th className="px-3 py-2 text-right">Empties<div className="font-normal text-slate-400 normal-case">counted</div></th>
              <th className="px-3 py-2 text-right">ICYUHO<div className="font-normal text-slate-400 normal-case">vs sold (14d)</div></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {crated.map((r) => {
              const counted = empties[r.id];
              const hasCount = counted !== undefined && String(counted).trim() !== '';
              // Empties are a cross-check, not an accounting entry (v1): bottles
              // sold should come back as empties. What is missing is a signal,
              // not a posted number.
              const gap = hasCount ? r.sold - Number(counted) : null;
              return (
                <tr key={r.id}>
                  <td className="px-3 py-2 font-semibold text-slate-700">{r.name}</td>
                  <td className="px-3 py-2 text-right text-slate-500">{r.dailyVelocity.toFixed(1)}</td>
                  <td className="px-3 py-2 text-right text-slate-500">
                    {Math.round(r.stock)}
                    <span className="text-slate-400 text-xs"> ({r.stockPackages.toFixed(1)} {r.package_name})</span>
                  </td>
                  <td className={`px-3 py-2 text-right font-semibold ${r.daysLeft !== null && r.daysLeft < 2 ? 'text-red-600' : 'text-slate-500'}`}>
                    {r.daysLeft === null ? '—' : r.daysLeft.toFixed(1)}
                  </td>
                  <td className="px-3 py-2 text-right font-extrabold text-slate-800">
                    {r.suggestedPackages > 0 ? r.suggestedPackages : '—'}
                  </td>
                  <td className="px-3 py-2 text-right">
                    <input
                      type="number"
                      min="0"
                      value={empties[r.id] ?? ''}
                      onChange={(e) => setEmpties({ ...empties, [r.id]: e.target.value })}
                      className="w-16 px-2 py-1 rounded border border-gray-300 text-right"
                    />
                  </td>
                  <td className={`px-3 py-2 text-right font-semibold ${gap > 0 ? 'text-red-600' : 'text-slate-300'}`}>
                    {gap === null ? '—' : gap > 0 ? `${gap} bottles` : '0'}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {crated.length === 0 && (
        <p className="text-slate-400 text-sm">
          No crated products yet — set “per case” on a product in Inventory and it will appear here.
        </p>
      )}
    </div>
  );
}

export default Purchases;
