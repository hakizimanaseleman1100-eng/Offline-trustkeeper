import { useState, useEffect } from 'react';
import { db } from './db';
import { supabase } from './supabaseClient';
import POS from './POS';
import OwnerDashboard from './OwnerDashboard';
import KitchenDisplay from './KitchenDisplay';
import ClientOrder from './ClientOrder';
import PinLogin from './PinLogin';
import BusinessAuth from './BusinessAuth';
import { getBusinessId, currentSession, resolveBusinessId, ensureBusiness, signOutBusiness } from './session';
import { hashPin, DEFAULT_OWNER_ID, DEFAULT_OWNER_PIN } from './auth';

// Down-syncs the product catalog from Supabase into the local Dexie mirror.
// Inventory is fully server-owned now — this replaces the local copy wholesale
// rather than merging, so deletions/price changes on the server propagate too.
async function syncInventory() {
  try {
    const { data, error } = await supabase
      .from('products')
      .select('*')
      .eq('business_id', getBusinessId());
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

// Mirrors the staff list locally so PIN login works offline. Seeds a local-only
// default owner (PIN 1234) whenever there is NO real OWNER account yet — not
// just when the table is empty. That way adding a waiter first doesn't lock the
// business out of the dashboard; the default owner stays available until a real
// OWNER is created in the Team tab, at which point it stops being seeded.
async function syncStaff() {
  try {
    const { data, error } = await supabase
      .from('staff')
      .select('*')
      .eq('business_id', getBusinessId());
    if (error) throw error;
    // Only replace the local mirror when the fetch actually succeeded.
    await db.staff.clear();
    if (data?.length) await db.staff.bulkAdd(data);
  } catch (err) {
    // Offline (or the staff table doesn't exist yet): keep whatever's local.
    console.error('Staff down-sync skipped:', err.message);
  }

  const hasOwner = await db.staff
    .filter((s) => s.role === 'OWNER' && s.active !== false)
    .count();
  if (!hasOwner) {
    await db.staff.put({
      id: DEFAULT_OWNER_ID,
      business_id: getBusinessId(),
      name: 'Owner',
      pin_hash: await hashPin(DEFAULT_OWNER_PIN),
      role: 'OWNER',
      active: true,
    });
  }
}

// Mirrors stations and per-station stock so the POS can show/deduct the right
// station's stock offline. Business-scoped, so it runs before login. Replaces
// the local copies wholesale on a successful fetch; leaves them alone offline.
async function syncStations() {
  try {
    const [stationsRes, stockRes] = await Promise.all([
      supabase.from('stations').select('*').eq('business_id', getBusinessId()),
      supabase.from('station_stock').select('*').eq('business_id', getBusinessId()),
    ]);
    if (stationsRes.error) throw stationsRes.error;
    if (stockRes.error) throw stockRes.error;
    await db.stations.clear();
    if (stationsRes.data?.length) await db.stations.bulkAdd(stationsRes.data);
    await db.station_stock.clear();
    if (stockRes.data?.length) {
      // Normalise product_id to string to match how the POS looks it up.
      await db.station_stock.bulkAdd(
        stockRes.data.map((r) => ({ ...r, product_id: String(r.product_id) }))
      );
    }
  } catch (err) {
    console.error('Stations down-sync skipped:', err.message);
  }
}

// Mirrors the venue's Settings (name, address, TIN, MoMo pay number, receipt
// footer, loyalty rule) into local meta so the POS can print a complete receipt
// offline. Business-scoped; runs before login. Left untouched when offline.
async function syncBusiness() {
  try {
    const { data, error } = await supabase
      .from('businesses')
      .select('name, address, phone, email, tin, momo_code, receipt_footer, loyalty_threshold, loyalty_reward_pct')
      .eq('id', getBusinessId())
      .single();
    if (error) throw error;
    await db.meta.put({ key: 'business', value: data });
  } catch (err) {
    console.error('Business settings down-sync skipped:', err.message);
  }
}

function App() {
  const [currentUser, setCurrentUser] = useState(null);
  const [checking, setChecking] = useState(true); // resolving the venue session
  const [authed, setAuthed] = useState(false); // venue account signed in (or cached offline)
  const [ready, setReady] = useState(false); // local mirrors loaded

  // Down-syncs everything for the resolved business, then reveals the app.
  const bootstrap = async () => {
    if (navigator.onLine) {
      await syncInventory();
      await syncStations();
      await syncBusiness();
    }
    await syncStaff();
    setReady(true);
  };

  useEffect(() => {
    (async () => {
      const session = await currentSession();
      if (session) {
        // Attach to a business: existing profile, or create/adopt one.
        const bid = (await resolveBusinessId()) || (await ensureBusiness('My Venue'));
        void bid;
        setAuthed(true);
        await bootstrap();
      } else if (localStorage.getItem('business_id')) {
        // Returning device without a live session (e.g. offline) — keep working
        // with the last venue rather than forcing a re-login.
        setAuthed(true);
        await bootstrap();
      }
      setChecking(false);
    })();
  }, []);

  // Called by BusinessAuth once the venue is signed in and its business resolved.
  const onVenueReady = async () => {
    setAuthed(true);
    await bootstrap();
    setChecking(false);
  };

  const logout = () => setCurrentUser(null); // staff sign-out → PIN pad

  const signOutVenue = async () => {
    await signOutBusiness();
    setCurrentUser(null);
    setReady(false);
    setAuthed(false);
  };

  if (checking) {
    return <div className="min-h-screen bg-slate-900" />;
  }

  if (!authed) {
    return <BusinessAuth onReady={onVenueReady} />;
  }

  if (!ready) {
    return <div className="min-h-screen bg-slate-900" />;
  }

  if (!currentUser) {
    return (
      <PinLogin
        onSuccess={setCurrentUser}
        onSignOutVenue={signOutVenue}
        onSelfService={() => setCurrentUser({ role: 'CLIENT', name: 'Self-service' })}
      />
    );
  }

  if (currentUser.role === 'CLIENT') {
    return <ClientOrder onExit={logout} />;
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
