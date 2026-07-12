import { useState } from 'react';
import { db } from './db';
import { hashPin } from './auth';

// Full-screen PIN pad. Auto-verifies once 4 digits are entered — no separate
// "enter" tap. On success it hands the matched staff row back to the parent.
function PinLogin({ onSuccess, onSignOutVenue, onSelfService }) {
  const [pin, setPin] = useState('');
  const [error, setError] = useState('');
  const [checking, setChecking] = useState(false);

  const verify = async (candidate) => {
    setChecking(true);
    const hash = await hashPin(candidate);
    const match = await db.staff.where('pin_hash').equals(hash).first();
    if (match && match.active !== false) {
      onSuccess(match);
      return;
    }
    setError('Wrong PIN — try again');
    setPin('');
    setChecking(false);
  };

  const press = (digit) => {
    if (checking || pin.length >= 4) return;
    setError('');
    const next = pin + digit;
    setPin(next);
    if (next.length === 4) verify(next);
  };

  const backspace = () => {
    if (checking) return;
    setError('');
    setPin((p) => p.slice(0, -1));
  };

  return (
    <div className="min-h-screen bg-slate-900 flex flex-col items-center justify-center gap-8 font-sans px-6 py-12">
      <div className="text-center">
        <h1 className="text-3xl font-extrabold text-white tracking-tight">Sovereign Hospitality OS</h1>
        <p className="text-slate-400 mt-2">Enter your PIN</p>
      </div>

      {/* PIN dots */}
      <div className="flex gap-4 h-6 items-center">
        {[0, 1, 2, 3].map((i) => (
          <div
            key={i}
            className={`w-4 h-4 rounded-full transition ${
              i < pin.length ? 'bg-amber-500' : 'bg-slate-700'
            }`}
          />
        ))}
      </div>

      <div className="h-5 text-red-400 text-sm font-semibold">{error}</div>

      {/* Keypad */}
      <div className="grid grid-cols-3 gap-4">
        {[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => (
          <button
            key={n}
            onClick={() => press(String(n))}
            className="w-20 h-20 rounded-full bg-slate-800 text-white text-2xl font-bold active:scale-95 transition disabled:opacity-40"
            disabled={checking}
          >
            {n}
          </button>
        ))}
        <div />
        <button
          onClick={() => press('0')}
          className="w-20 h-20 rounded-full bg-slate-800 text-white text-2xl font-bold active:scale-95 transition disabled:opacity-40"
          disabled={checking}
        >
          0
        </button>
        <button
          onClick={backspace}
          aria-label="Delete"
          className="w-20 h-20 rounded-full text-slate-400 text-2xl active:scale-95 transition"
        >
          ⌫
        </button>
      </div>

      {onSelfService && (
        <button
          onClick={onSelfService}
          className="mt-2 px-6 py-3 rounded-2xl bg-slate-800 text-white font-bold active:scale-95"
        >
          🙋 Self-service — order here
        </button>
      )}

      {onSignOutVenue && (
        <button onClick={onSignOutVenue} className="text-slate-500 text-xs font-semibold underline mt-2">
          Sign out of venue
        </button>
      )}
    </div>
  );
}

export default PinLogin;
