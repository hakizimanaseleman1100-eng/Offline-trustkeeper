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
  buildOrderRows,
  orderText,
} from './purchaseOps';
import { nextPoNumber } from './receipts';

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
          currentUser={currentUser}
          notify={notify}
          onOrderThese={(map) => {
            setPrefill(map);
            setScreen('new');
          }}
          onPreview={setOrderSheet}
        />
      )}

      {orderSheet && (
        <OrderSheet
          purchase={orderSheet.purchase}
          lines={orderSheet.lines}
          onSave={orderSheet.onSave}
          notify={notify}
          onClose={() => setOrderSheet(null)}
        />
      )}
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

  // Print or send what is on screen without committing to it. The PO number is
  // minted here and reused on save, so the supplier's copy and the record in
  // History carry the same one.
  const preview = async () => {
    if (lines.length === 0) return notify('Enter how many crates to order');
    const po_number = await nextPoNumber();
    const total_cost = lines.reduce((sum, l) => sum + l.line_cost, 0);
    onSaved?.({
      purchase: { po_number, supplier_name: supplier, notes, total_cost, created_at: Date.now() },
      lines,
      onSave: async () => {
        await savePurchase({
          header: { po_number, supplier_name: supplier, notes },
          lines,
          station_id: effectiveStation || null,
          staff: currentUser,
          receive: false,
        });
        setEntries({});
        notify(`Order ${po_number} saved`);
      },
    });
  };

  const save = async () => {
    if (lines.length === 0) return notify('Enter how many crates to order');
    setBusy(true);
    try {
      const result = await savePurchase({
        header: { supplier_name: supplier, notes },
        lines,
        station_id: effectiveStation || null,
        staff: currentUser,
        receive: true,
      });
      setEntries({});
      setSupplier('');
      setNotes('');
      notify(`${result.po_number} received · ${money(result.total_cost)} RWF`);
      onSaved?.(null);
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
            onClick={preview}
            disabled={busy}
            className="px-4 py-2.5 rounded-xl bg-white/10 font-bold text-sm active:scale-95 disabled:opacity-50"
          >
            📄 Sheet
          </button>
          <button
            onClick={save}
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

function OrderSheet({ purchase, lines, notify, onClose, onSave }) {
  const [venue, setVenue] = useState('');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
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
            <p className="text-slate-500 text-sm">
              {onSave && !saved
                ? 'Send or print it now. Save it to check the delivery in later.'
                : 'Send this to the supplier. Mark it received when it arrives.'}
            </p>
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
          {/* An unsaved preview: nothing is recorded until this is pressed, so
              a sheet can be printed for a supplier without cluttering History
              with orders that were never placed. */}
          {onSave && (
            <button
              onClick={async () => {
                setSaving(true);
                try {
                  await onSave();
                  setSaved(true);
                } finally {
                  setSaving(false);
                }
              }}
              disabled={saving || saved}
              className="w-full h-12 rounded-xl bg-emerald-600 text-white font-bold active:scale-95 disabled:opacity-50"
            >
              {saved ? '✔ Saved — check it in from History' : saving ? 'Saving…' : '💾 Save this order'}
            </button>
          )}
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
  const [receiving, setReceiving] = useState(null); // { purchase, lines } being checked in
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

  // Receiving opens the editor rather than applying the order blind: what was
  // ordered and what turned up are different documents.
  const openReceive = async (purchase) => {
    const rows = await db.purchase_lines.where('purchase_uid').equals(purchase.uid).toArray();
    setReceiving({ purchase, lines: rows });
  };

  const confirmReceive = async (purchase, edits) => {
    try {
      await receiveDraft(purchase, currentUser, edits);
      notify(`${purchase.po_number} received — stock updated`);
      setReceiving(null);
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
                    onClick={() => openReceive(p)}
                    className="px-4 py-2 rounded-lg bg-emerald-600 text-white text-sm font-semibold active:scale-95"
                  >
                    ✔ Check in delivery
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

      {receiving && (
        <ReceiveSheet
          {...receiving}
          onCancel={() => setReceiving(null)}
          onConfirm={(edits) => confirmReceive(receiving.purchase, edits)}
        />
      )}
    </div>
  );
}

// Checking in a delivery against the order it was raised from.
//
// Prefilled with what was ORDERED, because most lines arrive as asked and the
// storeman should only have to touch the ones that didn't. "Not delivered"
// zeroes a line without removing it — a supplier who keeps missing items is
// something the owner should be able to see later.
function ReceiveSheet({ purchase, lines, onCancel, onConfirm }) {
  const [edits, setEdits] = useState(() =>
    Object.fromEntries(
      lines.map((l) => [
        l.uid,
        { packages: String(l.packages ?? 0), loose_units: String(l.loose_units ?? 0), unit_cost: String(l.unit_cost ?? 0) },
      ])
    )
  );
  const [busy, setBusy] = useState(false);

  const patch = (uid, changes) => setEdits((current) => ({ ...current, [uid]: { ...current[uid], ...changes } }));

  const computed = lines.map((l) => {
    const e = edits[l.uid] ?? {};
    const per = Math.max(1, Number(l.units_per_package_snapshot) || 1);
    const quantity = (Number(e.packages) || 0) * per + (Number(e.loose_units) || 0);
    const unit_cost = Math.round(Number(e.unit_cost) || 0);
    const orderedQty = (l.packages ?? 0) * per + (l.loose_units ?? 0);
    return { ...l, per, quantity, unit_cost, orderedQty, line_cost: quantity * unit_cost };
  });

  const total = computed.reduce((sum, l) => sum + l.line_cost, 0);
  const short = computed.filter((l) => l.quantity < l.orderedQty).length;

  return (
    <div className="fixed inset-0 z-50 bg-slate-900/80 flex items-center justify-center p-3">
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-lg max-h-[90vh] flex flex-col">
        <div className="p-4 border-b border-gray-100">
          <p className="font-extrabold text-slate-800 text-lg">Check in {purchase.po_number}</p>
          <p className="text-slate-500 text-sm">
            Change anything that arrived differently. Only what you confirm here goes into stock.
          </p>
        </div>

        <div className="overflow-y-auto p-4 space-y-3">
          {computed.map((l) => (
            <div key={l.uid} className={`rounded-xl border p-3 space-y-2 ${l.quantity === 0 ? 'border-red-200 bg-red-50' : 'border-gray-200'}`}>
              <div className="flex justify-between items-start gap-2">
                <div className="min-w-0">
                  <p className="font-semibold text-slate-800 truncate">{l.product_name}</p>
                  <p className="text-[11px] text-slate-400">
                    Ordered: {l.packages} × {l.per}
                    {l.loose_units ? ` +${l.loose_units}` : ''} = {l.orderedQty} units
                  </p>
                </div>
                <button
                  onClick={() => patch(l.uid, { packages: '0', loose_units: '0' })}
                  className="text-[11px] font-semibold text-red-600 shrink-0"
                >
                  Not delivered
                </button>
              </div>

              <div className="grid grid-cols-3 gap-2">
                <label>
                  <span className="block text-[10px] uppercase tracking-wide text-slate-400 mb-1">Amakase</span>
                  <input
                    type="number"
                    min="0"
                    inputMode="numeric"
                    value={edits[l.uid]?.packages ?? ''}
                    onChange={(e) => patch(l.uid, { packages: e.target.value })}
                    className="w-full px-2 py-2 rounded border border-gray-300 text-right font-bold"
                  />
                </label>
                <label>
                  <span className="block text-[10px] uppercase tracking-wide text-slate-400 mb-1">Loose</span>
                  <input
                    type="number"
                    min="0"
                    inputMode="numeric"
                    value={edits[l.uid]?.loose_units ?? ''}
                    onChange={(e) => patch(l.uid, { loose_units: e.target.value })}
                    className="w-full px-2 py-2 rounded border border-gray-300 text-right"
                  />
                </label>
                <label>
                  <span className="block text-[10px] uppercase tracking-wide text-slate-400 mb-1">Cost / unit</span>
                  <input
                    type="number"
                    min="0"
                    inputMode="numeric"
                    value={edits[l.uid]?.unit_cost ?? ''}
                    onChange={(e) => patch(l.uid, { unit_cost: e.target.value })}
                    className="w-full px-2 py-2 rounded border border-gray-300 text-right"
                  />
                </label>
              </div>

              <div className="flex justify-between text-xs">
                <span className={l.quantity < l.orderedQty ? 'text-red-600 font-semibold' : 'text-slate-500'}>
                  {l.quantity === 0
                    ? 'Not delivered'
                    : l.quantity < l.orderedQty
                      ? `Short by ${l.orderedQty - l.quantity} units`
                      : `${l.quantity} units`}
                </span>
                <span className="font-semibold text-slate-700">{money(l.line_cost)} RWF</span>
              </div>
            </div>
          ))}
        </div>

        <div className="p-4 border-t border-gray-100 space-y-3">
          <div className="flex justify-between items-center">
            <span className="text-slate-500 text-sm">
              {short > 0 ? `${short} line${short === 1 ? '' : 's'} short of the order` : 'Delivered in full'}
            </span>
            <span className="text-xl font-extrabold text-slate-900">{money(total)} RWF</span>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <button onClick={onCancel} className="h-12 rounded-xl bg-slate-100 text-slate-600 font-bold active:scale-95">
              Cancel
            </button>
            <button
              onClick={async () => {
                setBusy(true);
                await onConfirm(edits);
                setBusy(false);
              }}
              disabled={busy}
              className="h-12 rounded-xl bg-emerald-600 text-white font-bold active:scale-95 disabled:opacity-50"
            >
              {busy ? 'Saving…' : '✔ Confirm & update stock'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ---- 3. Stock analysis (amacupa) -------------------------------------------

function StockAnalysis({ currentUser, notify, onOrderThese, onPreview }) {
  const [targetDays, setTargetDays] = useState(7);
  const [empties, setEmpties] = useState({}); // product_id -> counted empties
  const rows = useLiveQuery(() => buildOrderRows({ targetDays }), [targetDays], null);
  const crated = useMemo(() => (rows ?? []).filter((r) => r.units_per_package > 1), [rows]);

  const orderThese = () => {
    const map = Object.fromEntries(
      crated.filter((r) => r.suggestedPackages > 0).map((r) => [r.id, r.suggestedPackages])
    );
    onOrderThese?.(map);
  };

  // The pre-made order: everything the sales history says to buy, at the crate
  // size and the last price paid, as a document — without typing anything or
  // committing to it first. Saving is a button inside the sheet.
  const previewSuggested = async () => {
    const wanted = crated.filter((r) => r.suggestedPackages > 0);
    if (wanted.length === 0) return notify?.('Nothing needs reordering yet');

    const lines = wanted.map((r) => ({
      product_id: r.id,
      product_name: r.name,
      package_name: r.package_name,
      packages: r.suggestedPackages,
      loose_units: 0,
      units_per_package_snapshot: r.units_per_package,
      quantity: r.suggestedPackages * r.units_per_package,
      unit_cost: r.lastUnitCost,
      line_cost: r.suggestedPackages * r.units_per_package * r.lastUnitCost,
    }));
    const total_cost = lines.reduce((sum, l) => sum + l.line_cost, 0);
    // The number is minted now and reused if it is saved, so the paper the
    // supplier holds and the record in History carry the same PO.
    const po_number = await nextPoNumber();

    onPreview?.({
      purchase: { po_number, supplier_name: '', notes: `Suggested order · ${targetDays} days cover`, total_cost, created_at: Date.now() },
      lines,
      onSave: async () => {
        await savePurchase({
          header: { po_number, supplier_name: '', notes: `Suggested order · ${targetDays} days cover` },
          lines,
          station_id: currentUser?.station_id ?? null,
          staff: currentUser,
          receive: false,
        });
        notify?.(`Order ${po_number} saved — mark it received when it arrives`);
      },
    });
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
        <div className="ml-auto flex gap-2">
          <button
            onClick={previewSuggested}
            className="px-4 py-2 rounded-lg bg-slate-900 text-white text-sm font-semibold active:scale-95"
          >
            📄 Order sheet
          </button>
          <button
            onClick={orderThese}
            className="px-4 py-2 rounded-lg bg-amber-500 text-white text-sm font-semibold active:scale-95"
          >
            Edit first →
          </button>
        </div>
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
