import { useState } from 'react';
import { db } from './db';
import { supabase } from './supabaseClient';
import { hashPin, pinProblem } from './auth';
import { getBusinessId } from './session';

// Forced owner-PIN creation. Shown whenever a venue has no active OWNER staff
// account — i.e. right after signup, and once on any device still carrying the
// old seeded "default owner". There is deliberately no way past this screen
// except creating a real PIN: the venue's money screens (Sales, Reconcile,
// Team, Settings) are behind it, so a shipped default PIN would be a backdoor
// into every venue's takings.
//
// The account is written to Supabase FIRST and mirrored locally after, because
// the server row is what every other device will sync. That makes this the one
// step of the app that legitimately requires network — a venue is online at
// signup anyway (Supabase Auth), and selling still never blocks on network.
function OwnerPinSetup({ onCreated }) {
  const [name, setName] = useState('');
  const [pin, setPin] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setError('');

    const problem = pinProblem(pin);
    if (problem) return setError(problem);
    if (pin !== confirm) return setError('The two PINs do not match');
    if (!navigator.onLine) {
      return setError('Connect to the internet once to create your owner PIN.');
    }

    setBusy(true);
    try {
      const pin_hash = await hashPin(pin);
      const { data, error: err } = await supabase
        .from('staff')
        .insert({
          business_id: getBusinessId(),
          name: name.trim() || 'Owner',
          role: 'OWNER',
          pin_hash,
          active: true,
        })
        .select()
        .single();

      if (err) {
        // The (business_id, pin_hash) unique index on active staff is the real
        // guard against two people sharing a PIN; surface it in plain words.
        setError(
          err.code === '23505'
            ? 'That PIN is already used by another staff member — pick another'
            : `Could not create the owner PIN: ${err.message}`
        );
        return;
      }

      await db.staff.put(data);
      onCreated(data);
    } catch (err) {
      setError(err.message ?? 'Something went wrong');
    } finally {
      setBusy(false);
    }
  };

  const digits = (v) => v.replace(/\D/g, '').slice(0, 4);

  return (
    <div className="min-h-screen bg-slate-900 flex flex-col items-center justify-center gap-6 font-sans px-6 py-12">
      <div className="text-center max-w-sm">
        <h1 className="text-3xl font-extrabold text-white tracking-tight">Create your owner PIN</h1>
        <p className="text-slate-400 mt-2 text-sm">
          This PIN opens your sales, debts and reconciliation screens. Only you should know it —
          staff get their own PINs in the Team tab.
        </p>
      </div>

      <form onSubmit={submit} className="w-full max-w-sm space-y-3">
        <input
          placeholder="Your name (e.g. Jean)"
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="w-full px-4 py-3 rounded-xl bg-slate-800 text-white placeholder-slate-500 border border-slate-700"
        />
        <input
          required
          inputMode="numeric"
          autoComplete="new-password"
          placeholder="4-digit PIN"
          value={pin}
          onChange={(e) => setPin(digits(e.target.value))}
          className="w-full px-4 py-3 rounded-xl bg-slate-800 text-white placeholder-slate-500 border border-slate-700 tracking-[0.5em] text-center text-xl"
        />
        <input
          required
          inputMode="numeric"
          autoComplete="new-password"
          placeholder="Repeat PIN"
          value={confirm}
          onChange={(e) => setConfirm(digits(e.target.value))}
          className="w-full px-4 py-3 rounded-xl bg-slate-800 text-white placeholder-slate-500 border border-slate-700 tracking-[0.5em] text-center text-xl"
        />

        {error && <p className="text-amber-300 text-sm">{error}</p>}

        <button
          type="submit"
          disabled={busy}
          className="w-full h-12 rounded-xl bg-amber-500 text-white font-bold active:scale-95 disabled:opacity-50"
        >
          {busy ? 'Saving…' : 'Save owner PIN'}
        </button>
      </form>

      <p className="text-slate-500 text-xs max-w-sm text-center">
        Write it down somewhere safe. If you forget it, a new owner PIN can only be created from the
        Team tab by someone already signed in.
      </p>
    </div>
  );
}

export default OwnerPinSetup;
