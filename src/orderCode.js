// A self-service order is encoded as a single compact, copy-friendly token so a
// device that can't scan (e.g. a desktop till with no camera) can still take the
// order: the waiter types or pastes the code shown under the customer's QR. The
// QR image and the on-screen code are the SAME string, so scanning and manual
// entry both decode identically.

// Object -> base64 token (UTF-8 safe).
export function encodeOrder(payload) {
  const bytes = new TextEncoder().encode(JSON.stringify(payload));
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

// Decode one base64 token to an order object, or null if it isn't one.
function tryToken(s) {
  try {
    const bin = atob(s);
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    const obj = JSON.parse(new TextDecoder().decode(bytes));
    if (obj && typeof obj === 'object' && Array.isArray(obj.items)) return obj;
  } catch {
    // not a valid token
  }
  return null;
}

// Token, a raw JSON payload (older codes), OR a larger message that merely
// contains the token (e.g. a shared WhatsApp text with an order summary above
// the code) -> object. Throws if nothing decodes.
export function decodeOrder(text) {
  const raw = String(text).trim();
  const whole = tryToken(raw);
  if (whole) return whole;
  try {
    const obj = JSON.parse(raw);
    if (obj && typeof obj === 'object') return obj;
  } catch {
    // not raw JSON either
  }
  // Pull the longest base64-looking run out of a bigger message and decode it.
  const candidates = (raw.match(/[A-Za-z0-9+/]{24,}={0,2}/g) || []).sort((a, b) => b.length - a.length);
  for (const c of candidates) {
    const obj = tryToken(c);
    if (obj) return obj;
  }
  throw new Error('unrecognized order code');
}
