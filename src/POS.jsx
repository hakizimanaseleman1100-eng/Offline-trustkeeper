import { useState } from 'react';
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
  const [showBill, setShowBill] = useState(false);

  const showToast = (message, duration = 2500) => {
    setToast(message);
    setTimeout(() => setToast(''), duration);
  };

  const openTabs = useLiveQuery(
    () => db.active_tabs.where('status').equals('open').reverse().sortBy('created_at'),
    [],
    []
  );

  // Per-tab running totals for the Home screen cards, keyed by tab_id.
  const tabTotals = useLiveQuery(
    async () => {
      const sales = await db.sales.toArray();
      return sales.reduce((acc, sale) => {
        acc[sale.tab_id] = (acc[sale.tab_id] ?? 0) + sale.total_price;
        return acc;
      }, {});
    },
    [],
    {}
  );

  // Lets staff see at a glance whether a sync is actually needed, instead of
  // tapping "Sync to Cloud" speculatively.
  const unsyncedCount = useLiveQuery(
    async () => {
      const paidTabIds = new Set(
        (await db.active_tabs.where('status').equals('paid').toArray()).map((tab) => tab.id)
      );
      const unsynced = (await db.sales.where('synced_status').equals(0).toArray()).filter((sale) =>
        paidTabIds.has(sale.tab_id)
      );
      return unsynced.length;
    },
    [],
    0
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

  // The customer-facing bill collapses lines for the same item across
  // rounds into one entry — the kitchen needs the round-by-round breakdown,
  // the customer just needs "what" and "how much".
  const billItems = Object.values(
    cartItems.reduce((acc, row) => {
      const key = row.item_id;
      if (!acc[key]) acc[key] = { item_id: key, name: row.name, quantity: 0, total_price: 0 };
      acc[key].quantity += row.quantity ?? 1;
      acc[key].total_price += row.total_price;
      return acc;
    }, {})
  );

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
    setShowBill(false);
  };

  // Quick-access from a tab card on the Home screen — jump straight into the
  // tab's cart or bill instead of opening the tab then hunting for the icon.
  const openTabWithCart = (id) => {
    setActiveTabId(id);
    setSelectedCategory('All');
    setSearchQuery('');
    setCartOpen(true);
  };

  const openTabWithBill = (id) => {
    setActiveTabId(id);
    setSelectedCategory('All');
    setSearchQuery('');
    setShowBill(true);
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
    showToast(`Removed ${itemName}`);
  };

  // Stepper for an existing cart line — derives unit price from the stored
  // total/quantity rather than re-reading inventory, so it still works if
  // the item's price has since changed.
  const changeQuantity = async (row, delta) => {
    const newQuantity = (row.quantity ?? 1) + delta;
    if (newQuantity <= 0) {
      await removeItemFromTab(row.id, row.name);
      return;
    }
    const unitPrice = row.total_price / (row.quantity ?? 1);
    await db.sales.update(row.id, {
      quantity: newQuantity,
      total_price: unitPrice * newQuantity,
    });
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
    closeTabView();
  };

  // Plain-text bill — used for both the share sheet and the clipboard fallback.
  const billText = () =>
    [
      activeTab?.name ?? 'Bill',
      ...billItems.map((row) => `${row.name} x${row.quantity} — ${row.total_price.toLocaleString()} RWF`),
      `Total: ${cartTotal.toLocaleString()} RWF`,
    ].join('\n');

  const escapeHtml = (s) =>
    String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // Prints just the bill, in its own window — printing the live app would
  // also capture the header, item grid, and bottom nav bar.
  const printBill = () => {
    const win = window.open('', '_blank', 'width=380,height=600');
    if (!win) {
      showToast('Allow pop-ups to print the bill');
      return;
    }
    const rows = billItems
      .map(
        (row) =>
          `<div class="row"><span>${escapeHtml(row.name)}${row.quantity > 1 ? ` x${row.quantity}` : ''}</span><span>${row.total_price.toLocaleString()} RWF</span></div>`
      )
      .join('');
    win.document.write(`<!doctype html><html><head><title>${escapeHtml(activeTab?.name ?? 'Bill')}</title>
      <style>
        body { font-family: monospace; padding: 16px; color: #111; }
        h2 { margin: 0 0 12px; }
        .row { display: flex; justify-content: space-between; gap: 12px; margin: 4px 0; }
        .total { border-top: 1px solid #111; margin-top: 10px; padding-top: 10px; font-weight: bold; }
      </style></head><body>
      <h2>${escapeHtml(activeTab?.name ?? 'Bill')}</h2>
      ${rows}
      <div class="row total"><span>Total</span><span>${cartTotal.toLocaleString()} RWF</span></div>
      </body></html>`);
    win.document.close();
    win.onload = () => {
      win.focus();
      win.print();
    };
    win.onafterprint = () => win.close();
  };

  const copyBillToClipboard = async (text) => {
    try {
      await navigator.clipboard.writeText(text);
      showToast('Bill copied to clipboard');
    } catch {
      showToast('Could not share or copy the bill');
    }
  };

  const shareBill = async () => {
    const text = billText();
    if (navigator.share) {
      try {
        await navigator.share({ title: activeTab?.name ?? 'Bill', text });
      } catch (err) {
        // AbortError just means the waiter closed the share sheet — anything
        // else (no share target, permission denied) should fall back.
        if (err?.name !== 'AbortError') await copyBillToClipboard(text);
      }
    } else {
      await copyBillToClipboard(text);
    }
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
    <div className="min-h-screen bg-gray-50 font-sans pb-20">
      {/* Header */}
      <header className="bg-slate-900 text-white px-3 sm:px-6 py-2 sm:py-3 flex flex-wrap gap-2 justify-between items-center shadow-lg">
        <h1 className="text-lg sm:text-2xl font-extrabold tracking-tight">Sovereign POS</h1>
        <div className="flex items-center gap-2 sm:gap-4">
          <div className="text-right">
            <div className="text-[10px] uppercase tracking-widest text-slate-400">Open Tabs</div>
            <div className="text-base sm:text-xl font-bold">{openTabs.length}</div>
          </div>
          <button
            onClick={syncData}
            disabled={syncing}
            aria-label="Sync to Cloud"
            className="relative px-2.5 sm:px-4 py-1.5 rounded-xl bg-emerald-600 font-semibold text-xs sm:text-sm transition active:scale-95 disabled:opacity-50"
          >
            <span className="sm:hidden">☁</span>
            <span className="hidden sm:inline">{syncing ? 'Syncing…' : '☁ Sync to Cloud'}</span>
            {!syncing && unsyncedCount > 0 && (
              <span className="absolute -top-1.5 -right-1.5 bg-red-500 text-white text-[10px] font-bold rounded-full w-5 h-5 flex items-center justify-center">
                {unsyncedCount}
              </span>
            )}
          </button>
          <button
            onClick={onLogout}
            aria-label="Logout"
            className="px-2.5 py-1.5 rounded-xl bg-slate-700 font-semibold text-xs sm:text-sm transition active:scale-95"
          >
            <span className="sm:hidden">⏏</span>
            <span className="hidden sm:inline">Logout</span>
          </button>
        </div>
      </header>

      <main className="p-3 sm:p-5 space-y-4 max-w-7xl mx-auto">
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
                    <div key={tab.id} className="relative">
                      <button
                        onClick={() => setActiveTabId(tab.id)}
                        className="h-20 sm:h-24 w-full rounded-2xl bg-white shadow-md transition active:scale-95 border-4 border-transparent text-slate-800 flex flex-col items-center justify-center gap-0.5"
                      >
                        <span className="text-lg sm:text-xl font-bold">{tab.name}</span>
                        <span className="text-xs font-semibold text-slate-400">
                          {(tabTotals[tab.id] ?? 0).toLocaleString()} RWF
                        </span>
                      </button>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          openTabWithCart(tab.id);
                        }}
                        aria-label={`Cart for ${tab.name}`}
                        className="absolute top-1.5 left-1.5 w-6 h-6 rounded-full bg-slate-900/80 text-white text-xs flex items-center justify-center active:scale-95"
                      >
                        🛒
                      </button>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          openTabWithBill(tab.id);
                        }}
                        aria-label={`Bill for ${tab.name}`}
                        className="absolute top-1.5 right-1.5 w-6 h-6 rounded-full bg-slate-900/80 text-white text-xs flex items-center justify-center active:scale-95"
                      >
                        🧾
                      </button>
                    </div>
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
          <div className="space-y-3">
            <div className="flex items-center justify-between gap-3">
              <button
                onClick={closeTabView}
                aria-label="Back to tabs"
                className="w-9 h-9 shrink-0 rounded-full bg-white shadow-md text-slate-600 text-lg flex items-center justify-center active:scale-95"
              >
                ←
              </button>
              <h2 className="text-lg font-extrabold text-slate-900 truncate text-center flex-1">{activeTab?.name}</h2>
              <span className="text-lg font-bold text-slate-800 shrink-0">{cartTotal.toLocaleString()} RWF</span>
              <button
                onClick={cancelTab}
                aria-label="Void tab"
                className="w-9 h-9 shrink-0 rounded-full text-slate-400 text-base flex items-center justify-center active:scale-95"
              >
                🗑️
              </button>
            </div>

            {categories.length === 0 ? (
              <p className="text-slate-400 text-lg">No inventory yet — connect to the internet to sync products.</p>
            ) : (
              <>
                {/* Search bar — items show immediately, no category routing step */}
                <div className="relative">
                  <input
                    type="text"
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    placeholder="Search items…"
                    className="w-full px-4 py-2 pr-9 rounded-xl border border-gray-300 text-sm shadow-sm"
                  />
                  {searchQuery && (
                    <button
                      onClick={() => setSearchQuery('')}
                      aria-label="Clear search"
                      className="absolute right-2 top-1/2 -translate-y-1/2 w-6 h-6 rounded-full text-slate-400 text-lg leading-none flex items-center justify-center active:scale-95"
                    >
                      ×
                    </button>
                  )}
                </div>

                {/* Category pills — horizontally scrolling, "All" prepended; fade
                    on the right hints there's more to scroll */}
                <div className="relative">
                  <div className="flex gap-1.5 overflow-x-auto pb-1 -mx-1 px-1">
                    {['All', ...categories].map((cat) => (
                      <button
                        key={cat}
                        onClick={() => setSelectedCategory(cat)}
                        className={`shrink-0 px-3.5 py-1.5 rounded-full font-semibold text-xs transition active:scale-95 ${
                          selectedCategory === cat ? 'bg-amber-500 text-white' : 'bg-white text-slate-600 shadow-sm'
                        }`}
                      >
                        {cat}
                      </button>
                    ))}
                  </div>
                  <div className="pointer-events-none absolute right-0 top-0 bottom-1 w-8 bg-gradient-to-l from-gray-50 to-transparent" />
                </div>

                {/* Item grid — tapping adds straight to the tab's cart */}
                {items.length === 0 ? (
                  <p className="text-slate-400 text-lg">No items match.</p>
                ) : (
                  <div className="grid grid-cols-3 sm:grid-cols-4 lg:grid-cols-6 gap-2 sm:gap-3">
                    {items.map((item) => (
                      <button
                        key={item.id}
                        onClick={() => addItemToTab(item)}
                        className="p-2.5 sm:p-3 rounded-xl text-sm sm:text-base font-bold bg-white shadow-md text-left transition active:scale-95 border-4 border-transparent"
                      >
                        <span className="block text-slate-900 leading-tight">{item.item_name}</span>
                        <span className="block text-xs sm:text-sm font-semibold text-slate-500 mt-1">
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

      {/* Bottom icon bar — Void lives up top next to the total, away from these
          two high-frequency buttons so it can't be mis-tapped in the same row */}
      {activeTabId !== null && (
        <footer className="fixed bottom-0 left-0 right-0 z-20 bg-white border-t border-gray-200 shadow-[0_-4px_12px_rgba(0,0,0,0.08)] grid grid-cols-2">
          <button
            onClick={() => setCartOpen(true)}
            className="h-16 flex flex-col items-center justify-center gap-0.5 text-slate-700 active:scale-95 relative"
          >
            <span className="text-2xl">🛒</span>
            <span className="text-xs font-semibold">Cart</span>
            {cartItemCount > 0 && (
              <span className="absolute top-1 right-1/3 bg-red-500 text-white text-xs font-bold rounded-full w-5 h-5 flex items-center justify-center">
                {cartItemCount}
              </span>
            )}
          </button>
          <button
            onClick={() => setShowBill(true)}
            className="h-16 flex flex-col items-center justify-center gap-0.5 text-slate-700 active:scale-95"
          >
            <span className="text-2xl">🧾</span>
            <span className="text-xs font-semibold">Bill</span>
          </button>
        </footer>
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
                      <div key={row.id} className="flex items-center justify-between px-5 py-3 gap-3">
                        <span className="font-semibold text-slate-800 text-base flex-1 min-w-0">{row.name}</span>
                        <div className="flex items-center gap-3 shrink-0">
                          {r === currentRound ? (
                            <div className="flex items-center gap-1 bg-slate-100 rounded-full px-1">
                              <button
                                onClick={() => changeQuantity(row, -1)}
                                aria-label={`Decrease ${row.name}`}
                                className="w-7 h-7 rounded-full font-bold text-slate-700 active:scale-95"
                              >
                                −
                              </button>
                              <span className="w-6 text-center font-semibold text-sm">{row.quantity ?? 1}</span>
                              <button
                                onClick={() => changeQuantity(row, 1)}
                                aria-label={`Increase ${row.name}`}
                                className="w-7 h-7 rounded-full font-bold text-slate-700 active:scale-95"
                              >
                                +
                              </button>
                            </div>
                          ) : (
                            // Already sent to kitchen/bar — quantity is locked, no silent edits after the fact.
                            <span className="text-sm text-slate-400 font-semibold px-2">x{row.quantity ?? 1}</span>
                          )}
                          <span className="text-slate-500 w-20 text-right text-sm">{row.total_price.toLocaleString()} RWF</span>
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

              <div className="grid grid-cols-2 gap-3 pt-1">
                <button
                  onClick={() => checkout('cash')}
                  disabled={cartItems.length === 0}
                  className="h-16 rounded-xl text-lg sm:text-xl font-bold bg-green-600 text-white transition active:scale-95 disabled:opacity-40"
                >
                  PAY CASH
                </button>
                <button
                  onClick={() => checkout('momo')}
                  disabled={cartItems.length === 0}
                  className="h-16 rounded-xl text-lg sm:text-xl font-bold bg-blue-600 text-white transition active:scale-95 disabled:opacity-40"
                >
                  MOMO
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Bill drawer — read-only itemized bill for printing/sharing with the customer */}
      {activeTabId !== null && showBill && (
        <div className="fixed inset-0 z-30 flex flex-col justify-end" onClick={() => setShowBill(false)}>
          <div className="absolute inset-0 bg-black/40" />
          <div
            onClick={(e) => e.stopPropagation()}
            className="relative bg-white rounded-t-3xl shadow-xl max-h-[75vh] flex flex-col"
          >
            <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100">
              <h3 className="text-xl font-extrabold text-slate-900">{activeTab?.name} — Bill</h3>
              <button
                onClick={() => setShowBill(false)}
                aria-label="Close bill"
                className="text-slate-400 text-2xl leading-none w-8 h-8"
              >
                ×
              </button>
            </div>

            <div className="overflow-y-auto flex-1 divide-y divide-gray-100">
              {billItems.length === 0 ? (
                <p className="text-slate-400 text-lg p-5">Nothing added yet.</p>
              ) : (
                billItems.map((row) => (
                  <div key={row.item_id} className="flex items-center justify-between px-5 py-3 text-lg gap-3">
                    <span className="font-semibold text-slate-800">
                      {row.name}
                      {row.quantity > 1 && <span className="text-slate-400 font-normal"> × {row.quantity}</span>}
                    </span>
                    <span className="text-slate-500">{row.total_price.toLocaleString()} RWF</span>
                  </div>
                ))
              )}
            </div>

            <div className="p-4 border-t border-gray-100 space-y-3">
              <div className="flex items-center justify-between text-xl font-bold text-slate-900 px-1">
                <span>Total</span>
                <span>{cartTotal.toLocaleString()} RWF</span>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <button
                  onClick={printBill}
                  className="h-12 rounded-xl bg-slate-900 text-white font-bold active:scale-95"
                >
                  🖨️ Print
                </button>
                <button
                  onClick={shareBill}
                  className="h-12 rounded-xl bg-white shadow-md font-bold text-slate-700 active:scale-95"
                >
                  📤 Share
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Toast */}
      {toast && (
        <div className="fixed bottom-24 left-1/2 -translate-x-1/2 bg-slate-900 text-white px-6 py-3 rounded-full shadow-xl text-lg z-10">
          {toast}
        </div>
      )}
    </div>
  );
}

export default POS;
