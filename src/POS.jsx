import { useState, useEffect, useRef } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from './db';
import { supabase } from './supabaseClient';
import { CURRENT_BUSINESS_ID } from './config';
import { getDeviceId, nextReceiptNo } from './receipts';

// "5m ago" style label for the last successful sync.
function relativeTime(ms) {
  if (!ms) return null;
  const secs = Math.round((Date.now() - ms) / 1000);
  if (secs < 60) return 'just now';
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}

function POS({ currentUser, onLogout }) {
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
  // When MOMO is tapped we first ask for the transaction reference before
  // closing the tab, so the owner can reconcile against the MTN dashboard.
  const [momoPrompt, setMomoPrompt] = useState(false);
  const [momoRef, setMomoRef] = useState('');
  const [lastSyncAt, setLastSyncAt] = useState(null);

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

  // Tax breakdown for the receipt. Rwandan EBM prices are tax-INCLUSIVE, so the
  // VAT already sits inside total_price: tax = total * rate / (100 + rate).
  // Grouped by tax label (A/B/C…) as EBM receipts require.
  const taxSummary = Object.values(
    cartItems.reduce((acc, row) => {
      const rate = row.tax_rate ?? 0;
      if (!rate) return acc;
      const label = row.tax_label ?? '—';
      const key = `${label}:${rate}`;
      acc[key] ||= { label, rate, amount: 0 };
      acc[key].amount += (row.total_price * rate) / (100 + rate);
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
    setMomoPrompt(false);
    setMomoRef('');
  };

  // Quick-access from a tab card on the Home screen — jump straight into the
  // tab's cart or bill instead of opening the tab then hunting for the icon.
  const openTabWithCart = (id) => {
    setActiveTabId(id);
    setSelectedCategory('All');
    setSearchQuery('');
    setCartOpen(true);
  };

  // A receipt number is the fiscal reference for a bill. Assigned once, the
  // first time a bill is shown or paid, and stored on the tab so re-opening or
  // re-printing shows the same number (idempotent). Voided-before-billing tabs
  // never consume a number.
  const ensureReceiptNo = async (tabId) => {
    const tab = await db.active_tabs.get(tabId);
    if (tab?.receipt_no) return tab.receipt_no;
    const receipt_no = await nextReceiptNo();
    await db.active_tabs.update(tabId, { receipt_no });
    return receipt_no;
  };

  const openTabWithBill = (id) => {
    setActiveTabId(id);
    setSelectedCategory('All');
    setSearchQuery('');
    setShowBill(true);
    ensureReceiptNo(id);
  };

  const logAudit = (actionType, details) =>
    db.audit_logs.add({
      action_type: actionType,
      details,
      staff_id: currentUser?.id ?? null,
      staff_name: currentUser?.name ?? null,
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
      // Whoever added the line owns it — snapshotted so reports/accountability
      // survive the staff member later being renamed or deactivated.
      staff_id: currentUser?.id ?? null,
      staff_name: currentUser?.name ?? null,
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
      ...(activeTab?.receipt_no ? [`Receipt ${activeTab.receipt_no}`] : []),
      ...billItems.map((row) => `${row.name} x${row.quantity} — ${row.total_price.toLocaleString()} RWF`),
      `Total: ${cartTotal.toLocaleString()} RWF`,
      ...taxSummary.map((t) => `VAT ${t.label} (${t.rate}%) incl.: ${Math.round(t.amount).toLocaleString()} RWF`),
    ].join('\n');

  // Prints in-place using a hidden, print-only section of the page (see the
  // `print:hidden` / `print:block` split at the bottom of the JSX) instead of
  // a popup window — popups opened via window.open() are routinely blocked
  // on mobile browsers, which made the old approach silently do nothing on
  // real Android phones.
  const printBill = () => window.print();

  // Opens the SMS compose screen directly with the bill pre-filled.
  // More reliable than navigator.share for SMS because the Messages app
  // on Android registers for sms: URIs, not generic text/plain share intents.
  const smsBill = () => {
    window.open('sms:?body=' + encodeURIComponent(billText()));
  };

  const copyBillToClipboard = async (text) => {
    try {
      if (!navigator.clipboard) throw new Error('Clipboard API unavailable');
      await navigator.clipboard.writeText(text);
      showToast('Bill copied to clipboard');
    } catch (err) {
      console.error('Clipboard copy failed:', err);
      showToast('Could not share or copy the bill');
    }
  };

  const shareBill = async () => {
    const text = billText();
    const shareData = { title: activeTab?.name ?? 'Bill', text };
    // canShare (where supported) catches data the platform will reject
    // before we even try — e.g. some Android share targets need text only.
    const shareSupported = navigator.share && (!navigator.canShare || navigator.canShare(shareData));
    if (shareSupported) {
      try {
        await navigator.share(shareData);
      } catch (err) {
        // AbortError just means the waiter closed the share sheet — anything
        // else (no share target, permission denied) should fall back.
        if (err?.name !== 'AbortError') {
          console.error('navigator.share failed:', err);
          await copyBillToClipboard(text);
        }
      }
    } else {
      await copyBillToClipboard(text);
    }
  };

  const checkout = async (paymentMethod, momoRef = null) => {
    if (cartItems.length === 0) return;
    try {
      // Stamp the fiscal reference + issuing device on every line, so the
      // permanent sale record carries the same receipt number the customer got.
      const receipt_no = await ensureReceiptNo(activeTabId);
      const device_id = await getDeviceId();
      await db.sales.bulkUpdate(
        cartItems.map((row) => ({
          key: row.id,
          changes: {
            payment_method: paymentMethod,
            customer_tin: customerTin || null,
            customer_phone: customerPhone || null,
            momo_ref: momoRef || null,
            receipt_no,
            device_id,
          },
        }))
      );
      await db.active_tabs.update(activeTabId, { status: 'paid' });
      showToast(`${activeTab?.name ?? 'Tab'} closed — ${receipt_no}`);
      closeTabView();
      // Push the just-closed sale straight away if we're online; harmless if
      // offline (it stays queued for the next sync).
      syncDataRef.current?.({ silent: true });
    } catch (err) {
      console.error('Failed to close tab:', err);
      showToast('Error: could not close tab');
    }
  };

  // silent=true for automatic (online-event) runs so they don't spam toasts.
  const syncData = async ({ silent = false } = {}) => {
    if (!navigator.onLine) {
      if (!silent) showToast('Offline — will sync when connected');
      return;
    }
    setSyncing(true);
    try {
      const paidTabIds = new Set(
        (await db.active_tabs.where('status').equals('paid').toArray()).map((tab) => tab.id)
      );
      const unsynced = (await db.sales.where('synced_status').equals(0).toArray()).filter((sale) =>
        paidTabIds.has(sale.tab_id)
      );

      if (unsynced.length === 0) {
        if (!silent) showToast('Sync Complete: 0 records uploaded');
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
          staff_id: sale.staff_id ?? null,
          staff_name: sale.staff_name ?? null,
          receipt_no: sale.receipt_no ?? null,
          device_id: sale.device_id ?? null,
          momo_ref: sale.momo_ref ?? null,
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
            staff_id: log.staff_id ?? null,
            staff_name: log.staff_name ?? null,
            timestamp: new Date(log.timestamp).toISOString(),
          }))
        );
        if (auditError) throw auditError;

        await db.audit_logs.bulkUpdate(
          unsyncedLogs.map((log) => ({ key: log.id, changes: { synced_status: 1 } }))
        );
      }

      await db.meta.put({ key: 'last_sync_at', value: Date.now() });
      setLastSyncAt(Date.now());
      showToast(`Sync Complete: ${unsynced.length} records uploaded`);
    } catch (err) {
      console.error('Sync failed:', err.message, err.details, err.hint, err.code);
      if (!silent) showToast('Sync failed — will retry later');
    } finally {
      setSyncing(false);
    }
  };

  // Keep a ref to the latest syncData so the mount-only effect below always
  // calls the current closure without re-subscribing every render.
  const syncDataRef = useRef(syncData);
  syncDataRef.current = syncData;

  useEffect(() => {
    db.meta.get('last_sync_at').then((row) => row?.value && setLastSyncAt(row.value));
    const autoSync = () => syncDataRef.current({ silent: true });
    window.addEventListener('online', autoSync);
    if (navigator.onLine) autoSync(); // opportunistic catch-up on open
    return () => window.removeEventListener('online', autoSync);
  }, []);

  return (
    <>
    <div className="min-h-screen bg-gray-50 font-sans pb-20 print:hidden">
      {/* Header */}
      <header className="bg-slate-900 text-white px-3 sm:px-6 lg:px-10 py-2 sm:py-3 lg:py-4 flex flex-wrap gap-2 justify-between items-center shadow-lg">
        <div className="min-w-0">
          <h1 className="text-lg sm:text-2xl lg:text-3xl font-extrabold tracking-tight">Sovereign POS</h1>
          {currentUser?.name && (
            <p className="text-[10px] lg:text-xs text-slate-400 truncate">Signed in as {currentUser.name}</p>
          )}
        </div>
        <div className="flex items-center gap-2 sm:gap-4 lg:gap-6">
          <div className="text-right">
            <div className="text-[10px] lg:text-xs uppercase tracking-widest text-slate-400">Open Tabs</div>
            <div className="text-base sm:text-xl lg:text-2xl font-bold">{openTabs.length}</div>
          </div>
          <button
            onClick={() => syncData()}
            disabled={syncing}
            aria-label="Sync to Cloud"
            className="relative px-2.5 sm:px-4 lg:px-5 py-1.5 lg:py-2.5 rounded-xl bg-emerald-600 font-semibold text-xs sm:text-sm lg:text-base transition active:scale-95 disabled:opacity-50"
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
            className="px-2.5 py-1.5 lg:px-5 lg:py-2.5 rounded-xl bg-slate-700 font-semibold text-xs sm:text-sm lg:text-base transition active:scale-95"
          >
            <span className="sm:hidden">⏏</span>
            <span className="hidden sm:inline">Logout</span>
          </button>
        </div>
      </header>

      {/* Sync status strip — only shows when there's something to say, so it
          stays out of the way. Reassures staff their sales are safely uploaded
          (and warns the owner when they aren't yet). */}
      {(unsyncedCount > 0 || lastSyncAt) && (
        <div className="bg-slate-800 text-slate-300 text-[11px] lg:text-xs px-3 sm:px-6 lg:px-10 py-1 flex justify-between items-center gap-3">
          <span className={unsyncedCount > 0 ? 'text-amber-300 font-semibold' : ''}>
            {unsyncedCount > 0
              ? `${unsyncedCount} sale${unsyncedCount > 1 ? 's' : ''} pending upload`
              : 'All sales uploaded'}
          </span>
          {lastSyncAt && <span>Last synced {relativeTime(lastSyncAt)}</span>}
        </div>
      )}

      <main className="p-3 sm:p-5 lg:p-8 space-y-4 lg:space-y-6 max-w-7xl mx-auto">
        {activeTabId === null ? (
          /* HOME: split screen — active tabs grid (left) + create tab (right), stacked on mobile */
          <div className="flex flex-col sm:grid sm:grid-cols-3 gap-5 lg:gap-8">
            <div className="sm:col-span-2">
              <p className="text-slate-500 font-semibold mb-4 text-lg lg:text-xl">Active Tabs</p>
              {openTabs.length === 0 ? (
                <p className="text-slate-400 text-lg">No open tabs. Create one to start an order.</p>
              ) : (
                <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4 lg:gap-5">
                  {openTabs.map((tab) => (
                    <div key={tab.id} className="relative">
                      <button
                        onClick={() => setActiveTabId(tab.id)}
                        className="h-20 sm:h-24 lg:h-28 w-full rounded-2xl bg-white shadow-md transition active:scale-95 border-4 border-transparent text-slate-800 flex flex-col items-center justify-center gap-0.5"
                      >
                        <span className="text-lg sm:text-xl lg:text-2xl font-bold">{tab.name}</span>
                        <span className="text-xs lg:text-sm font-semibold text-slate-400">
                          {(tabTotals[tab.id] ?? 0).toLocaleString()} RWF
                        </span>
                      </button>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          openTabWithCart(tab.id);
                        }}
                        aria-label={`Cart for ${tab.name}`}
                        className="absolute top-1.5 left-1.5 w-6 h-6 lg:w-8 lg:h-8 rounded-full bg-slate-900/80 text-white text-xs lg:text-sm flex items-center justify-center active:scale-95"
                      >
                        🛒
                      </button>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          openTabWithBill(tab.id);
                        }}
                        aria-label={`Bill for ${tab.name}`}
                        className="absolute top-1.5 right-1.5 w-6 h-6 lg:w-8 lg:h-8 rounded-full bg-slate-900/80 text-white text-xs lg:text-sm flex items-center justify-center active:scale-95"
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
              className="h-20 sm:h-24 lg:h-28 rounded-2xl text-xl sm:text-2xl lg:text-3xl font-bold bg-amber-500 text-white shadow-md transition active:scale-95"
            >
              + New Tab
            </button>
          </div>
        ) : (
          /* INSIDE A TAB: category → items → running cart */
          <div className="space-y-3 lg:space-y-4">
            <div className="flex items-center justify-between gap-3">
              <button
                onClick={closeTabView}
                aria-label="Back to tabs"
                className="w-9 h-9 lg:w-11 lg:h-11 shrink-0 rounded-full bg-white shadow-md text-slate-600 text-lg lg:text-xl flex items-center justify-center active:scale-95"
              >
                ←
              </button>
              <h2 className="text-lg lg:text-2xl font-extrabold text-slate-900 truncate text-center flex-1">{activeTab?.name}</h2>
              <span className="text-lg lg:text-2xl font-bold text-slate-800 shrink-0">{cartTotal.toLocaleString()} RWF</span>
              <button
                onClick={cancelTab}
                aria-label="Void tab"
                className="w-9 h-9 lg:w-11 lg:h-11 shrink-0 rounded-full text-slate-400 text-base lg:text-lg flex items-center justify-center active:scale-95"
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
                    className="w-full px-4 lg:px-5 py-2 lg:py-3 pr-9 rounded-xl border border-gray-300 text-sm lg:text-base shadow-sm"
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
                        className={`shrink-0 px-3.5 lg:px-5 py-1.5 lg:py-2 rounded-full font-semibold text-xs lg:text-sm transition active:scale-95 ${
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
                  <div className="grid grid-cols-3 sm:grid-cols-4 lg:grid-cols-6 xl:grid-cols-7 gap-2 sm:gap-3 lg:gap-4">
                    {items.map((item) => (
                      <button
                        key={item.id}
                        onClick={() => addItemToTab(item)}
                        className="p-2.5 sm:p-3 lg:p-4 rounded-xl text-sm sm:text-base lg:text-lg font-bold bg-white shadow-md text-left transition active:scale-95 border-4 border-transparent"
                      >
                        <span className="block text-slate-900 leading-tight">{item.item_name}</span>
                        <span className="block text-xs sm:text-sm lg:text-base font-semibold text-slate-500 mt-1">
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
        <footer className="fixed bottom-0 left-0 right-0 z-20 bg-white border-t border-gray-200 shadow-[0_-4px_12px_rgba(0,0,0,0.08)] grid grid-cols-2 max-w-7xl mx-auto">
          <button
            onClick={() => setCartOpen(true)}
            className="h-16 lg:h-20 flex flex-col items-center justify-center gap-0.5 text-slate-700 active:scale-95 relative"
          >
            <span className="text-2xl lg:text-3xl">🛒</span>
            <span className="text-xs lg:text-sm font-semibold">Cart</span>
            {cartItemCount > 0 && (
              <span className="absolute top-1 right-1/3 bg-red-500 text-white text-xs font-bold rounded-full w-5 h-5 flex items-center justify-center">
                {cartItemCount}
              </span>
            )}
          </button>
          <button
            onClick={() => {
              setShowBill(true);
              ensureReceiptNo(activeTabId);
            }}
            className="h-16 lg:h-20 flex flex-col items-center justify-center gap-0.5 text-slate-700 active:scale-95"
          >
            <span className="text-2xl lg:text-3xl">🧾</span>
            <span className="text-xs lg:text-sm font-semibold">Bill</span>
          </button>
        </footer>
      )}

      {/* Cart drawer — replaces the old inline list; grouped by round */}
      {activeTabId !== null && cartOpen && (
        <div
          className="fixed inset-0 z-30 flex flex-col justify-end lg:items-center lg:justify-center"
          onClick={() => setCartOpen(false)}
        >
          <div className="absolute inset-0 bg-black/40" />
          <div
            onClick={(e) => e.stopPropagation()}
            className="relative bg-white rounded-t-3xl lg:rounded-3xl shadow-xl max-h-[75vh] lg:max-h-[85vh] w-full lg:max-w-lg flex flex-col"
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
              {/* Send Round and Customer Details as a pair of icon buttons —
                  a full-width "Send Round" button here used to dominate the
                  drawer and crowd the cart list above it. */}
              <div className="flex items-center gap-4">
                <button
                  onClick={sendRound}
                  disabled={!roundsMap[currentRound]?.length}
                  aria-label={`Send Round ${currentRound} to Kitchen/Bar`}
                  className="flex flex-col items-center gap-0.5 disabled:opacity-40 active:scale-95"
                >
                  <span className="w-11 h-11 rounded-full bg-slate-900 text-white flex items-center justify-center text-lg">
                    📨
                  </span>
                  <span className="text-[10px] font-semibold text-slate-500">Send Round {currentRound}</span>
                </button>
                <button
                  onClick={() => setShowCustomerDetails((open) => !open)}
                  aria-label="Customer details"
                  className="flex flex-col items-center gap-0.5 active:scale-95"
                >
                  <span
                    className={`w-11 h-11 rounded-full flex items-center justify-center text-lg ${
                      showCustomerDetails ? 'bg-amber-500 text-white' : 'bg-slate-100 text-slate-600'
                    }`}
                  >
                    🚩
                  </span>
                  <span className="text-[10px] font-semibold text-slate-500">Details</span>
                </button>
              </div>

              {showCustomerDetails && (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
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

              {momoPrompt ? (
                /* MoMo two-step: capture the transaction reference, then close.
                   The ref is optional — "Skip" still records the MoMo payment. */
                <div className="space-y-3 pt-1">
                  <input
                    type="text"
                    autoFocus
                    placeholder="MoMo transaction ref (e.g. AE1234567)"
                    value={momoRef}
                    onChange={(e) => setMomoRef(e.target.value)}
                    className="w-full px-4 py-3 rounded-xl border border-gray-300 text-lg"
                  />
                  <div className="grid grid-cols-2 gap-3">
                    <button
                      onClick={() => setMomoPrompt(false)}
                      className="h-14 rounded-xl font-bold bg-slate-100 text-slate-600 active:scale-95"
                    >
                      ← Back
                    </button>
                    <button
                      onClick={() => checkout('momo', momoRef)}
                      className="h-14 rounded-xl font-bold bg-yellow-400 text-slate-900 active:scale-95"
                    >
                      {momoRef ? 'Confirm MoMo' : 'Skip & Close'}
                    </button>
                  </div>
                </div>
              ) : (
                <div className="grid grid-cols-2 gap-3 pt-1">
                  <button
                    onClick={() => checkout('cash')}
                    disabled={cartItems.length === 0}
                    className="h-16 rounded-xl text-lg sm:text-xl font-bold bg-green-600 text-white transition active:scale-95 disabled:opacity-40"
                  >
                    PAY CASH
                  </button>
                  <button
                    onClick={() => setMomoPrompt(true)}
                    disabled={cartItems.length === 0}
                    className="h-16 rounded-xl text-lg sm:text-xl font-bold bg-yellow-400 text-slate-900 transition active:scale-95 disabled:opacity-40"
                  >
                    MOMO
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Bill drawer — read-only itemized bill for printing/sharing with the customer */}
      {activeTabId !== null && showBill && (
        <div
          className="fixed inset-0 z-30 flex flex-col justify-end lg:items-center lg:justify-center"
          onClick={() => setShowBill(false)}
        >
          <div className="absolute inset-0 bg-black/40" />
          <div
            onClick={(e) => e.stopPropagation()}
            className="relative bg-white rounded-t-3xl lg:rounded-3xl shadow-xl max-h-[75vh] lg:max-h-[85vh] w-full lg:max-w-lg flex flex-col"
          >
            <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100">
              <div className="min-w-0">
                <h3 className="text-xl font-extrabold text-slate-900 truncate">{activeTab?.name} — Bill</h3>
                {activeTab?.receipt_no && (
                  <p className="text-xs font-semibold text-slate-400">Receipt {activeTab.receipt_no}</p>
                )}
              </div>
              <button
                onClick={() => setShowBill(false)}
                aria-label="Close bill"
                className="text-slate-400 text-2xl leading-none w-8 h-8 shrink-0"
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
              {taxSummary.map((t) => (
                <div key={`${t.label}-${t.rate}`} className="flex items-center justify-between text-sm text-slate-500 px-1">
                  <span>VAT {t.label} ({t.rate}%) incl.</span>
                  <span>{Math.round(t.amount).toLocaleString()} RWF</span>
                </div>
              ))}
              <div className="flex items-center justify-between text-xl font-bold text-slate-900 px-1">
                <span>Total</span>
                <span>{cartTotal.toLocaleString()} RWF</span>
              </div>
              <div className="grid grid-cols-3 gap-2">
                <button
                  onClick={printBill}
                  className="h-12 rounded-xl bg-slate-900 text-white font-bold text-sm active:scale-95"
                >
                  🖨️ Print
                </button>
                <button
                  onClick={smsBill}
                  className="h-12 rounded-xl bg-green-600 text-white font-bold text-sm active:scale-95"
                >
                  💬 SMS
                </button>
                <button
                  onClick={shareBill}
                  className="h-12 rounded-xl bg-white shadow-md font-bold text-slate-700 text-sm active:scale-95"
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

    {/* Print-only bill — invisible on screen, shown only by window.print().
        Lives outside the print:hidden tree above so it isn't hidden along
        with everything else when the page is printed. */}
    {activeTabId !== null && (
      <div className="hidden print:block p-6 font-mono text-black">
        <h2 className="text-lg font-bold">{activeTab?.name ?? 'Bill'}</h2>
        {activeTab?.receipt_no && <p className="text-sm mb-3">Receipt {activeTab.receipt_no}</p>}
        {billItems.map((row) => (
          <div key={row.item_id} className="flex justify-between text-sm py-0.5">
            <span>
              {row.name}
              {row.quantity > 1 ? ` x${row.quantity}` : ''}
            </span>
            <span>{row.total_price.toLocaleString()} RWF</span>
          </div>
        ))}
        <div className="flex justify-between border-t border-black mt-2 pt-2 font-bold">
          <span>Total</span>
          <span>{cartTotal.toLocaleString()} RWF</span>
        </div>
        {taxSummary.map((t) => (
          <div key={`${t.label}-${t.rate}`} className="flex justify-between text-xs mt-0.5">
            <span>VAT {t.label} ({t.rate}%) incl.</span>
            <span>{Math.round(t.amount).toLocaleString()} RWF</span>
          </div>
        ))}
      </div>
    )}
    </>
  );
}

export default POS;
