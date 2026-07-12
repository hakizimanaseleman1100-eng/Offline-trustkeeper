import { useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from './db';
import { getBusinessId } from './session';

// Self-service ordering on a venue tablet. The customer browses the menu and
// builds an order, then generates a QR the waiter scans. This screen NEVER
// writes to the database, touches stock, or syncs — the order is just a request
// until a waiter accepts it, which is what keeps self-service conflict-free.
function ClientOrder({ onExit }) {
  const [selectedCategory, setSelectedCategory] = useState('All');
  const [search, setSearch] = useState('');
  const [cart, setCart] = useState({}); // item_id -> { id, name, price, qty }
  const [qr, setQr] = useState(null); // { dataUrl } once generated

  const categories = useLiveQuery(() => db.inventory.orderBy('category').uniqueKeys(), [], []);
  const allItems = useLiveQuery(() => db.inventory.toArray(), [], []);
  const items = allItems.filter((it) => {
    const matchesCategory = selectedCategory === 'All' || it.category === selectedCategory;
    const matchesSearch = it.item_name.toLowerCase().includes(search.toLowerCase());
    return matchesCategory && matchesSearch;
  });

  const lines = Object.values(cart);
  const total = lines.reduce((s, l) => s + l.price * l.qty, 0);
  const count = lines.reduce((s, l) => s + l.qty, 0);

  const add = (it) =>
    setCart((c) => {
      const cur = c[it.id];
      return { ...c, [it.id]: { id: it.id, name: it.item_name, price: it.unit_price, qty: (cur?.qty ?? 0) + 1 } };
    });
  const bump = (id, delta) =>
    setCart((c) => {
      const cur = c[id];
      if (!cur) return c;
      const qty = cur.qty + delta;
      if (qty <= 0) {
        const { [id]: _drop, ...rest } = c;
        return rest;
      }
      return { ...c, [id]: { ...cur, qty } };
    });

  const showQr = async () => {
    if (lines.length === 0) return;
    const payload = {
      v: 1,
      biz: getBusinessId(),
      oid: (crypto.randomUUID?.() ?? String(Date.now())).slice(0, 12),
      items: lines.map((l) => ({ id: l.id, n: l.name, q: l.qty })),
    };
    const QRCode = await import('qrcode'); // loaded on demand
    const dataUrl = await QRCode.toDataURL(JSON.stringify(payload), { width: 320, margin: 1 });
    setQr({ dataUrl });
  };

  const reset = () => {
    setCart({});
    setQr(null);
  };

  // The generated-QR screen — customer shows it to the waiter.
  if (qr) {
    return (
      <div className="min-h-screen bg-slate-900 flex flex-col items-center justify-center gap-6 font-sans px-6 py-10 text-center">
        <h1 className="text-2xl font-extrabold text-white">Show this to the waiter</h1>
        <img src={qr.dataUrl} alt="Order QR code" className="w-64 h-64 bg-white p-3 rounded-2xl" />
        <p className="text-slate-300">{count} item{count === 1 ? '' : 's'} · {total.toLocaleString()} RWF</p>
        <p className="text-slate-500 text-sm max-w-xs">The waiter scans this to bring your order. Nothing is charged until they serve you.</p>
        <button onClick={reset} className="px-6 py-3 rounded-xl bg-amber-500 text-white font-bold active:scale-95">
          Start a new order
        </button>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50 font-sans pb-28 lg:pb-8">
      <header className="bg-slate-900 text-white px-4 sm:px-6 lg:px-10 py-3 flex justify-between items-center shadow-lg">
        <h1 className="text-lg sm:text-2xl font-extrabold tracking-tight">Order Here 🙋</h1>
        <button onClick={onExit} className="px-3 py-1.5 rounded-lg bg-slate-700 text-sm font-semibold active:scale-95">
          Exit
        </button>
      </header>

      <main className="p-3 sm:p-5 lg:p-8 max-w-7xl mx-auto">
        <div className="lg:flex lg:gap-6 lg:items-start">
          <div className="lg:flex-1 min-w-0 space-y-3">
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search the menu…"
              className="w-full px-4 lg:px-5 py-2 lg:py-3 rounded-xl border border-gray-300 text-sm lg:text-base shadow-sm"
            />
            <div className="flex gap-1.5 overflow-x-auto pb-1 -mx-1 px-1">
              {['All', ...categories].map((cat) => (
                <button
                  key={cat}
                  onClick={() => setSelectedCategory(cat)}
                  className={`shrink-0 px-3.5 lg:px-5 py-1.5 lg:py-2 rounded-full font-semibold text-xs lg:text-sm transition active:scale-95 ${
                    selectedCategory === cat ? 'bg-amber-500 text-white' : 'bg-white text-slate-600 shadow-sm'
                  }`}
                >
                  {cat}
                </button>
              ))}
            </div>
            {items.length === 0 ? (
              <p className="text-slate-400 text-lg">No items match.</p>
            ) : (
              <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-3 xl:grid-cols-4 gap-2 sm:gap-3">
                {items.map((it) => (
                  <button
                    key={it.id}
                    onClick={() => add(it)}
                    className="p-3 lg:p-4 rounded-xl text-sm sm:text-base lg:text-lg font-bold bg-white shadow-md text-left transition active:scale-95"
                  >
                    <span className="block text-slate-900 leading-tight">{it.item_name}</span>
                    <span className="block text-xs sm:text-sm lg:text-base font-semibold text-slate-500 mt-1">
                      {it.unit_price.toLocaleString()} RWF
                    </span>
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Order summary — side panel on desktop, bottom bar on mobile */}
          <aside className="hidden lg:flex lg:flex-col lg:w-96 lg:shrink-0 lg:sticky lg:top-4 bg-white rounded-2xl shadow-md overflow-hidden max-h-[calc(100vh-7rem)]">
            <div className="px-4 py-3 border-b border-gray-100 font-extrabold text-slate-900">Your Order</div>
            <div className="overflow-y-auto flex-1">
              {lines.length === 0 ? (
                <p className="text-slate-400 p-5">Tap items to add them.</p>
              ) : (
                <div className="divide-y divide-gray-100">
                  {lines.map((l) => (
                    <div key={l.id} className="flex items-center justify-between px-5 py-3 gap-3">
                      <span className="font-semibold text-slate-800 flex-1 min-w-0">{l.name}</span>
                      <div className="flex items-center gap-1 bg-slate-100 rounded-full px-1">
                        <button onClick={() => bump(l.id, -1)} className="w-7 h-7 rounded-full font-bold text-slate-700 active:scale-95">−</button>
                        <span className="w-6 text-center font-semibold text-sm">{l.qty}</span>
                        <button onClick={() => bump(l.id, 1)} className="w-7 h-7 rounded-full font-bold text-slate-700 active:scale-95">+</button>
                      </div>
                      <span className="text-slate-500 w-20 text-right text-sm">{(l.price * l.qty).toLocaleString()} RWF</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
            <div className="p-4 border-t border-gray-100 space-y-3">
              <div className="flex items-center justify-between text-xl font-bold text-slate-900 px-1">
                <span>Total</span>
                <span>{total.toLocaleString()} RWF</span>
              </div>
              <button
                onClick={showQr}
                disabled={lines.length === 0}
                className="w-full h-14 rounded-xl bg-slate-900 text-white text-lg font-bold active:scale-95 disabled:opacity-40"
              >
                Done — Show QR
              </button>
            </div>
          </aside>
        </div>
      </main>

      {/* Mobile order bar */}
      {lines.length > 0 && (
        <MobileOrderBar lines={lines} total={total} count={count} bump={bump} onDone={showQr} />
      )}
    </div>
  );
}

// Bottom bar + expandable order list for phones.
function MobileOrderBar({ lines, total, count, bump, onDone }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      {open && (
        <div className="lg:hidden fixed inset-0 z-30 flex flex-col justify-end" onClick={() => setOpen(false)}>
          <div className="absolute inset-0 bg-black/40" />
          <div onClick={(e) => e.stopPropagation()} className="relative bg-white rounded-t-3xl shadow-xl max-h-[75vh] flex flex-col">
            <div className="px-5 py-4 border-b border-gray-100 font-extrabold text-slate-900">Your Order</div>
            <div className="overflow-y-auto flex-1 divide-y divide-gray-100">
              {lines.map((l) => (
                <div key={l.id} className="flex items-center justify-between px-5 py-3 gap-3">
                  <span className="font-semibold text-slate-800 flex-1 min-w-0">{l.name}</span>
                  <div className="flex items-center gap-1 bg-slate-100 rounded-full px-1">
                    <button onClick={() => bump(l.id, -1)} className="w-7 h-7 rounded-full font-bold text-slate-700 active:scale-95">−</button>
                    <span className="w-6 text-center font-semibold text-sm">{l.qty}</span>
                    <button onClick={() => bump(l.id, 1)} className="w-7 h-7 rounded-full font-bold text-slate-700 active:scale-95">+</button>
                  </div>
                  <span className="text-slate-500 w-20 text-right text-sm">{(l.price * l.qty).toLocaleString()} RWF</span>
                </div>
              ))}
            </div>
            <div className="p-4 border-t border-gray-100">
              <button onClick={onDone} className="w-full h-14 rounded-xl bg-slate-900 text-white text-lg font-bold active:scale-95">
                Done — Show QR
              </button>
            </div>
          </div>
        </div>
      )}
      <div className="lg:hidden fixed bottom-0 inset-x-0 z-20 bg-white border-t border-gray-200 shadow-[0_-4px_12px_rgba(0,0,0,0.08)] p-3 flex items-center gap-3">
        <button onClick={() => setOpen(true)} className="flex-1 flex items-center justify-between px-4 h-12 rounded-xl bg-slate-100 font-bold text-slate-700 active:scale-95">
          <span>🛒 {count} item{count === 1 ? '' : 's'}</span>
          <span>{total.toLocaleString()} RWF</span>
        </button>
        <button onClick={onDone} className="h-12 px-5 rounded-xl bg-slate-900 text-white font-bold active:scale-95">
          Done
        </button>
      </div>
    </>
  );
}

export default ClientOrder;
