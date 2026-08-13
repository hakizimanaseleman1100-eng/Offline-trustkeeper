// Central role + capability model — one place that decides who can do what.
//
// Trust model: staff work on a shared, PIN-gated device that is authenticated as
// the VENUE (one Supabase account). So access control here is enforced
// client-side — the industry norm for POS terminals. Server-side RLS still
// isolates every venue's data ([[tenant isolation]]); per-staff DB identities
// would be a future hardening step for true server-side per-role enforcement.

export const ROLES = ['OWNER', 'MANAGER', 'STOREMAN', 'WAITER', 'KITCHEN'];

export const ROLE_LABELS = {
  OWNER: 'Owner',
  MANAGER: 'Manager',
  STOREMAN: 'Storeman / Barman',
  WAITER: 'Waiter',
  KITCHEN: 'Kitchen',
};

export function roleLabel(role) {
  return ROLE_LABELS[role] ?? (role ? role[0] + role.slice(1).toLowerCase() : '—');
}

// The home screen a role lands on after PIN login.
//
// The STOREMAN / barman lands on the POS, not the dashboard: he is the one who
// actually sells. He receives waiters' rounds at the counter, issues the stock
// and takes the money — his dashboard tabs (Reconcile, Inventory, Expenses) are
// end-of-day work he switches to, not where his shift is spent.
export function landingFor(role) {
  switch (role) {
    case 'OWNER':
    case 'MANAGER':
      return 'DASHBOARD';
    case 'KITCHEN':
      return 'KITCHEN';
    default:
      return 'POS'; // WAITER, STOREMAN (and any unknown role) sell at the POS
  }
}

// Who may open the till at all. Everyone except the kitchen, which only ever
// needs the ticket display.
export function canSell(role) {
  return role !== 'KITCHEN';
}

// Dashboard tabs each role may open. Separation of duties:
//  - OWNER: everything.
//  - MANAGER: day-to-day operations, but NOT Settings (money config) or Team
//    (granting roles) — those stay with the owner.
//  - STOREMAN / BARMAN: stock accountability — Reconcile, Inventory, Expenses.
const TABS = {
  OWNER: ['Dashboard', 'Sales', 'Reconcile', 'Reports', 'Stations', 'Inventory', 'Purchases', 'Expenses', 'Team', 'Customers', 'Debts', 'Order QR', 'Settings'],
  MANAGER: ['Dashboard', 'Sales', 'Reconcile', 'Reports', 'Stations', 'Inventory', 'Purchases', 'Expenses', 'Customers', 'Debts', 'Order QR'],
  // The storeman receives the deliveries, so Purchases is his screen above all.
  STOREMAN: ['Reconcile', 'Inventory', 'Purchases', 'Expenses'],
};

export function allowedTabs(role) {
  return TABS[role] ?? [];
}
export function canOpenTab(role, key) {
  return allowedTabs(role).includes(key);
}

// Granular capabilities — loss-prone POS actions and admin powers. Kept as a set
// per role so new capabilities are a one-line change.
// purchases.create is wide (the storeman meets the supplier at the door);
// purchases.void is narrow, because voiding reverses stock and restores costs —
// the same separation of duties as voiding a sale.
const CAPABILITIES = {
  OWNER: ['pos.void', 'pos.discount', 'pos.refund', 'team.manage', 'settings.manage', 'purchases.create', 'purchases.void'],
  MANAGER: ['pos.void', 'pos.discount', 'pos.refund', 'purchases.create', 'purchases.void'],
  STOREMAN: ['purchases.create'],
  WAITER: [],
  KITCHEN: [],
};

export function can(role, capability) {
  return (CAPABILITIES[role] ?? []).includes(capability);
}
