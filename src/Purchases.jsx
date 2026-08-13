import { useState, useMemo } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from './db';
import { can } from './permissions';
// purchaseOps, not "purchases": a module named purchases.js next to
// Purchases.jsx resolves to the wrong file on a case-insensitive filesystem
// (Windows/macOS), and the import silently picks up the module with no default
// export.
import { savePurchase, voidPurchase, receiveDraft, buildSuggestions, unitCostFromPackage } from './purchaseOps';

// Purchase management — its own module, deliberately NOT inside the 3k-line
// OwnerDashboard.
//
// The framing that should stay visible in the copy: this completes
// `expected = opening + purchases − sales`. Until deliveries are recorded, a
// stock gap proves nothing, because "a crate came in and nobody wrote it down"
// is always available as an answer — and is often the true one.

const money = (n) => Math.round(n || 0).toLocaleString();

function Purchases({ currentUser, notify }) {
  const [screen, setScreen] = useState('new'); // new | history | suggest
  const canVoid = can(currentUser?.role, 'purchases.void');

  return (
    <div className="space-y-5">
      <p className="text-slate-500 text-sm">
        Ibicuruzwa byinjiye — recording what came in is what makes a stock gap mean something:
        <span className="font-semibold text-slate-700"> expected = opening + purchases − sales</span>.
      </p>

      <div className="flex gap-2">
        {[
          ['new', '➕ New delivery'],
          ['history', '📋 History'],
          ['suggest', '📊 Suggested order'],
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

      {screen === 'new' && <NewPurchase currentUser={currentUser} notify={notify} onSaved={() => setScreen('history')} />}
      {screen === 'history' && <PurchaseHistory currentUser={currentUser} notify={notify} canVoid={canVoid} />}
      {screen === 'suggest' && <SuggestedOrder currentUser={currentUser} notify={notify} onDrafted={() => setScreen('history')} />}
    </div>
  );
}

// ---- 1. New delivery (the 90% flow) ----------------------------------------

function NewPurchase({ currentUser, notify, onSaved }) {
  const products = useLiveQuery(() => db.inventory.toArray(), [], []);
  const stations = useLiveQuery(() => db.stations.toArray(), [], []);
  const recentSuppliers = useLiveQuery(async () => {
    const rows = await db.purchases.orderBy('created_at').reverse().limit(50).toArray();
    return [...new Set(rows.map((r) => r.supplier_name).filter(Boolean))];
  }, [], []);

  const [supplier, setSupplier] = useState('');
  const [notes, setNotes] = useState('');
  const [stationId, setStationId] = useState(currentUser?.station_id ?? '');
  const [search, setSearch] = useState('');
  const [lines, setLines] = useState(initialLines);
  const [busy, setBusy] = useState(false);

  // Default the station once they load: goods have to land somewhere, and a
  // one-counter venue should never have to think about it.
  const effectiveStation = stationId || stations.find((s) => s.active !== false)?.id || '';

  const matches = search.trim()
    ? products
        .filter((p) => (p.item_name ?? '').toLowerCase().includes(search.trim().toLowerCase()))
        .slice(0, 8)
    : [];

  const addLine = (product) => {
    const per = Math.max(1, Number(product.units_per_package) || 1);
    setLines((current) => [
      ...current,
      {
        key: crypto.randomUUID(),
        product_id: String(product.id),
        product_name: product.item_name,
        package_name: product.package_name || 'case',
        units_per_package_snapshot: per,
        packages: '',
        loose_units: '',
        package_cost: per > 1 ? String(Math.round((product.cost_price ?? 0) * per)) : String(product.cost_price ?? 0),
        current_cost: Number(product.cost_price ?? 0),
      },
    ]);
    setSearch('');
  };

  const patch = (key, changes) =>
    setLines((current) => current.map((l) => (l.key === key ? { ...l, ...changes } : l)));

  const computed = lines.map((l) => {
    const per = Math.max(1, Number(l.units_per_package_snapshot) || 1);
    const quantity = (Number(l.packages) || 0) * per + (Number(l.loose_units) || 0);
    const unit_cost = unitCostFromPackage(l.package_cost, per);
    const line_cost = quantity * unit_cost;
    // Passive signal, never a block: supplier prices move, and the owner should
    // simply be able to SEE that this crate cost more than the last one.
    const changePct = l.current_cost > 0 ? ((unit_cost - l.current_cost) / l.current_cost) * 100 : 0;
    return { ...l, per, quantity, unit_cost, line_cost, changePct };
  });

  const total = computed.reduce((sum, l) => sum + l.line_cost, 0);
  const totalUnits = computed.reduce((sum, l) => sum + l.quantity, 0);

  const save = async () => {
    if (computed.every((l) => l.quantity === 0)) return notify('Enter how many came in');
    setBusy(true);
    try {
      const result = await savePurchase({
        header: { supplier_name: supplier, notes },
        lines: computed.map((l) => ({
          product_id: l.product_id,
          product_name: l.product_name,
          packages: l.packages,
          loose_units: l.loose_units,
          units_per_package_snapshot: l.per,
          unit_cost: l.unit_cost,
        })),
        station_id: effectiveStation || null,
        staff: currentUser,
        receive: true, // v1 flow is record-on-delivery; drafts come from the suggested order
      });
      notify(`${result.po_number} received · ${money(result.total_cost)} RWF`);
      setLines([]);
      setSupplier('');
      setNotes('');
      onSaved?.();
    } catch (err) {
      console.error('Purchase save failed:', err);
      notify(err.message ?? 'Could not save the delivery');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4">
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

      {/* Product search */}
      <div className="bg-white rounded-2xl shadow-md p-4">
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search a product to add…"
          className="w-full px-4 py-3 rounded-lg border border-gray-300"
        />
        {matches.length > 0 && (
          <div className="mt-2 divide-y divide-gray-100">
            {matches.map((p) => (
              <button
                key={p.id}
                onClick={() => addLine(p)}
                className="w-full text-left px-2 py-2.5 hover:bg-slate-50 flex justify-between items-center"
              >
                <span className="font-semibold text-slate-700">{p.item_name}</span>
                <span className="text-xs text-slate-400">
                  {Number(p.units_per_package) > 1
                    ? `${p.units_per_package} / ${p.package_name || 'case'}`
                    : 'by unit'}
                </span>
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Lines */}
      {computed.length > 0 && (
        <div className="space-y-3">
          {computed.map((l) => (
            <div key={l.key} className="bg-white rounded-2xl shadow-md p-4 space-y-3">
              <div className="flex justify-between items-start gap-3">
                <div className="min-w-0">
                  <p className="font-bold text-slate-800 truncate">{l.product_name}</p>
                  <p className="text-xs text-slate-400">
                    {l.per > 1 ? `${l.per} per ${l.package_name}` : 'sold by unit'}
                  </p>
                </div>
                <button
                  onClick={() => setLines((current) => current.filter((x) => x.key !== l.key))}
                  className="text-slate-400 text-xl leading-none px-2"
                  aria-label={`Remove ${l.product_name}`}
                >
                  ×
                </button>
              </div>

              <div className="grid grid-cols-3 gap-2">
                <label className="col-span-1">
                  <span className="block text-[11px] uppercase tracking-wide text-slate-400 mb-1">
                    {l.per > 1 ? 'Amakase' : 'Units'}
                  </span>
                  <input
                    type="number"
                    min="0"
                    inputMode="numeric"
                    value={l.packages}
                    onChange={(e) => patch(l.key, { packages: e.target.value })}
                    className="w-full px-3 py-3 rounded-lg border border-gray-300 text-xl font-bold text-center"
                  />
                </label>
                {l.per > 1 && (
                  <label>
                    <span className="block text-[11px] uppercase tracking-wide text-slate-400 mb-1">Loose</span>
                    <input
                      type="number"
                      min="0"
                      inputMode="numeric"
                      value={l.loose_units}
                      onChange={(e) => patch(l.key, { loose_units: e.target.value })}
                      className="w-full px-3 py-3 rounded-lg border border-gray-300 text-center"
                    />
                  </label>
                )}
                <label className={l.per > 1 ? '' : 'col-span-2'}>
                  <span className="block text-[11px] uppercase tracking-wide text-slate-400 mb-1">
                    Cost / {l.per > 1 ? l.package_name : 'unit'}
                  </span>
                  <input
                    type="number"
                    min="0"
                    inputMode="numeric"
                    value={l.package_cost}
                    onChange={(e) => patch(l.key, { package_cost: e.target.value })}
                    className="w-full px-3 py-3 rounded-lg border border-gray-300 text-right"
                  />
                </label>
              </div>

              <div className="flex justify-between items-center text-sm">
                <span className="text-slate-500">
                  {l.quantity} units × {money(l.unit_cost)}
                  {Math.abs(l.changePct) > 10 && l.current_cost > 0 && (
                    <span className={`ml-2 font-semibold ${l.changePct > 0 ? 'text-amber-600' : 'text-emerald-600'}`}>
                      {l.changePct > 0 ? '↑' : '↓'} was {money(l.current_cost)}
                    </span>
                  )}
                </span>
                <span className="font-bold text-slate-800">{money(l.line_cost)} RWF</span>
              </div>
            </div>
          ))}

          <div className="bg-slate-900 text-white rounded-2xl p-4 flex justify-between items-center">
            <div>
              <p className="text-xs uppercase tracking-wide text-slate-400">Total · {totalUnits} units</p>
              <p className="text-2xl font-extrabold">{money(total)} RWF</p>
            </div>
            <button
              onClick={save}
              disabled={busy}
              className="px-6 py-3 rounded-xl bg-emerald-500 font-bold active:scale-95 disabled:opacity-50"
            >
              {busy ? 'Saving…' : '✔ Received'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ---- 2. History -------------------------------------------------------------

function PurchaseHistory({ currentUser, notify, canVoid }) {
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
      notify(`${purchase.po_number} received`);
    } catch (err) {
      notify(err.message ?? 'Could not receive');
    }
  };

  if (purchases === null) return <p className="text-slate-400">Loading…</p>;
  if (purchases.length === 0) {
    return <div className="bg-white rounded-2xl shadow-md px-5 py-6 text-slate-400">No deliveries recorded yet.</div>;
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
              </p>
              <p className="text-xs text-slate-400 truncate">
                {p.po_number} · {new Date(p.created_at).toLocaleDateString()}
                {p.status === 'draft' && ' · DRAFT'}
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
              <div className="flex gap-2 pt-2">
                {p.status === 'draft' && (
                  <button
                    onClick={() => doReceive(p)}
                    className="px-4 py-2 rounded-lg bg-emerald-600 text-white text-sm font-semibold active:scale-95"
                  >
                    ✔ Mark received
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

// ---- 3. Suggested order (amacupa) ------------------------------------------

function SuggestedOrder({ currentUser, notify, onDrafted }) {
  const [targetDays, setTargetDays] = useState(7);
  const [empties, setEmpties] = useState({}); // product_id -> counted empties
  const [busy, setBusy] = useState(false);
  const rows = useLiveQuery(() => buildSuggestions({ targetDays }), [targetDays], null);

  // Only crated products by default — nobody reorders airtime by the case.
  const crated = useMemo(() => (rows ?? []).filter((r) => r.units_per_package > 1), [rows]);

  const createDraft = async () => {
    const wanted = crated.filter((r) => r.suggestedPackages > 0);
    if (wanted.length === 0) return notify('Nothing needs reordering yet');
    setBusy(true);
    try {
      await savePurchase({
        header: { supplier_name: '', notes: `Suggested order · ${targetDays} days cover` },
        lines: wanted.map((r) => ({
          product_id: r.id,
          product_name: r.name,
          packages: r.suggestedPackages,
          loose_units: 0,
          units_per_package_snapshot: r.units_per_package,
          unit_cost: r.cost_price,
        })),
        station_id: currentUser?.station_id ?? null,
        staff: currentUser,
        receive: false, // a draft: the storeman marks it received on delivery
      });
      notify('Draft order created — mark it received when it arrives');
      onDrafted?.();
    } catch (err) {
      notify(err.message ?? 'Could not create the draft');
    } finally {
      setBusy(false);
    }
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
          onClick={createDraft}
          disabled={busy}
          className="ml-auto px-4 py-2 rounded-lg bg-amber-500 text-white text-sm font-semibold active:scale-95 disabled:opacity-50"
        >
          {busy ? 'Creating…' : 'Create draft order'}
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
          No crated products yet — set “units per {`{package}`}” on a product in Inventory and it will appear here.
        </p>
      )}
    </div>
  );
}

export default Purchases;
