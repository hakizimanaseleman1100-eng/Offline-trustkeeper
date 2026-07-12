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

// Token (or a raw JSON payload, for older codes / a pasted JSON) -> object.
export function decodeOrder(text) {
  const raw = String(text).trim();
  try {
    const bin = atob(raw);
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    const obj = JSON.parse(new TextDecoder().decode(bytes));
    if (obj && typeof obj === 'object') return obj;
  } catch {
    // Not a base64 token — fall through to plain JSON.
  }
  return JSON.parse(raw);
}
