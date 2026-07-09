import { useState } from 'react';
import { signInBusiness, signUpBusiness, ensureBusiness, resolveBusinessId } from './session';

// The venue account gate: a business signs in once per device (staff then use
// PINs within it). Kept deliberately minimal — email, password, and a venue
// name on first signup.
function BusinessAuth({ onReady }) {
  const [mode, setMode] = useState('signup'); // 'signup' | 'signin'
  const [venue, setVenue] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      if (mode === 'signup') {
        const { data, error: err } = await signUpBusiness(email.trim(), password);
        if (err) {
          setError(err.message);
          return;
        }
        if (!data.session) {
          // Email confirmation is on for this project — no session yet.
          setError('Account created. Confirm your email, then sign in.');
          setMode('signin');
          return;
        }
        await ensureBusiness(venue.trim());
        await onReady();
      } else {
        const { error: err } = await signInBusiness(email.trim(), password);
        if (err) {
          setError(err.message);
          return;
        }
        // Attach to a business (existing profile, or adopt/create one).
        const bid = (await resolveBusinessId()) || (await ensureBusiness(venue.trim() || 'My Venue'));
        if (!bid) {
          setError('Signed in, but could not load your venue. Try again.');
          return;
        }
        await onReady();
      }
    } catch (err) {
      setError(err.message ?? 'Something went wrong');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="min-h-screen bg-slate-900 flex flex-col items-center justify-center gap-6 font-sans px-6 py-12">
      <div className="text-center">
        <h1 className="text-3xl font-extrabold text-white tracking-tight">Sovereign Hospitality OS</h1>
        <p className="text-slate-400 mt-1">{mode === 'signup' ? 'Create your venue account' : 'Sign in to your venue'}</p>
      </div>

      <form onSubmit={submit} className="w-full max-w-sm space-y-3">
        {mode === 'signup' && (
          <input
            required
            placeholder="Venue name (e.g. Sunset Bar)"
            value={venue}
            onChange={(e) => setVenue(e.target.value)}
            className="w-full px-4 py-3 rounded-xl bg-slate-800 text-white placeholder-slate-500 border border-slate-700"
          />
        )}
        <input
          required
          type="email"
          autoCapitalize="none"
          placeholder="Email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="w-full px-4 py-3 rounded-xl bg-slate-800 text-white placeholder-slate-500 border border-slate-700"
        />
        <input
          required
          type="password"
          placeholder="Password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="w-full px-4 py-3 rounded-xl bg-slate-800 text-white placeholder-slate-500 border border-slate-700"
        />

        {error && <p className="text-amber-300 text-sm">{error}</p>}

        <button
          type="submit"
          disabled={busy}
          className="w-full h-12 rounded-xl bg-amber-500 text-white font-bold active:scale-95 disabled:opacity-50"
        >
          {busy ? 'Please wait…' : mode === 'signup' ? 'Create account' : 'Sign in'}
        </button>
      </form>

      <button
        onClick={() => { setMode(mode === 'signup' ? 'signin' : 'signup'); setError(''); }}
        className="text-slate-400 text-sm font-semibold underline"
      >
        {mode === 'signup' ? 'Already have an account? Sign in' : 'New here? Create an account'}
      </button>
    </div>
  );
}

export default BusinessAuth;
