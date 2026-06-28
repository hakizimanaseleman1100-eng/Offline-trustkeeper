import { useState, useRef } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from './db';
import { supabase } from './supabaseClient';
import { CURRENT_BUSINESS_ID } from './config';

function POS({ onLogout }) {
  const [activeTabId, setActiveTabId] = useState(null);
  const [selectedCategory, setSelectedCategory] = useState('All');
  const [searchQuery, setSearchQuery] = useState('');
  const [toast, setToast] = useState('');
  const [syncing, setSyncing] = useState(false);
  const [showCustomerDetails, setShowCustomerDetails] = useState(false);
  const [customerTin, setCustomerTin] = useState('');
  const [customerPhone, setCustomerPhone] = useState('');
  const [cartOpen, setCartOpen] = useState(false);
  const [fabPos, setFabPos] = useState(() => ({
    x: window.innerWidth - 88,
    y: window.innerHeight - 240,
  }));
  const dragRef = useRef({ dragging: false, moved: false, startX: 0, startY: 0, origX: 0, origY: 0 });

  const showToast = (message, duration = 2500) => {
    setToast(message);
    setTimeout(() => setToast(''), duration);
  };

  // Dragging the floating cart button moves it; releasing without much
  // movement counts as a tap that opens the cart drawer instead.
  const onFabPointerDown = (e) => {
    e.target.setPointerCapture(e.pointerId);
    dragRef.current = {
      dragging: true,
      moved: false,
      startX: e.clientX,
      startY: e.clientY,
      origX: fabPos.x,
      origY: fabPos.y,
    };
  };

  const onFabPointerMove = (e) => {
    if (!dragRef.current.dragging) return;
    const dx = e.clientX - dragRef.current.startX;
    const dy = e.clientY - dragRef.current.startY;
    if (Math.abs(dx) > 5 || Math.abs(dy) > 5) dragRef.current.moved = true;
    setFabPos({
      x: Math.min(Math.max(0, dragRef.current.origX + dx), window.innerWidth - 64),
      y: Math.min(Math.max(0, dragRef.current.origY + dy), window.innerHeight - 64),
    });
  };

  const onFabPointerUp = () => {
    if (!dragRef.current.moved) setCartOpen(true);
    dragRef.current.dragging = false;
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

  // Items are loaded flat (no category routing step) and filtered in memory
  // by both the selected category pill and the search query.
  const allItems = useLiveQuery(() => db.inventory.toArray(), [], []);
  const items = allItems.filter((item) => {
    const matchesCategory = selectedCategory === 'All' || item.category === selectedCategory;
    const matchesSearch = item.item_name.toLowerCase().includes(searchQuery.toLowerCase());
    return matchesCategory && matchesSearch;
  });

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
  const cartItemCount = cartItems.reduce((sum, row) => sum + (row.quantity ?? 1), 0);
  const currentRound = activeTab?.current_round ?? 1;
  const roundsMap = cartItems.reduce((acc, row) => {
    const r = row.round ?? 1;
    (acc[r] ||= []).push(row);
    return acc;
  }, {});
  const roundNumbers = Object.keys(roundsMap)
    .map(Number)
    .sort((a, b) => a - b);

  const createTab = async () => {
    const tabNumber = (await db.active_tabs.count()) + 1;
    const id = await db.active_tabs.add({
      name: `Tab ${tabNumber}`,
      created_at: Date.now(),
      status: 'open',
      current_round: 1,
    });
    setActiveTabId(id);
    setSelectedCategory('All');
    setSearchQuery('');
  };

  // A waiter can optionally rename the tab later, from the Customer Details
  // panel — renaming isn't a precondition for opening a tab and serving.
  const renameTab = (name) => {
    db.active_tabs.update(activeTabId, { name });
  };

  const closeTabView = () => {
    setActiveTabId(null);
    setSelectedCategory('All');
    setSearchQuery('');
    setShowCustomerDetails(false);
    setCustomerTin('');
    setCustomerPhone('');
    setCartOpen(false);
  };

  const logAudit = (actionType, details) =>
    db.audit_logs.add({
      action_type: actionType,
      details,
      timestamp: Date.now(),
      synced_status: 0,
    });

  const removeItemFromTab = async (saleId, itemName) => {
    // Log BEFORE deleting — if anything goes wrong mid-operation, there's
    // still a record that this removal was attempted.
    await logAudit('VOID_ITEM', `Removed ${itemName} from Tab ${activeTab?.name ?? ''}`);
    await db.sales.delete(saleId);
  };

  const cancelTab = async () => {
    if (!window.confirm(`Void ${activeTab?.name ?? 'this tab'} and discard all its items?`)) return;
    await logAudit(
      'CANCEL_TAB',
      `Cancelled Tab ${activeTab?.name ?? ''} with ${cartItems.length} item(s)`
    );
    await db.sales.where('tab_id').equals(activeTabId).delete();
    await db.active_tabs.delete(activeTabId);
    showToast(`${activeTab?.name ?? 'Tab'} voided`);
    closeTabView();
  };

  const addItemToTab = async (item) => {
    const currentRound = activeTab?.current_round ?? 1;

    // Repeated taps on the same item bump quantity on its existing cart line —
    // but only within the SAME round. A repeat order after "Send Round" gets
    // its own new line, so the kitchen/bar can see it's a fresh request, not
    // silently folded into a round that's already been sent.
    const existing = await db.sales
      .where('tab_id')
      .equals(activeTabId)
      .filter((row) => row.item_id === item.id && (row.round ?? 1) === currentRound)
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
      round: currentRound,
      quantity: 1,
      total_price: item.unit_price,
      cost_price: item.cost_price,
      tax_label: item.tax_label,
      tax_rate: item.tax_rate,
      timestamp: Date.now(),
      synced_status: 0,
    });
  };

  const sendRound = async () => {
    const currentRound = activeTab?.current_round ?? 1;
    await db.active_tabs.update(activeTabId, { current_round: currentRound + 1 });
    showToast(`Round ${currentRound} sent`);
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

      const unsyncedLogs = await db.audit_logs.where('synced_status').equals(0).toArray();
      if (unsyncedLogs.length > 0) {
        const { error: auditError } = await supabase.from('audit_logs').insert(
          unsyncedLogs.map((log) => ({
            business_id: CURRENT_BUSINESS_ID,
            action_type: log.action_type,
            details: log.details,
            timestamp: new Date(log.timestamp).toISOString(),
          }))
        );
        if (auditError) throw auditError;

        await db.audit_logs.bulkUpdate(
          unsyncedLogs.map((log) => ({ key: log.id, changes: { synced_status: 1 } }))
        );
      }

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
            <div className="flex items-center justify-between gap-3">
              <h2 className="text-2xl font-extrabold text-slate-900">{activeTab?.name}</h2>
              <div className="flex items-center gap-3">
                <button
                  onClick={cancelTab}
                  className="px-4 py-2 rounded-xl border-2 border-red-500 text-red-600 font-semibold active:scale-95"
                >
                  Void Tab
                </button>
                <button
                  onClick={closeTabView}
                  className="px-4 py-2 rounded-xl bg-white shadow-md font-semibold text-slate-600 active:scale-95"
                >
                  ← Back to Tabs
                </button>
              </div>
            </div>

            {categories.length === 0 ? (
              <p className="text-slate-400 text-lg">No inventory yet — connect to the internet to sync products.</p>
            ) : (
              <>
                {/* Search bar — items show immediately, no category routing step */}
                <input
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="Search items…"
                  className="w-full px-5 py-4 rounded-2xl border border-gray-300 text-lg shadow-sm"
                />

                {/* Category pills — horizontally scrolling, "All" prepended */}
                <div className="flex gap-2 overflow-x-auto pb-1 -mx-1 px-1">
                  {['All', ...categories].map((cat) => (
                    <button
                      key={cat}
                      onClick={() => setSelectedCategory(cat)}
                      className={`shrink-0 px-5 py-2 rounded-full font-semibold text-sm transition active:scale-95 ${
                        selectedCategory === cat ? 'bg-amber-500 text-white' : 'bg-white text-slate-600 shadow-sm'
                      }`}
                    >
                      {cat}
                    </button>
                  ))}
                </div>

                {/* Item grid — tapping adds straight to the tab's cart */}
                {items.length === 0 ? (
                  <p className="text-slate-400 text-lg">No items match.</p>
                ) : (
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
                )}
              </>
            )}

          </div>
        )}
      </main>

      {/* Floating draggable cart button — drag to reposition, tap to open */}
      {activeTabId !== null && (
        <button
          onPointerDown={onFabPointerDown}
          onPointerMove={onFabPointerMove}
          onPointerUp={onFabPointerUp}
          style={{ left: fabPos.x, top: fabPos.y, touchAction: 'none' }}
          className="fixed z-20 w-16 h-16 rounded-full bg-slate-900 text-white shadow-xl flex items-center justify-center text-2xl active:scale-95"
        >
          🛒
          {cartItemCount > 0 && (
            <span className="absolute -top-1 -right-1 bg-red-500 text-white text-xs font-bold rounded-full w-6 h-6 flex items-center justify-center">
              {cartItemCount}
            </span>
          )}
        </button>
      )}

      {/* Cart drawer — replaces the old inline list; grouped by round */}
      {activeTabId !== null && cartOpen && (
        <div className="fixed inset-0 z-30 flex flex-col justify-end" onClick={() => setCartOpen(false)}>
          <div className="absolute inset-0 bg-black/40" />
          <div
            onClick={(e) => e.stopPropagation()}
            className="relative bg-white rounded-t-3xl shadow-xl max-h-[75vh] flex flex-col"
          >
            <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100">
              <h3 className="text-xl font-extrabold text-slate-900">{activeTab?.name} — Order</h3>
              <button
                onClick={() => setCartOpen(false)}
                aria-label="Close cart"
                className="text-slate-400 text-2xl leading-none w-8 h-8"
              >
                ×
              </button>
            </div>

            <div className="overflow-y-auto flex-1">
              {cartItems.length === 0 ? (
                <p className="text-slate-400 text-lg p-5">Nothing added yet.</p>
              ) : (
                roundNumbers.map((r) => (
                  <div key={r} className="divide-y divide-gray-100">
                    <p className="text-xs font-bold uppercase text-slate-400 px-5 pt-4 pb-1">
                      {r === currentRound ? 'Current Round' : `Round ${r} — sent`}
                    </p>
                    {roundsMap[r].map((row) => (
                      <div key={row.id} className="flex items-center justify-between px-5 py-3 text-lg gap-3">
                        <span className="font-semibold text-slate-800">
                          {row.name}
                          {row.quantity > 1 && (
                            <span className="text-slate-400 font-normal"> × {row.quantity}</span>
                          )}
                        </span>
                        <div className="flex items-center gap-3">
                          <span className="text-slate-500">{row.total_price.toLocaleString()} RWF</span>
                          <button
                            onClick={() => removeItemFromTab(row.id, row.name)}
                            aria-label={`Remove ${row.name}`}
                            className="w-9 h-9 shrink-0 rounded-full bg-red-50 text-red-600 font-bold text-lg active:scale-95"
                          >
                            ×
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                ))
              )}
            </div>

            <div className="p-4 border-t border-gray-100 space-y-3">
              <button
                onClick={sendRound}
                disabled={!roundsMap[currentRound]?.length}
                className="w-full py-3 rounded-xl bg-slate-900 text-white font-bold disabled:opacity-40 active:scale-95"
              >
                Send Round {currentRound} to Kitchen/Bar
              </button>

              {/* Optional details — collapsed by default, no text input forced while serving */}
              <div>
                <button
                  onClick={() => setShowCustomerDetails((open) => !open)}
                  className="text-slate-500 font-semibold underline text-sm"
                >
                  {showCustomerDetails ? '− Hide' : '+ Add'} Customer Details (optional)
                </button>
                {showCustomerDetails && (
                  <div className="mt-3 grid grid-cols-1 sm:grid-cols-2 gap-3">
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
          </div>
        </div>
      )}

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
