import { useEffect, useState } from 'react';

// The waiter's side of the handover: one round, one code, shown at the counter
// for the barman to scan. Rendered locally by the `qrcode` package — nothing is
// fetched, so it works with no network, which is the entire point.
//
// Re-showing a round shows the SAME code (the handover id is minted once, when
// the round is raised), so a barman who scans twice gets "already received"
// rather than a second crate of beer.
function RoundQr({ round, code, lines, total, onClose }) {
  const [src, setSrc] = useState('');
  const [error, setError] = useState('');
  const [showText, setShowText] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const QRCode = (await import('qrcode')).default;
        // Medium correction: readable on a scratched screen without inflating
        // the code so far that a cheap camera struggles to resolve it.
        const url = await QRCode.toDataURL(code, { errorCorrectionLevel: 'M', margin: 1, width: 320 });
        if (!cancelled) setSrc(url);
      } catch (err) {
        if (!cancelled) setError(err?.message ?? 'Could not draw the code');
      }
    })();
    return () => { cancelled = true; };
  }, [code]);

  const money = (n) => Math.round(n || 0).toLocaleString();

  return (
    <div className="fixed inset-0 z-50 bg-slate-900/95 flex flex-col items-center justify-center p-5 gap-4">
      <div className="text-center">
        <p className="text-white text-xl font-extrabold">Round {round}</p>
        <p className="text-slate-400 text-sm">Show this to the barman</p>
      </div>

      <div className="bg-white rounded-2xl p-3 shadow-xl">
        {src ? (
          <img src={src} alt={`Round ${round} order code`} className="w-64 h-64" />
        ) : (
          <div className="w-64 h-64 flex items-center justify-center text-slate-400 text-sm text-center px-4">
            {error || 'Drawing code…'}
          </div>
        )}
      </div>

      <div className="w-full max-w-xs bg-slate-800 rounded-xl p-3 text-sm">
        {lines.map((l, i) => (
          <div key={i} className="flex justify-between text-slate-300">
            <span className="truncate pr-2">{l.quantity} × {l.name}</span>
            <span className="shrink-0">{money(l.quantity * l.unit_price)}</span>
          </div>
        ))}
        <div className="flex justify-between border-t border-slate-700 mt-2 pt-2 text-white font-bold">
          <span>Total</span>
          <span>{money(total)} RWF</span>
        </div>
      </div>

      {/* Fallback for a broken camera: the barman can type/paste the code. Kept
          out of the way, because it is slow and only for when scanning fails. */}
      {showText ? (
        <textarea
          readOnly
          value={code}
          onFocus={(e) => e.target.select()}
          className="w-full max-w-xs h-24 p-2 rounded-lg bg-slate-800 text-slate-300 text-[10px] border border-slate-700"
        />
      ) : (
        <button onClick={() => setShowText(true)} className="text-slate-500 text-xs font-semibold underline">
          Camera not working? Show the code as text
        </button>
      )}

      <button onClick={onClose} className="w-full max-w-xs h-12 rounded-xl bg-amber-500 text-white font-bold active:scale-95">
        Done
      </button>
    </div>
  );
}

export default RoundQr;
