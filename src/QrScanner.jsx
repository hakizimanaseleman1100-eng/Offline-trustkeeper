import { useEffect, useRef, useState } from 'react';

// Camera QR scanner using the native BarcodeDetector (available on Chrome /
// Android — the target devices). Calls onResult with the decoded text once,
// then the parent closes it.
function QrScanner({ onResult, onClose }) {
  const videoRef = useRef(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let stream;
    let raf;
    let stopped = false;

    (async () => {
      if (!('BarcodeDetector' in window)) {
        setError('This device can’t scan QR codes. Use a Chrome-based browser.');
        return;
      }
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
        if (stopped) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        const video = videoRef.current;
        video.srcObject = stream;
        await video.play();

        // eslint-disable-next-line no-undef
        const detector = new BarcodeDetector({ formats: ['qr_code'] });
        const tick = async () => {
          if (stopped) return;
          try {
            const codes = await detector.detect(video);
            if (codes.length > 0) {
              onResult(codes[0].rawValue);
              return; // parent will unmount us
            }
          } catch {
            // transient detect errors — keep scanning
          }
          raf = requestAnimationFrame(tick);
        };
        raf = requestAnimationFrame(tick);
      } catch (err) {
        setError(err?.name === 'NotAllowedError' ? 'Camera permission denied.' : 'Could not open the camera.');
      }
    })();

    return () => {
      stopped = true;
      if (raf) cancelAnimationFrame(raf);
      if (stream) stream.getTracks().forEach((t) => t.stop());
    };
  }, [onResult]);

  return (
    <div className="fixed inset-0 z-50 bg-black flex flex-col items-center justify-center">
      <video ref={videoRef} playsInline muted className="max-h-[70vh] max-w-full rounded-2xl" />
      <div className="absolute top-0 inset-x-0 flex items-center justify-between p-4 text-white">
        <span className="font-semibold">Scan the customer’s order QR</span>
        <button onClick={onClose} aria-label="Close scanner" className="w-10 h-10 rounded-full bg-white/20 text-2xl leading-none">
          ×
        </button>
      </div>
      {error && (
        <div className="absolute bottom-10 inset-x-6 text-center">
          <p className="text-amber-300 font-semibold mb-3">{error}</p>
          <button onClick={onClose} className="px-5 py-2 rounded-xl bg-white text-slate-900 font-bold">
            Close
          </button>
        </div>
      )}
    </div>
  );
}

export default QrScanner;
