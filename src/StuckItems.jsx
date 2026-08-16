import { useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from './db';
import { retryDead } from './outbox';

// What the red strip opens: the queue items that failed with an error retrying
// cannot fix, and what to do about them.
//
// Without this the strip was a dead end — it announced a problem and offered
// nothing, which is only marginally better than the silence it replaced. The
// common case is real: a bug is fixed, the app updates, and the item that
// failed yesterday would go through today. That needs one button, not a
// support call.
function StuckItems({ onClose, notify }) {
  const items = useLiveQuery(() => db.outbox.where('state').equals('dead').toArray(), [], null);
  const [busy, setBusy] = useState(false);

  const label = {
    sale: 'Sale',
    debt: 'Debt (amadeni)',
    debt_payment: 'Debt repayment',
    debt_settle: 'Debt settled',
    stock_move: 'Stock movement',
    audit_log: 'Audit record',
    expense: 'Expense',
    reconciliation: 'Day closing sheet',
    handover: 'Waiter round',
    purchase: 'Delivery',
    purchase_lines: 'Delivery items',
    purchase_lines_update: 'Delivery corrections',
    purchase_receive: 'Delivery received',
    purchase_void: 'Delivery voided',
  };

  const retryAll = async () => {
    setBusy(true);
    for (const item of items ?? []) await retryDead(item.seq);
    setBusy(false);
    notify?.('Trying again — watch the dot');
  };

  const discard = async (item) => {
    if (
      !window.confirm(
        `Discard this ${label[item.kind] ?? item.kind}? It stays on this phone but will never reach the cloud.`
      )
    ) {
      return;
    }
    await db.outbox.delete(item.seq);
  };

  return (
    <div className="fixed inset-0 z-50 bg-slate-900/90 overflow-y-auto">
      <div className="max-w-lg mx-auto p-4 space-y-4">
        <div className="flex items-center justify-between sticky top-0 bg-slate-900 py-3">
          <div>
            <p className="text-white text-xl font-extrabold">Not saved to the cloud</p>
            <p className="text-slate-400 text-sm">Everything is still on this phone.</p>
          </div>
          <button onClick={onClose} aria-label="Close" className="w-10 h-10 rounded-full bg-white/10 text-white text-2xl leading-none">
            ×
          </button>
        </div>

        {items === null ? (
          <p className="text-slate-400">Loading…</p>
        ) : items.length === 0 ? (
          <p className="text-slate-400">Nothing stuck — everything has gone through.</p>
        ) : (
          <>
            <button
              onClick={retryAll}
              disabled={busy}
              className="w-full h-12 rounded-xl bg-emerald-600 text-white font-bold active:scale-95 disabled:opacity-50"
            >
              {busy ? 'Trying…' : '↻ Try again'}
            </button>
            <p className="text-slate-400 text-xs">
              If the app has been updated since these failed, trying again usually works. If not, show this screen to
              whoever supports you — the reason is written under each one.
            </p>

            {items.map((item) => (
              <div key={item.seq} className="bg-white rounded-2xl shadow-md p-4 space-y-2">
                <div className="flex justify-between items-start gap-3">
                  <div className="min-w-0">
                    <p className="font-bold text-slate-800">{label[item.kind] ?? item.kind}</p>
                    <p className="text-xs text-slate-400">
                      {new Date(item.created_at).toLocaleString()} · {item.attempts} attempt
                      {item.attempts === 1 ? '' : 's'}
                    </p>
                  </div>
                  <button onClick={() => discard(item)} className="text-xs font-semibold text-red-600 shrink-0">
                    Discard
                  </button>
                </div>
                {/* The raw reason, deliberately. It is the only thing that makes
                    a remote diagnosis possible over a phone call. */}
                <p className="text-xs text-slate-600 bg-slate-50 rounded-lg p-2 break-words">{item.last_error}</p>
              </div>
            ))}
          </>
        )}
      </div>
    </div>
  );
}

export default StuckItems;
