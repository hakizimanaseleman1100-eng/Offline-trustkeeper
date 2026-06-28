import { useState, useEffect } from 'react';
import { db } from './db';
import { supabase } from './supabaseClient';
import POS from './POS';
import OwnerDashboard from './OwnerDashboard';
import { CURRENT_BUSINESS_ID } from './config';

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
    await db.inventory.clear();
    await db.inventory.bulkAdd(data);
  } catch (err) {
    console.error('Inventory down-sync failed:', err.message);
  }
}

function App() {
  const [currentUser, setCurrentUser] = useState(null);

  useEffect(() => {
    if (navigator.onLine) {
      syncInventory();
    }
  }, []);

  const logout = () => setCurrentUser(null);

  if (!currentUser) {
    return (
      <div className="min-h-screen bg-slate-900 flex flex-col items-center justify-center gap-6 font-sans px-6 py-12">
        <h1 className="text-4xl font-extrabold text-white tracking-tight mb-4 text-center">
          Sovereign Hospitality OS
        </h1>
        <div className="flex flex-wrap justify-center gap-6 w-full max-w-md">
          <button
            onClick={() => setCurrentUser({ role: 'WAITER' })}
            className="h-32 w-full sm:w-56 rounded-2xl text-2xl font-bold bg-amber-500 text-white shadow-lg transition active:scale-95"
          >
            Login as Waiter
          </button>
          <button
            onClick={() => setCurrentUser({ role: 'OWNER' })}
            className="h-32 w-full sm:w-56 rounded-2xl text-2xl font-bold bg-purple-600 text-white shadow-lg transition active:scale-95"
          >
            Login as Owner
          </button>
        </div>
      </div>
    );
  }

  if (currentUser.role === 'OWNER') {
    return <OwnerDashboard onLogout={logout} />;
  }

  return <POS onLogout={logout} />;
}

export default App;
