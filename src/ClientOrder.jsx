import { useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from './db';
import { supabase } from './supabaseClient';
import { getBusinessId } from './session';
import { hashPin } from './auth';

// Self-service ordering on a venue tablet. The customer browses the menu and
// builds an order, then generates a QR the waiter scans. This screen NEVER
// writes to the database, touches stock, or syncs — the order is just a request
// until a waiter accepts it, which keeps self-service conflict-free.
//
// After a round is placed (QR generated) the customer keeps seeing it under
// "Ordered" and can keep adding rounds; each QR carries only the new round, and
// the venue stacks them onto one tab via the detail (table/name).
function ClientOrder({ onExit }) {
  const [selectedCategory, setSelectedCategory] = useState('All');
  const [search, setSearch] = useState('');
  const [cart, setCart] = useState({}); // item_id -> { id, name, price, qty } — the round being built
  const [ordered, setOrdered] = useState([]); // rounds already placed, merged by item
  const [details, setDetails] = useState(''); // table number / name — groups a customer's rounds
  const [qr, setQr] = useState(null); // { dataUrl } once generated
  const [authCustomer, setAuthCustomer] = useState(null); // { id, username } once signed in
  const [account, setAccount] = useState(null); // null | { mode:'register'|'signin'|'forgot', ...fields, busy, error }

  // The menu is exactly the venue's product list (for ordering only — this
  // screen never touches stock). Active items only.
  const categories = useLiveQuery(() => db.inventory.orderBy('category').uniqueKeys(), [], []);
  const allItems = useLiveQuery(() => db.inventory.toArray(), [], []);
  const items = allItems.filter((it) => {
    if (it.active === false) return false;
    const matchesCategory = selectedCategory === 'All' || it.category === selectedCategory;
    const matchesSearch = it.item_name.toLowerCase().includes(search.toLowerCase());
    return matchesCategory && matchesSearch;
  });

  const cartLines = Object.values(cart);
  const cartTotal = cartLines.reduce((s, l) => s + l.price * l.qty, 0);
  const orderedTotal = ordered.reduce((s, l) => s + l.price * l.qty, 0);
  const grandTotal = cartTotal + orderedTotal;
  const grandCount = cartLines.reduce((s, l) => s + l.qty, 0) + ordered.reduce((s, l) => s + l.qty, 0);

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
    if (cartLines.length === 0) return;
    const payload = {
      v: 1,
      biz: getBusinessId(),
      oid: (crypto.randomUUID?.() ?? String(Date.now())).slice(0, 12),
      // A signed-in customer groups by their username automatically, and the
      // order is attributed to them; otherwise fall back to the typed detail.
      details: authCustomer ? authCustomer.username : details.trim(),
      cust: authCustomer ? { id: authCustomer.id, u: authCustomer.username } : null,
      items: cartLines.map((l) => ({ id: l.id, n: l.name, q: l.qty })),
    };
    const QRCode = await import('qrcode'); // loaded on demand
    const dataUrl = await QRCode.toDataURL(JSON.stringify(payload), { width: 320, margin: 1 });
    setQr({ dataUrl });
  };

  // Keep the placed round visible under "Ordered" and start a fresh round.
  const orderMore = () => {
    setOrdered((prev) => {
      const merged = [...prev];
      for (const l of cartLines) {
        const found = merged.find((m) => m.id === l.id);
        if (found) found.qty += l.qty;
        else merged.push({ ...l });
      }
      return merged;
    });
    setCart({});
    setQr(null);
    setSearch('');
    setSelectedCategory('All');
  };

  // Account actions run on the venue tablet (signed in as the venue), so they
  // query/insert the venue's own customers. Passwords are hashed, never plain.
  const openAccount = (mode) =>
    setAccount({ mode, username: '', password: '', phone: '', email: '', tin: '', master: '', newpw: '' });
  const patchAccount = (patch) => setAccount((a) => ({ ...a, ...patch }));

  const doRegister = async () => {
    const a = account;
    if (!a.username?.trim() || !a.password) return patchAccount({ error: 'Username and password are required' });
    patchAccount({ busy: true, error: '' });
    const pw_hash = await hashPin(a.password);
    const { data, error } = await supabase
      .from('customers')
      .insert({
        business_id: getBusinessId(),
        username: a.username.trim(),
        pw_hash,
        phone: a.phone?.trim() || null,
        email: a.email?.trim() || null,
        tin: a.tin?.trim() || null,
        active: true,
      })
      .select('id, username')
      .single();
    if (error) {
      return patchAccount({ busy: false, error: /duplicate|unique/i.test(error.message) ? 'That username is taken' : error.message });
    }
    setAuthCustomer({ id: data.id, username: data.username }); // auto sign-in after registering
    setAccount(null);
  };

  const doSignin = async () => {
    const a = account;
    if (!a.username?.trim() || !a.password) return patchAccount({ error: 'Enter your username and password' });
    patchAccount({ busy: true, error: '' });
    const { data } = await supabase
      .from('customers')
      .select('id, username, pw_hash, active')
      .eq('business_id', getBusinessId())
      .ilike('username', a.username.trim())
      .limit(1);
    const cust = data?.[0];
    const hash = await hashPin(a.password);
    if (!cust || cust.active === false || cust.pw_hash !== hash) {
      return patchAccount({ busy: false, error: 'Wrong username or password' });
    }
    setAuthCustomer({ id: cust.id, username: cust.username });
    setAccount(null);
  };

  // Forgot password: verified with the venue's master password (from staff),
  // then the customer sets a new one and is signed in.
  const doForgot = async () => {
    const a = account;
    if (!a.username?.trim() || !a.master || !a.newpw) return patchAccount({ error: 'Fill in all fields' });
    patchAccount({ busy: true, error: '' });
    const [bizRes, custRes] = await Promise.all([
      supabase.from('businesses').select('customer_master_hash').eq('id', getBusinessId()).single(),
      supabase.from('customers').select('id, username, active').eq('business_id', getBusinessId()).ilike('username', a.username.trim()).limit(1),
    ]);
    const cust = custRes.data?.[0];
    const masterHash = bizRes.data?.customer_master_hash;
    if (!masterHash || (await hashPin(a.master)) !== masterHash) {
      return patchAccount({ busy: false, error: 'Master password is incorrect — ask staff' });
    }
    if (!cust || cust.active === false) {
      return patchAccount({ busy: false, error: 'No such customer' });
    }
    const pw_hash = await hashPin(a.newpw);
    const { error } = await supabase.from('customers').update({ pw_hash }).eq('id', cust.id);
    if (error) return patchAccount({ busy: false, error: error.message });
    setAuthCustomer({ id: cust.id, username: cust.username });
    setAccount(null);
  };

  const signOutCustomer = () => {
    setAuthCustomer(null);
    finish();
  };

  // Clear everything for the next customer.
  const finish = () => {
    setOrdered([]);
    setCart({});
    setDetails('');
    setQr(null);
    setSearch('');
    setSelectedCategory('All');
  };

  // The generated-QR screen — customer shows it to the waiter.
  if (qr) {
    return (
      <div className="min-h-screen bg-slate-900 flex flex-col items-center justify-center gap-5 font-sans px-6 py-10 text-center">
        <h1 className="text-2xl font-extrabold text-white">Show this to the waiter</h1>
        {(authCustomer?.username || details.trim()) && (
          <p className="text-amber-300 font-bold text-lg">
            {authCustomer ? `👤 ${authCustomer.username}` : details.trim()}
          </p>
        )}
        <img src={qr.dataUrl} alt="Order QR code" className="w-60 h-60 bg-white p-3 rounded-2xl" />
        <p className="text-slate-300">
          This round: {cartLines.reduce((s, l) => s + l.qty, 0)} item{cartLines.length === 1 ? '' : 's'} · {cartTotal.toLocaleString()} RWF
        </p>
        <p className="text-slate-500 text-sm max-w-xs">Nothing is charged until the waiter serves you.</p>
        <div className="flex flex-col gap-3 w-full max-w-xs">
          <button onClick={orderMore} className="h-14 rounded-xl bg-amber-500 text-white font-bold active:scale-95">
            ➕ Order more
          </button>
          <button onClick={finish} className="h-12 rounded-xl bg-slate-700 text-white font-bold active:scale-95">
            Done
          </button>
        </div>
      </div>
    );
  }

  const orderBody = (
    <>
      {ordered.length > 0 && (
        <div className="border-b border-gray-100">
          <p className="text-xs font-bold uppercase text-emerald-500 px-5 pt-3 pb-1">Ordered</p>
          {ordered.map((l) => (
            <div key={l.id} className="flex items-center justify-between px-5 py-2 gap-3 text-slate-500">
              <span className="flex-1 min-w-0">
                {l.name} <span className="text-slate-400">× {l.qty}</span>
              </span>
              <span className="text-sm">{(l.price * l.qty).toLocaleString()} RWF</span>
            </div>
          ))}
        </div>
      )}
      {ordered.length > 0 && cartLines.length > 0 && (
        <p className="text-xs font-bold uppercase text-slate-400 px-5 pt-3 pb-1">New round</p>
      )}
      {cartLines.length === 0 ? (
        <p className="text-slate-400 p-5">{ordered.length ? 'Add another round, or show your QR.' : 'Tap items to add them.'}</p>
      ) : (
        <div className="divide-y divide-gray-100">
          {cartLines.map((l) => (
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
    </>
  );

  return (
    <div className="min-h-screen bg-gray-50 font-sans pb-28 lg:pb-8">
      <header className="bg-slate-900 text-white px-4 sm:px-6 lg:px-10 py-3 flex justify-between items-center shadow-lg">
        <div className="min-w-0">
          <h1 className="text-lg sm:text-2xl font-extrabold tracking-tight">Order Here 🙋</h1>
          {authCustomer && <p className="text-[11px] text-amber-300 truncate">👤 {authCustomer.username}</p>}
        </div>
        <div className="flex items-center gap-2">
          {authCustomer ? (
            <button onClick={signOutCustomer} className="px-3 py-1.5 rounded-lg bg-slate-700 text-sm font-semibold active:scale-95">
              Sign out
            </button>
          ) : (
            <>
              <button onClick={() => openAccount('signin')} className="px-3 py-1.5 rounded-lg bg-slate-700 text-sm font-semibold active:scale-95">
                Sign in
              </button>
              <button onClick={() => openAccount('register')} className="px-3 py-1.5 rounded-lg bg-amber-500 text-sm font-semibold active:scale-95">
                Register
              </button>
            </>
          )}
          <button onClick={onExit} className="px-3 py-1.5 rounded-lg bg-slate-700 text-sm font-semibold active:scale-95">
            Exit
          </button>
        </div>
      </header>

      {/* Account modal — register / sign in / forgot password */}
      {account && (
        <div className="fixed inset-0 z-40 flex items-center justify-center p-4" onClick={() => !account.busy && setAccount(null)}>
          <div className="absolute inset-0 bg-black/50" />
          <div onClick={(e) => e.stopPropagation()} className="relative bg-white rounded-2xl shadow-xl w-full max-w-sm p-6 space-y-3">
            <div className="flex items-center justify-between">
              <h3 className="font-extrabold text-lg text-slate-900">
                {account.mode === 'register' ? 'Create your account' : account.mode === 'forgot' ? 'Reset password' : 'Sign in'}
              </h3>
              <button onClick={() => setAccount(null)} className="text-slate-400 text-2xl leading-none w-8 h-8">×</button>
            </div>

            {account.mode === 'register' && (
              <>
                <p className="text-sm text-slate-500">Choose a username &amp; password. Phone, email and TIN are optional.</p>
                <input placeholder="Username" value={account.username} onChange={(e) => patchAccount({ username: e.target.value })} className="w-full px-4 py-3 rounded-xl border border-gray-300" />
                <input type="password" placeholder="Password" value={account.password} onChange={(e) => patchAccount({ password: e.target.value })} className="w-full px-4 py-3 rounded-xl border border-gray-300" />
                <input placeholder="Phone (optional)" value={account.phone} onChange={(e) => patchAccount({ phone: e.target.value })} className="w-full px-4 py-3 rounded-xl border border-gray-300" />
                <input type="email" placeholder="Email (optional)" value={account.email} onChange={(e) => patchAccount({ email: e.target.value })} className="w-full px-4 py-3 rounded-xl border border-gray-300" />
                <input placeholder="TIN (optional)" value={account.tin} onChange={(e) => patchAccount({ tin: e.target.value })} className="w-full px-4 py-3 rounded-xl border border-gray-300" />
              </>
            )}

            {account.mode === 'signin' && (
              <>
                <input placeholder="Username" value={account.username} onChange={(e) => patchAccount({ username: e.target.value })} className="w-full px-4 py-3 rounded-xl border border-gray-300" />
                <input type="password" placeholder="Password" value={account.password} onChange={(e) => patchAccount({ password: e.target.value })} className="w-full px-4 py-3 rounded-xl border border-gray-300" />
                <button onClick={() => patchAccount({ mode: 'forgot', error: '' })} className="text-slate-500 text-sm underline">
                  Forgot password?
                </button>
              </>
            )}

            {account.mode === 'forgot' && (
              <>
                <p className="text-sm text-slate-500">Ask staff for the venue master password, then set a new password.</p>
                <input placeholder="Username" value={account.username} onChange={(e) => patchAccount({ username: e.target.value })} className="w-full px-4 py-3 rounded-xl border border-gray-300" />
                <input type="password" placeholder="Master password (from staff)" value={account.master} onChange={(e) => patchAccount({ master: e.target.value })} className="w-full px-4 py-3 rounded-xl border border-gray-300" />
                <input type="password" placeholder="New password" value={account.newpw} onChange={(e) => patchAccount({ newpw: e.target.value })} className="w-full px-4 py-3 rounded-xl border border-gray-300" />
              </>
            )}

            {account.error && <p className="text-red-600 text-sm">{account.error}</p>}
            <button
              onClick={account.mode === 'register' ? doRegister : account.mode === 'forgot' ? doForgot : doSignin}
              disabled={account.busy}
              className="w-full h-12 rounded-xl bg-slate-900 text-white font-bold active:scale-95 disabled:opacity-50"
            >
              {account.busy ? 'Please wait…' : account.mode === 'register' ? 'Create account' : account.mode === 'forgot' ? 'Reset & sign in' : 'Sign in'}
            </button>
          </div>
        </div>
      )}

      <main className="p-3 sm:p-5 lg:p-8 max-w-7xl mx-auto">
        {authCustomer ? (
          <p className="mb-3 lg:mb-4 text-slate-500 text-sm">Ordering as <span className="font-bold text-slate-800">{authCustomer.username}</span> — your rounds go to your tab automatically.</p>
        ) : (
          <input
            type="text"
            value={details}
            onChange={(e) => setDetails(e.target.value)}
            placeholder="Table number or your name (so the waiter can bring more to the same table)"
            className="w-full mb-3 lg:mb-4 px-4 lg:px-5 py-3 rounded-xl border border-gray-300 text-sm lg:text-base shadow-sm"
          />
        )}
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

          {/* Order summary — side panel on desktop */}
          <aside className="hidden lg:flex lg:flex-col lg:w-96 lg:shrink-0 lg:sticky lg:top-4 bg-white rounded-2xl shadow-md overflow-hidden max-h-[calc(100vh-7rem)]">
            <div className="px-4 py-3 border-b border-gray-100 font-extrabold text-slate-900">Your Order</div>
            <div className="overflow-y-auto flex-1">{orderBody}</div>
            <div className="p-4 border-t border-gray-100 space-y-3">
              <div className="flex items-center justify-between text-xl font-bold text-slate-900 px-1">
                <span>Total</span>
                <span>{grandTotal.toLocaleString()} RWF</span>
              </div>
              <button
                onClick={showQr}
                disabled={cartLines.length === 0}
                className="w-full h-14 rounded-xl bg-slate-900 text-white text-lg font-bold active:scale-95 disabled:opacity-40"
              >
                {ordered.length ? 'Show QR for new round' : 'Done — Show QR'}
              </button>
            </div>
          </aside>
        </div>
      </main>

      {/* Mobile order bar */}
      {(cartLines.length > 0 || ordered.length > 0) && (
        <MobileOrderBar body={orderBody} grandTotal={grandTotal} grandCount={grandCount} onDone={showQr} canShow={cartLines.length > 0} orderedOnly={cartLines.length === 0} />
      )}
    </div>
  );
}

// Bottom bar + expandable order list for phones.
function MobileOrderBar({ body, grandTotal, grandCount, onDone, canShow, orderedOnly }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      {open && (
        <div className="lg:hidden fixed inset-0 z-30 flex flex-col justify-end" onClick={() => setOpen(false)}>
          <div className="absolute inset-0 bg-black/40" />
          <div onClick={(e) => e.stopPropagation()} className="relative bg-white rounded-t-3xl shadow-xl max-h-[75vh] flex flex-col">
            <div className="px-5 py-4 border-b border-gray-100 font-extrabold text-slate-900">Your Order</div>
            <div className="overflow-y-auto flex-1">{body}</div>
            <div className="p-4 border-t border-gray-100">
              <button onClick={onDone} disabled={!canShow} className="w-full h-14 rounded-xl bg-slate-900 text-white text-lg font-bold active:scale-95 disabled:opacity-40">
                Show QR
              </button>
            </div>
          </div>
        </div>
      )}
      <div className="lg:hidden fixed bottom-0 inset-x-0 z-20 bg-white border-t border-gray-200 shadow-[0_-4px_12px_rgba(0,0,0,0.08)] p-3 flex items-center gap-3">
        <button onClick={() => setOpen(true)} className="flex-1 flex items-center justify-between px-4 h-12 rounded-xl bg-slate-100 font-bold text-slate-700 active:scale-95">
          <span>🛒 {grandCount} item{grandCount === 1 ? '' : 's'}</span>
          <span>{grandTotal.toLocaleString()} RWF</span>
        </button>
        <button onClick={onDone} disabled={!canShow} className="h-12 px-5 rounded-xl bg-slate-900 text-white font-bold active:scale-95 disabled:opacity-40">
          {orderedOnly ? 'Add' : 'Done'}
        </button>
      </div>
    </>
  );
}

export default ClientOrder;
