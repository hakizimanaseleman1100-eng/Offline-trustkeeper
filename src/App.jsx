import { useState, useEffect } from 'react';
import { db } from './db';
import { supabase } from './supabaseClient';
import POS from './POS';
import OwnerDashboard from './OwnerDashboard';
import KitchenDisplay from './KitchenDisplay';
import PinLogin from './PinLogin';
import { CURRENT_BUSINESS_ID } from './config';
import { hashPin, DEFAULT_OWNER_ID, DEFAULT_OWNER_PIN } from './auth';

// Down-syncs the product catalog from Supabase into the local Dexie mirror.
// Inventory is fully server-owned now — this replaces the local copy wholesale
// rather than merging, so deletions/price changes on the server propagate too.
async function syncInventory() {
  try {
    const { data, error } = await supabase
      .from('products')
      .select('*')
      .eq('business_id', CURRENT_BUSINESS_ID);
    if (error) throw error;
    // Hide soft-deleted products from the POS. Filtered client-side (rather
    // than .eq('active', true)) so it still works before migration 0003 adds
    // the column — rows without the field are treated as active.
    const activeProducts = data.filter((p) => p.active !== false);
    await db.inventory.clear();
    await db.inventory.bulkAdd(activeProducts);
  } catch (err) {
    console.error('Inventory down-sync failed:', err.message);
  }
}

// Mirrors the staff list locally so PIN login works offline. If no staff exist
// anywhere (server empty AND nothing local — i.e. a fresh first run), seeds a
// local-only default owner so the app is still usable; the owner then creates
// real accounts from the Team tab, which sync down and replace this default.
async function syncStaff() {
  try {
    const { data, error } = await supabase
      .from('staff')
      .select('*')
      .eq('business_id', CURRENT_BUSINESS_ID);
    if (error) throw error;
    // Only replace the local mirror when the fetch actually succeeded.
    await db.staff.clear();
    if (data?.length) await db.staff.bulkAdd(data);
  } catch (err) {
    // Offline (or the staff table doesn't exist yet): keep whatever's local.
    console.error('Staff down-sync skipped:', err.message);
  }

  if ((await db.staff.count()) === 0) {
    await db.staff.put({
      id: DEFAULT_OWNER_ID,
      business_id: CURRENT_BUSINESS_ID,
      name: 'Owner',
      pin_hash: await hashPin(DEFAULT_OWNER_PIN),
      role: 'OWNER',
      active: true,
    });
  }
}

function App() {
  const [currentUser, setCurrentUser] = useState(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    (async () => {
      if (navigator.onLine) await syncInventory();
      await syncStaff();
      setReady(true);
    })();
  }, []);

  const logout = () => setCurrentUser(null);

  if (!ready) {
    return <div className="min-h-screen bg-slate-900" />;
  }

  if (!currentUser) {
    return <PinLogin onSuccess={setCurrentUser} />;
  }

  if (currentUser.role === 'OWNER' || currentUser.role === 'MANAGER') {
    return <OwnerDashboard currentUser={currentUser} onLogout={logout} />;
  }

  if (currentUser.role === 'KITCHEN') {
    return <KitchenDisplay currentUser={currentUser} onLogout={logout} />;
  }

  return <POS currentUser={currentUser} onLogout={logout} />;
}

export default App;
