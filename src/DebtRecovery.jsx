import { useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from './db';
import { enqueue } from './outbox';
import { getBusinessId } from './session';

// Taking a repayment at the counter, offline.
//
// This is the moment the amadeni ledger earns its keep: a customer walks in at
// 9pm with 5,000 against what they owe. Until now it could only be recorded
// from the owner's dashboard, online — so it went on paper, and paper is the
// competitor. Recovery has to happen where the money changes hands.
//
// Everything here reads the local mirror and writes locally first; the outbox
// carries it to the server whenever the network returns.
function DebtRecovery({ currentUser, onClose, onRecorded }) {
  const [query, setQuery] = useState('');
  const [payFor, setPayFor] = useState(null); // the debt being recovered
  const [amount, setAmount] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  // Outstanding is computed from payments rather than stored: a payment queued
  // offline must count against the balance immediately, or the customer would
  // be asked for the same money twice.
  const debts = useLiveQuery(async () => {
    const [all, payments] = await Promise.all([db.debts.toArray(), db.debt_payments.toArray()]);
    const paidByDebt = payments.reduce((acc, p) => {
      acc[p.debt_id] = (acc[p.debt_id] ?? 0) + (p.amount ?? 0);
      return acc;
    }, {});
    return all
      .filter((d) => d.status !== 'void')
      .map((d) => ({ ...d, paid: paidByDebt[d.id] ?? 0, remaining: Math.max(0, (d.amount ?? 0) - (paidByDebt[d.id] ?? 0)) }))
      .filter((d) => d.remaining > 0)
      .sort((a, b) => (b.created_at ?? 0) - (a.created_at ?? 0));
  }, [], null);

  const money = (n) => Math.round(n || 0).toLocaleString();

  const visible = (debts ?? []).filter((d) =>
    query.trim() ? (d.customer_name ?? '').toLowerCase().includes(query.trim().toLowerCase()) : true
  );
  const totalOutstanding = (debts ?? []).reduce((sum, d) => sum + d.remaining, 0);

  const openPay = (debt) => {
    setPayFor(debt);
    setAmount(String(Math.round(debt.remaining))); // paying in full is the common case
    setError('');
  };

  const record = async () => {
    const entered = Math.round(Number(amount));
    if (!Number.isFinite(entered) || entered <= 0) return setError('Enter an amount');
    // Capped at what is owed: overpayment would make the ledger owe the
    // customer money, which this table cannot express.
    const paid = Math.min(entered, payFor.remaining);

    setBusy(true);
    try {
      const row = {
        id: crypto.randomUUID(),
        business_id: getBusinessId(),
        debt_id: payFor.id,
        amount: paid,
        staff_id: currentUser?.id ?? null,
        staff_name: currentUser?.name ?? null,
        station_id: payFor.station_id ?? null,
        station_name: payFor.station_name ?? null,
        created_at: Date.now(),
      };

      // Local first — the customer is standing there and the receipt is the
      // screen. The queue is what makes it durable.
      await db.debt_payments.add({ ...row, synced_status: 0 });
      await enqueue('debt_payment', {
        localId: row.id,
        row: { ...row, created_at: new Date(row.created_at).toISOString() },
      });

      // Fully paid: flip the debt closed. Queued AFTER the payment, so the
      // status can never arrive before the money that justifies it.
      if (payFor.paid + paid >= (payFor.amount ?? 0)) {
        await db.debts.update(payFor.id, { status: 'settled' });
        await enqueue('debt_settle', { id: payFor.id });
      }

      onRecorded?.(`Recovered ${money(paid)} RWF from ${payFor.customer_name}`);
      setPayFor(null);
      setAmount('');
    } catch (err) {
      console.error('Debt payment failed:', err);
      setError('Could not record that payment — try again');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-40 bg-slate-900/95 overflow-y-auto">
      <div className="max-w-2xl mx-auto p-4 space-y-4">
        <div className="flex items-center justify-between sticky top-0 bg-slate-900 py-3">
          <div>
            <p className="text-white text-xl font-extrabold">Amadeni</p>
            <p className="text-slate-400 text-sm">{money(totalOutstanding)} RWF still owed</p>
          </div>
          <button onClick={onClose} aria-label="Close" className="w-10 h-10 rounded-full bg-white/10 text-white text-2xl leading-none">
            ×
          </button>
        </div>

        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search by name…"
          className="w-full px-4 py-3 rounded-xl bg-slate-800 text-white placeholder-slate-500 border border-slate-700"
        />

        {debts === null ? (
          <p className="text-slate-400">Loading…</p>
        ) : visible.length === 0 ? (
          <p className="text-slate-400">
            {query.trim() ? 'Nobody by that name owes anything.' : 'No open debts.'}
          </p>
        ) : (
          <div className="space-y-2 pb-6">
            {visible.map((d) => (
              <button
                key={d.id}
                onClick={() => openPay(d)}
                className="w-full bg-white rounded-2xl shadow-md p-4 flex items-center justify-between gap-3 text-left active:scale-95"
              >
                <div className="min-w-0">
                  <p className="font-bold text-slate-800 truncate">{d.customer_name}</p>
                  <p className="text-xs text-slate-400 truncate">
                    {d.created_at ? new Date(d.created_at).toLocaleDateString() : '—'}
                    {d.staff_name ? ` · ${d.staff_name}` : ''}
                    {d.paid > 0 ? ` · ${money(d.paid)} paid` : ''}
                  </p>
                </div>
                <span className="font-extrabold text-amber-600 shrink-0">{money(d.remaining)} RWF</span>
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Amount sheet */}
      {payFor && (
        <div className="fixed inset-0 z-50 bg-black/60 flex items-end sm:items-center justify-center p-4">
          <div className="bg-white rounded-3xl shadow-xl w-full sm:max-w-sm p-5 space-y-4">
            <div>
              <p className="font-extrabold text-slate-800 text-lg">{payFor.customer_name}</p>
              <p className="text-slate-500 text-sm">Owes {money(payFor.remaining)} RWF</p>
            </div>

            <input
              type="number"
              inputMode="numeric"
              autoFocus
              value={amount}
              onChange={(e) => { setAmount(e.target.value); setError(''); }}
              className="w-full px-4 py-3 rounded-xl border border-gray-300 text-2xl font-bold text-center"
            />

            {/* Part-payment is the norm, so make the common splits one tap. */}
            <div className="grid grid-cols-3 gap-2">
              {[0.25, 0.5, 1].map((share) => (
                <button
                  key={share}
                  onClick={() => setAmount(String(Math.round(payFor.remaining * share)))}
                  className="py-2 rounded-xl bg-slate-100 text-slate-700 text-sm font-semibold active:scale-95"
                >
                  {share === 1 ? 'All' : `${share * 100}%`}
                </button>
              ))}
            </div>

            {error && <p className="text-red-600 text-sm font-semibold">{error}</p>}

            <div className="grid grid-cols-2 gap-3">
              <button
                onClick={() => { setPayFor(null); setError(''); }}
                className="h-14 rounded-xl font-bold bg-slate-100 text-slate-600 active:scale-95"
              >
                ← Back
              </button>
              <button
                onClick={record}
                disabled={busy}
                className="h-14 rounded-xl font-bold bg-emerald-600 text-white active:scale-95 disabled:opacity-50"
              >
                {busy ? 'Saving…' : 'Record payment'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default DebtRecovery;
