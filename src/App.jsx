import { useState, useEffect } from 'react';
import { db } from './db';
import { supabase } from './supabaseClient';
import POS from './POS';
import OwnerDashboard from './OwnerDashboard';
import KitchenDisplay from './KitchenDisplay';
import PinLogin from './PinLogin';
import BusinessAuth from './BusinessAuth';
import OwnerPinSetup from './OwnerPinSetup';
import { getBusinessId, currentSession, resolveBusinessId, ensureBusiness, signOutBusiness } from './session';
import { LEGACY_DEFAULT_OWNER_ID } from './auth';
import { allowedTabs, canSell, landingFor } from './permissions';

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

// Mirrors the staff list locally so PIN login works offline, and returns
// whether the venue has a usable OWNER account.
//
// NOTHING is seeded here. Older builds seeded a local "default owner" with a
// well-known PIN so the dashboard was never locked out — that was a backdoor
// into every venue's money screens, and it is gone: any stale seeded row is
// deleted below, and a venue with no OWNER is sent to OwnerPinSetup instead.
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

  // Kill the old default-PIN owner even on devices that are offline (where the
  // clear() above never ran). Deleting by its fixed id is enough — it only ever
  // existed locally, so no server row is affected.
  await db.staff.delete(LEGACY_DEFAULT_OWNER_ID);

  const owners = await db.staff
    .filter((s) => s.role === 'OWNER' && s.active !== false)
    .count();
  return owners > 0;
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

// Mirrors the venue's debts and their recoveries so the counter can take a
// repayment with no network. The customer who owes is rarely standing in front
// of the same phone that recorded the debt, so this is the whole venue's
// ledger, not just this device's.
//
// Rows still waiting in the outbox are preserved across the refresh: the server
// has not seen them yet, so a wholesale replace would erase money that was
// genuinely taken.
async function syncDebts() {
  try {
    const bid = getBusinessId();
    const [debtsRes, paysRes] = await Promise.all([
      supabase.from('debts').select('*').eq('business_id', bid).neq('status', 'void'),
      supabase.from('debt_payments').select('*').eq('business_id', bid),
    ]);
    if (debtsRes.error) throw debtsRes.error;
    if (paysRes.error) throw paysRes.error;

    const pendingDebts = await db.debts.where('synced_status').equals(0).toArray();
    const pendingPays = await db.debt_payments.where('synced_status').equals(0).toArray();

    // created_at is normalised to milliseconds: the POS writes Date.now() and
    // the server returns ISO, and one table cannot hold both and still sort.
    await db.debts.clear();
    await db.debts.bulkPut([
      ...(debtsRes.data ?? []).map((d) => ({
        ...d,
        created_at: new Date(d.created_at).getTime(),
        synced_status: 1,
      })),
      ...pendingDebts,
    ]);

    await db.debt_payments.clear();
    await db.debt_payments.bulkPut([
      ...(paysRes.data ?? []).map((p) => ({
        ...p,
        created_at: new Date(p.created_at).getTime(),
        synced_status: 1,
      })),
      ...pendingPays,
    ]);
  } catch (err) {
    // Offline: keep whatever is local. The counter can still take a repayment
    // against the debts it already knows about.
    console.error('Debts down-sync skipped:', err.message);
  }
}

// Mirrors the venue's Settings (name, address, TIN, MoMo pay number, receipt
// footer, loyalty rule) into local meta so the POS can print a complete receipt
// offline. Business-scoped; runs before login. Left untouched when offline.
async function syncBusiness() {
  try {
    const { data, error } = await supabase
      .from('businesses')
      .select('name, address, phone, email, tin, momo_code, receipt_footer, loyalty_threshold, loyalty_reward_pct, app_url')
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
  const [hasOwner, setHasOwner] = useState(true); // venue has a real OWNER PIN
  const [hasSession, setHasSession] = useState(false); // LIVE Supabase session (not just a cached business)
  // Which surface the signed-in staff member is looking at. Seeded from their
  // role at PIN login (landingFor), then theirs to change.
  const [view, setView] = useState('POS');

  // Down-syncs everything for the resolved business, then reveals the app.
  const bootstrap = async () => {
    if (navigator.onLine) {
      await syncInventory();
      await syncStations();
      await syncBusiness();
      await syncDebts();
    }
    setHasOwner(await syncStaff());
    setReady(true);
  };

  useEffect(() => {
    (async () => {
      const session = await currentSession();
      if (session) {
        // Attach to a business: existing profile, or create/adopt one.
        const bid = (await resolveBusinessId()) || (await ensureBusiness('My Venue'));
        void bid;
        setHasSession(true);
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

  // A fresh PIN login lands on that role's home surface.
  useEffect(() => {
    if (currentUser) setView(landingFor(currentUser.role));
  }, [currentUser]);

  // Called by BusinessAuth once the venue is signed in and its business resolved.
  const onVenueReady = async () => {
    setHasSession(true);
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
    setHasSession(false);
    setHasOwner(true); // re-evaluated by the next bootstrap
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

  // No owner account yet (fresh venue, or a device that carried the old default
  // owner): the venue must create its own PIN before anyone can get in.
  //
  // Creating it is a WRITE to `staff`, which migration 0013 grants to
  // `authenticated` only. A device can be "authed" here on nothing but a cached
  // business_id (see the bootstrap effect), and on that path the staff
  // down-sync silently failed too — so the local mirror may just be empty
  // rather than the venue genuinely having no owner. Send them to sign in
  // instead of to a setup screen whose insert would come back 42501.
  if (!hasOwner) {
    if (!hasSession) return <BusinessAuth onReady={onVenueReady} />;
    return (
      <OwnerPinSetup
        onCreated={(owner) => {
          setHasOwner(true);
          setCurrentUser(owner);
        }}
        onSignOutVenue={signOutVenue}
      />
    );
  }

  if (!currentUser) {
    return (
      <PinLogin
        onSuccess={setCurrentUser}
        onSignOutVenue={signOutVenue}
      />
    );
  }

  if (currentUser.role === 'KITCHEN') {
    return <KitchenDisplay currentUser={currentUser} onLogout={logout} />;
  }

  // Most roles need BOTH surfaces, so the app keeps one view state rather than
  // deciding once from the role. The barman sells all evening and reconciles at
  // the end of it; the owner does the reverse. They land on whichever is their
  // day's work (permissions.js) and switch when they need the other.
  const canSwitchToDashboard = allowedTabs(currentUser.role).length > 0;

  if (view === 'DASHBOARD' && canSwitchToDashboard) {
    return (
      <OwnerDashboard
        currentUser={currentUser}
        onLogout={logout}
        onOpenPos={canSell(currentUser.role) ? () => setView('POS') : null}
      />
    );
  }

  return (
    <POS
      currentUser={currentUser}
      onLogout={logout}
      onOpenDashboard={canSwitchToDashboard ? () => setView('DASHBOARD') : null}
    />
  );
}

export default App;
