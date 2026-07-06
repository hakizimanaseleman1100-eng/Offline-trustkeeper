import { useState, useEffect } from 'react';
import { supabase } from './supabaseClient';
import { CURRENT_BUSINESS_ID } from './config';

// Live kitchen/bar board. Shows "new" tickets sent from the POS and lets
// kitchen staff tap Done to clear them. Reached by logging in with a
// KITCHEN-role PIN.
function KitchenDisplay({ currentUser, onLogout }) {
  const [tickets, setTickets] = useState([]);

  useEffect(() => {
    let active = true;

    const load = async () => {
      const { data } = await supabase
        .from('kitchen_tickets')
        .select('*')
        .eq('business_id', CURRENT_BUSINESS_ID)
        .eq('status', 'new')
        .order('created_at');
      if (active) setTickets(data ?? []);
    };
    load();

    // Live updates — new tickets appear, done ones drop off, without a refresh.
    const channel = supabase
      .channel('kitchen_tickets')
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'kitchen_tickets', filter: `business_id=eq.${CURRENT_BUSINESS_ID}` },
        () => load()
      )
      .subscribe();

    return () => {
      active = false;
      supabase.removeChannel(channel);
    };
  }, []);

  const markDone = async (id) => {
    // Optimistic — the row vanishes immediately, realtime confirms.
    setTickets((list) => list.filter((t) => t.id !== id));
    await supabase.from('kitchen_tickets').update({ status: 'done' }).eq('id', id);
  };

  return (
    <div className="min-h-screen bg-slate-900 text-white font-sans">
      <header className="px-4 sm:px-6 py-3 flex justify-between items-center border-b border-slate-800">
        <div>
          <h1 className="text-xl sm:text-2xl font-extrabold tracking-tight">Kitchen / Bar</h1>
          {currentUser?.name && <p className="text-[11px] text-slate-400">Signed in as {currentUser.name}</p>}
        </div>
        <button
          onClick={onLogout}
          className="px-3 py-1.5 rounded-lg bg-slate-700 text-sm font-semibold active:scale-95"
        >
          Logout
        </button>
      </header>

      {tickets.length === 0 ? (
        <p className="text-slate-400 text-lg text-center mt-24">No pending orders. All caught up. 🎉</p>
      ) : (
        <div className="p-4 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
          {tickets.map((t) => (
            <div key={t.id} className="bg-slate-800 rounded-2xl p-4 flex flex-col">
              <div className="flex items-center justify-between mb-2">
                <span className="font-bold text-lg">{t.tab_name ?? 'Tab'}</span>
                <span className="text-xs text-slate-400">Round {t.round}</span>
              </div>
              <ul className="flex-1 space-y-1 mb-3">
                {(t.items ?? []).map((it, i) => (
                  <li key={i} className="flex justify-between text-slate-100">
                    <span>{it.name}</span>
                    <span className="text-slate-400">× {it.quantity}</span>
                  </li>
                ))}
              </ul>
              <button
                onClick={() => markDone(t.id)}
                className="w-full py-3 rounded-xl bg-emerald-600 font-bold active:scale-95"
              >
                ✓ Done
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default KitchenDisplay;
