import { getBusinessId } from './session';

// The id of the local-only bootstrap owner that OLD builds seeded with a
// well-known PIN. There is no default owner any more (a venue must create its
// own owner PIN — see OwnerPinSetup); this id is kept only so App.jsx can
// delete the stale row from devices that were seeded by those builds.
export const LEGACY_DEFAULT_OWNER_ID = 'local-default-owner';

// PINs that anyone would try first on a stolen/borrowed till: repeated digits
// (0000, 1111…), and runs in either direction (1234, 4321, 0123…). A 4-digit
// PIN is casual access control, but the *owner's* PIN gates the money screens,
// so the obvious guesses are refused outright. Returns an error string, or null.
export function pinProblem(pin) {
  if (!/^\d{4}$/.test(pin)) return 'PIN must be exactly 4 digits';
  if (/^(\d)\1{3}$/.test(pin)) return 'Too easy to guess — do not repeat the same digit';
  if ('0123456789'.includes(pin) || '9876543210'.includes(pin)) {
    return 'Too easy to guess — do not use digits in order';
  }
  return null;
}

// SHA-256 of `${business_id}:${pin}` as lowercase hex. Salting with the business
// id namespaces PINs per tenant. Both login and staff creation MUST hash through
// here so the stored hash and the login hash match. The raw PIN never leaves it.
export async function hashPin(pin) {
  const data = new TextEncoder().encode(`${getBusinessId()}:${pin}`);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}
