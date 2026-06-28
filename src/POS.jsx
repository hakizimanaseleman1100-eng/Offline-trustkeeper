import { useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from './db';
import { supabase } from './supabaseClient';
import { CURRENT_BUSINESS_ID } from './config';

function POS({ onLogout }) {
  const [activeTabId, setActiveTabId] = useState(null);
  const [category, setCategory] = useState(null);
  const [toast, setToast] = useState('');
  const [syncing, setSyncing] = useState(false);
  const [showCustomerDetails, setShowCustomerDetails] = useState(false);
  const [customerTin, setCustomerTin] = useState('');
  const [customerPhone, setCustomerPhone] = useState('');

  const showToast = (message, duration = 2500) => {
    setToast(message);
    setTimeout(() => setToast(''), duration);
  };

  const openTabs = useLiveQuery(
    () => db.active_tabs.where('status').equals('open').reverse().sortBy('created_at'),
    [],
    []
  );

  const activeTab = useLiveQuery(
    () => (activeTabId ? db.active_tabs.get(activeTabId) : null),
    [activeTabId]
  );

  // Categories come from whatever is actually in inventory — no hardcoded list.
  const categories = useLiveQuery(() => db.inventory.orderBy('category').uniqueKeys(), [], []);

  const items = useLiveQuery(
    () => (category ? db.inventory.where('category').equals(category).toArray() : []),
    [category],
    []
  );

  // Cart for the open tab — joined with inventory so the list can show item names.
  const cartItems = useLiveQuery(
    async () => {
      if (!activeTabId) return [];
      const rows = await db.sales.where('tab_id').equals(activeTabId).toArray();
      return Promise.all(
        rows.map(async (row) => ({
          ...row,
          name: (await db.inventory.get(row.item_id))?.item_name ?? 'Unknown item',
        }))
      );
    },
    [activeTabId],
    []
  );
  const cartTotal = cartItems.reduce((sum, row) => sum + row.total_price, 0);

  const createTab = async () => {
    const tabNumber = (await db.active_tabs.count()) + 1;
    const id = await db.active_tabs.add({
      name: `Tab ${tabNumber}`,
      created_at: Date.now(),
      status: 'open',
    });
    setActiveTabId(id);
    setCategory(null);
  };

  // A waiter can optionally rename the tab later, from the Customer Details
  // panel — renaming isn't a precondition for opening a tab and serving.
  const renameTab = (name) => {
    db.active_tabs.update(activeTabId, { name });
  };

  const closeTabView = () => {
    setActiveTabId(null);
    setCategory(null);
    setShowCustomerDetails(false);
    setCustomerTin('');
    setCustomerPhone('');
  };

  const addItemToTab = async (item) => {
    // Repeated taps on the same item bump quantity on its existing cart line
    // instead of stacking up duplicate rows — one line per item, not per tap.
    const existing = await db.sales
      .where('tab_id')
      .equals(activeTabId)
      .filter((row) => row.item_id === item.id)
      .first();

    if (existing) {
      const quantity = (existing.quantity ?? 1) + 1;
      await db.sales.update(existing.id, {
        quantity,
        total_price: item.unit_price * quantity,
      });
      return;
    }

    // Snapshot cost/tax exactly as they are right now — inventory prices and
    // tax rules can change later, but a past sale must keep what was true at sale time.
    await db.sales.add({
      item_id: item.id,
      tab_id: activeTabId,
      quantity: 1,
      total_price: item.unit_price,
      cost_price: item.cost_price,
      tax_label: item.tax_label,
      tax_rate: item.tax_rate,
      timestamp: Date.now(),
      synced_status: 0,
    });
  };

  const checkout = async (paymentMethod) => {
    if (cartItems.length === 0) return;
    try {
      await db.sales.bulkUpdate(
        cartItems.map((row) => ({
          key: row.id,
          changes: {
            payment_method: paymentMethod,
            customer_tin: customerTin || null,
            customer_phone: customerPhone || null,
          },
        }))
      );
      await db.active_tabs.update(activeTabId, { status: 'paid' });
      showToast(`${activeTab?.name ?? 'Tab'} closed — ${paymentMethod.toUpperCase()}`);
      closeTabView();
    } catch (err) {
      console.error('Failed to close tab:', err);
      showToast('Error: could not close tab');
    }
  };

  const syncData = async () => {
    setSyncing(true);
    try {
      const paidTabIds = new Set(
        (await db.active_tabs.where('status').equals('paid').toArray()).map((tab) => tab.id)
      );
      const unsynced = (await db.sales.where('synced_status').equals(0).toArray()).filter((sale) =>
        paidTabIds.has(sale.tab_id)
      );

      if (unsynced.length === 0) {
        showToast('Sync Complete: 0 records uploaded');
        return;
      }

      const { error } = await supabase.from('hospitality_sales').insert(
        unsynced.map((sale) => ({
          business_id: CURRENT_BUSINESS_ID,
          item_id: sale.item_id,
          quantity: sale.quantity ?? 1,
          total_price: sale.total_price,
          payment_method: sale.payment_method,
          cost_price: sale.cost_price,
          tax_label: sale.tax_label,
          tax_rate: sale.tax_rate,
          customer_tin: sale.customer_tin ?? null,
          customer_phone: sale.customer_phone ?? null,
          timestamp: new Date(sale.timestamp).toISOString(),
        }))
      );
      if (error) throw error;

      await db.sales.bulkUpdate(
        unsynced.map((sale) => ({ key: sale.id, changes: { synced_status: 1 } }))
      );

      showToast(`Sync Complete: ${unsynced.length} records uploaded`);
    } catch (err) {
      console.error('Sync failed:', err.message, err.details, err.hint, err.code);
      showToast('Sync failed — will retry later');
    } finally {
      setSyncing(false);
    }
  };

  return (
    <div className="min-h-screen bg-gray-50 font-sans pb-44">
      {/* Header */}
      <header className="bg-slate-900 text-white px-4 sm:px-6 py-4 sm:py-5 flex flex-wrap gap-3 justify-between items-center shadow-lg">
        <h1 className="text-2xl sm:text-3xl font-extrabold tracking-tight">Sovereign POS</h1>
        <div className="flex items-center gap-3 sm:gap-5">
          <div className="text-right">
            <div className="text-xs uppercase tracking-widest text-slate-400">Open Tabs</div>
            <div className="text-xl sm:text-2xl font-bold">{openTabs.length}</div>
          </div>
          <button
            onClick={syncData}
            disabled={syncing}
            aria-label="Sync to Cloud"
            className="px-3 sm:px-4 py-2 rounded-xl bg-emerald-600 font-semibold text-sm transition active:scale-95 disabled:opacity-50"
          >
            <span className="sm:hidden">☁</span>
            <span className="hidden sm:inline">{syncing ? 'Syncing…' : '☁ Sync to Cloud'}</span>
          </button>
          <button
            onClick={onLogout}
            aria-label="Logout"
            className="px-3 py-2 rounded-xl bg-slate-700 font-semibold text-sm transition active:scale-95"
          >
            <span className="sm:hidden">⏏</span>
            <span className="hidden sm:inline">Logout</span>
          </button>
        </div>
      </header>

      <main className="p-4 sm:p-5 space-y-8 max-w-5xl mx-auto">
        {activeTabId === null ? (
          /* HOME: split screen — active tabs grid (left) + create tab (right), stacked on mobile */
          <div className="flex flex-col sm:grid sm:grid-cols-3 gap-5">
            <div className="sm:col-span-2">
              <p className="text-slate-500 font-semibold mb-4 text-lg">Active Tabs</p>
              {openTabs.length === 0 ? (
                <p className="text-slate-400 text-lg">No open tabs. Create one to start an order.</p>
              ) : (
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
                  {openTabs.map((tab) => (
                    <button
                      key={tab.id}
                      onClick={() => setActiveTabId(tab.id)}
                      className="h-20 sm:h-24 rounded-2xl text-lg sm:text-xl font-bold bg-white shadow-md transition active:scale-95 border-4 border-transparent text-slate-800"
                    >
                      {tab.name}
                    </button>
                  ))}
                </div>
              )}
            </div>
            <button
              onClick={createTab}
              className="h-20 sm:h-24 rounded-2xl text-xl sm:text-2xl font-bold bg-amber-500 text-white shadow-md transition active:scale-95"
            >
              + New Tab
            </button>
          </div>
        ) : (
          /* INSIDE A TAB: category → items → running cart */
          <div className="space-y-8">
            <div className="flex items-center justify-between">
              <h2 className="text-2xl font-extrabold text-slate-900">{activeTab?.name}</h2>
              <button
                onClick={closeTabView}
                className="px-4 py-2 rounded-xl bg-white shadow-md font-semibold text-slate-600 active:scale-95"
              >
                ← Back to Tabs
              </button>
            </div>

            {/* TAP 1: Category — read from whatever categories exist in inventory */}
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3 sm:gap-5">
              {categories.length === 0 ? (
                <p className="col-span-2 sm:col-span-3 lg:col-span-4 text-slate-400 text-lg">
                  No inventory yet — connect to the internet to sync products.
                </p>
              ) : (
                categories.map((cat) => (
                  <button
                    key={cat}
                    onClick={() => setCategory(cat)}
                    className={`h-20 sm:h-24 rounded-2xl text-lg sm:text-2xl font-bold bg-white shadow-md transition active:scale-95 border-4 ${
                      category === cat ? 'border-amber-500 text-amber-600' : 'border-transparent text-slate-800'
                    }`}
                  >
                    {cat}
                  </button>
                ))
              )}
            </div>

            {/* TAP 2: Item grid — tapping adds straight to the tab's cart */}
            {category && (
              <div>
                <p className="text-slate-500 font-semibold mb-4 text-lg">Tap to add</p>
                <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3 sm:gap-5">
                  {items.map((item) => (
                    <button
                      key={item.id}
                      onClick={() => addItemToTab(item)}
                      className="p-4 sm:p-6 rounded-2xl text-lg sm:text-xl font-bold bg-white shadow-md text-left transition active:scale-95 border-4 border-transparent"
                    >
                      <span className="block text-slate-900">{item.item_name}</span>
                      <span className="block text-base font-semibold text-slate-500 mt-1">
                        {item.unit_price.toLocaleString()} RWF
                      </span>
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* Running cart for this tab */}
            <div>
              <p className="text-slate-500 font-semibold mb-4 text-lg">Order so far</p>
              {cartItems.length === 0 ? (
                <p className="text-slate-400 text-lg">Nothing added yet.</p>
              ) : (
                <div className="bg-white rounded-2xl shadow-md divide-y divide-gray-100">
                  {cartItems.map((row) => (
                    <div key={row.id} className="flex justify-between px-5 py-3 text-lg">
                      <span className="font-semibold text-slate-800">
                        {row.name}
                        {row.quantity > 1 && <span className="text-slate-400 font-normal"> × {row.quantity}</span>}
                      </span>
                      <span className="text-slate-500">{row.total_price.toLocaleString()} RWF</span>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Optional details — collapsed by default, no text input forced while serving */}
            <div>
              <button
                onClick={() => setShowCustomerDetails((open) => !open)}
                className="text-slate-500 font-semibold underline"
              >
                {showCustomerDetails ? '− Hide' : '+ Add'} Customer Details (optional)
              </button>
              {showCustomerDetails && (
                <div className="mt-4 grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <input
                    type="text"
                    placeholder="Table / Guest name"
                    defaultValue={activeTab?.name ?? ''}
                    onChange={(e) => renameTab(e.target.value)}
                    className="px-4 py-3 rounded-xl border border-gray-300 text-lg sm:col-span-2"
                  />
                  <input
                    type="text"
                    inputMode="numeric"
                    placeholder="Customer TIN"
                    value={customerTin}
                    onChange={(e) => setCustomerTin(e.target.value)}
                    className="px-4 py-3 rounded-xl border border-gray-300 text-lg"
                  />
                  <input
                    type="tel"
                    placeholder="Customer Phone"
                    value={customerPhone}
                    onChange={(e) => setCustomerPhone(e.target.value)}
                    className="px-4 py-3 rounded-xl border border-gray-300 text-lg"
                  />
                </div>
              )}
            </div>
          </div>
        )}
      </main>

      {/* Toast */}
      {toast && (
        <div className="fixed bottom-48 left-1/2 -translate-x-1/2 bg-slate-900 text-white px-6 py-3 rounded-full shadow-xl text-lg z-10">
          {toast}
        </div>
      )}

      {/* TAP 3: Fixed full-width checkout footer — only meaningful inside a tab */}
      {activeTabId !== null && (
        <footer className="fixed bottom-0 left-0 right-0 bg-white border-t border-gray-200 shadow-[0_-4px_12px_rgba(0,0,0,0.08)]">
          <div className="text-center py-3 h-12">
            {cartItems.length > 0 ? (
              <span className="text-xl font-bold text-slate-800">
                Total: {cartTotal.toLocaleString()} RWF
              </span>
            ) : (
              <span className="text-slate-400 text-lg">Add items to charge</span>
            )}
          </div>
          <div className="grid grid-cols-2">
            <button
              onClick={() => checkout('cash')}
              disabled={cartItems.length === 0}
              className="h-20 text-xl sm:text-3xl font-bold bg-green-600 text-white transition active:scale-95 disabled:opacity-40"
            >
              PAY CASH
            </button>
            <button
              onClick={() => checkout('momo')}
              disabled={cartItems.length === 0}
              className="h-20 text-xl sm:text-3xl font-bold bg-blue-600 text-white transition active:scale-95 disabled:opacity-40"
            >
              MOMO
            </button>
          </div>
        </footer>
      )}
    </div>
  );
}

export default POS;
