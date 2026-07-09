import { getBusinessId } from './session';

// A fixed id for the local-only bootstrap owner seeded when no staff exist yet
// (offline first run, before the Team tab has created any real accounts).
export const DEFAULT_OWNER_ID = 'local-default-owner';
export const DEFAULT_OWNER_PIN = '1234';

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
