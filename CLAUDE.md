# CLAUDE.md — TrustKeeper POS (Offline-trustkeeper)

Project memory for Claude Code. Read fully before any task. This file is the
source of truth for strategy and engineering decisions; update it when
decisions change.

## What this product is

Offline-first POS for Rwandan bars, restaurants and motels (beachhead), built
by a solo founder in Musanze, Rwanda. React + Vite + Tailwind PWA, Dexie
(IndexedDB) local-first storage, Supabase (Postgres + RLS + Auth) backend,
deployed on Vercel. Retail/duka mass market is the later destination; do NOT
build retail features now.

**The pitch (lead with this, not features):** "Menya buri gicupa cyagurishijwe,
buri deni, na buri faranga — na waiter atari we ubikubwira." (Know every bottle
sold, every debt, every franc — without depending on the waiter to tell you.)
We sell theft-proofing and debt recovery; the POS is the mechanism.

## Strategy (12-week plan, gates are hard)

- Phase 1 (wk 1–2) CLEAN: cut premature features, PWA offline shell,
  idempotent sync, EBM disclaimer. — MOSTLY DONE, see status.
- Phase 2 (wk 2–4) BUILD ship-blockers only: two-sided debt SMS, onboarding
  wizard, owner daily SMS, dashboard split + sale header table, super-admin
  plan_status page.
- Phase 3 (wk 4–8) PILOTS: 5 free design-partner venues in Musanze. Metric:
  closed-day rate (reconciliations submitted / trading days). Gate: ≥4/5
  venues at 80%+. Bugfixes only; every feature request logged with venue name,
  build only what 3+ venues ask for.
- Phase 4 (wk 8–12) SCALE: convert pilots to Rwf 15,000/mo or 150,000/yr
  (manual MoMo billing + plan_status flag; NO billing automation before ~30
  paying venues). Referral-only sales. Target: 15–20 venues, ≥Rwf 225k MRR.
- Background thread, always alive: RRA CIS certification
  (cis_sdc_certification@rra.gov.rw) — longest lead time in the plan. EBM
  fiscalisation becomes the upsell/moat when it lands.

## Root causes the product attacks (from field research)

RC-1 capture cost > benefit at the counter (speed is everything; target
basket <15s median). RC-2 four unreconciled ledgers: cash / MoMo / credit book
(ikaye) / fiscal — one sale event must write all books. RC-3 compliance as a
parallel system — fiscalisation must become a byproduct of selling. RC-4
one-sided informal credit (amadeni) — the two-sided SMS-confirmed debt ledger
is THE wedge feature. RC-5 records never pay the owner back — payoff loop
within days (daily SMS report, shrinkage proof, later credit access).
Constraints: SC-1 cost-to-serve (~$8 CAC ceiling, referral distribution);
SC-2 low-end Android + flaky 2G (offline-first, sale NEVER blocks).

## Engineering rules (non-negotiable)

1. Sale capture never blocks on network. Local commit first, sync async.
2. Every synced entity is idempotent: client-generated UUID + server upsert
   with unique constraint. Debts already do this; sales fixed in mvp-ship.
3. All money in RWF integers (no decimals). Prefer Math.round at boundaries.
4. Every printed/shared bill MUST carry "ORDER NOTE — IYI SI FAGITIRE YA EBM /
   (Not an RRA fiscal receipt)" until RRA CIS certification lands. Local
   REC-xxxxx numbers are NOT fiscal receipts. Never remove this disclaimer.
5. Migrations: numbered files in supabase/migrations/, auto-applied by GitHub
   Actions on push to main. Write idempotent DDL (if not exists / do $$
   guards). Migration must be live BEFORE a client that depends on it deploys.
   PostgREST ON CONFLICT cannot use partial indexes (42P10) — full constraints.
6. RLS on every table via auth_business_id(). Never weaken tenant isolation.
7. Sync is automatic (after checkout + window 'online' event). The status dot
   (green Saved / amber N pending / pulsing Saving) is passive UI; manual tap
   is a fallback only. Never reintroduce a "Sync to Cloud" workflow.
8. No new features that a pilot venue didn't ask for 3+ times. Cut features
   live in git history on main (ClientOrder.jsx, QrScanner.jsx, orderCode.js,
   coupons, customer portal) — do not resurrect without a revenue reason.
9. PWA: vite-plugin-pwa autoUpdate precaches shell; navigator.storage.persist()
   requested in main.jsx. Never runtime-cache Supabase data in the SW — the
   Dexie outbox owns data sync.

## Current state (branch mvp-ship, ahead of main)

DONE:
- Cut (customer-facing half only): ClientOrder/QrScanner/orderCode removed from
  the build; biz_123 legacy fallback deleted (src/config.js removed).
  NOT yet cut — the OWNER-side remnants still ship: the "Order QR" tab
  (PortalQrTab, OwnerDashboard.jsx ~2282, prints QR codes to a portal that no
  longer exists), coupon granting inside CustomersTab (~2610-2860), the loyalty
  threshold/reward fields in SettingsTab, and the `qrcode` dependency.
- No default credentials: PIN 1234 bootstrap owner deleted. A venue with no
  active OWNER lands on OwnerPinSetup.jsx (server-side staff insert, requires
  network once); App.jsx deletes any stale 'local-default-owner' row even
  offline; pinProblem() in auth.js rejects repeated/sequential PINs for owner
  AND staff; Team tab refuses to deactivate the last active OWNER.
- Migration 0026: staff_role_check widened to allow STOREMAN (the client has
  offered the role since the RBAC commit, the DB rejected it — 23514).
- EBM disclaimer on billText() (SMS/share) and print block in src/POS.jsx.
- PWA + persistent storage wired (vite.config.js, src/main.jsx).
- Idempotent sales sync: uid stamped at db.sales.add (2 sites in POS.jsx),
  upsert(onConflict:'uid', ignoreDuplicates:true); migration 0025 (full unique
  constraint, idempotent do$$ version) pushed; constraint already applied
  manually to the live database via SQL editor.
- Sync button demoted to status dot.
- Unified outbox (src/outbox.js): one ordered, retrying queue for sales, debts,
  debt_payments, debt_settle, stock moves, audit logs, expenses. '++seq' IS the
  order. Retryable failure stops the drain (order preserved); permanent failure
  (bad payload / RLS / schema) is set aside as 'dead' and shown as a red strip
  in the POS. Migration 0028 makes apply_station_stock retry-safe via a per-move
  uid (the movement row is the receipt) + uid on audit_logs/expenses.
- Reconcile: Expected Total = cash + MoMo + amadeni recovered − expenses (credit
  sales excluded — no money arrived today). A shortfall MUST be booked as a debt
  before the day can be saved (migration 0027: debts.source/business_day).
  Counts are blind for non-owners: nothing prefilled, expected/variance hidden
  until "Submit count", recounts recorded in the snapshot. Restocking is entered
  in the IBYINJIYE column (deltas only) instead of per-product in Inventory.
- Floor workflow (the real one): waiter takes the order at the table on his own
  phone → shows a per-ROUND QR at the counter → barman scans, issues the stock,
  and confirms the payment (he is accountable for stock and money). Two offline
  phones cannot reach each other through Supabase and a PWA has no LAN/BT
  channel, so QR is the handover. src/handover.js + QrScanner + RoundQr;
  received_rounds is the idempotency ledger (a second scan is a no-op). The
  waiter's phone never pushes sales — one writer of money per venue.
- STOREMAN/barman lands on the POS (landingFor), not the dashboard; both
  surfaces switch via buttons. WaiterSettlement = "who is still holding my
  money". DebtRecovery = take an amadeni repayment at the counter, offline
  (debts + debt_payments are down-synced into Dexie for the whole venue).

VERIFY (may still be pending):
- Migration 0028 applied before the outbox client deploys (0026/0027 are live).
- QR handover on real hardware: BarcodeDetector needs Chrome on Android + HTTPS.
  Never yet run on a physical phone.
- Outbox torture test: sell offline → reconnect → kill network mid-drain →
  reconnect. Expect exactly one sales row AND one stock decrement per sale.
- Sync dot goes green; queued sales in hospitality_sales with uid filled;
  repeated sync taps do not increase row count.
- Vercel Deployment Protection disabled (preview URLs were behind Vercel SSO,
  breaking manifest fetch + PWA install on test devices).
- Gate 1 torture test on cheap Android: install PWA → airplane mode → sell →
  close browser → cold-start offline → sell → reconnect → exactly one row per
  sale.
- Merge mvp-ship → main only after Gate 1 passes (Vercel prod deploys main).

## Task queue (in order — do not reorder without reason)

1. DONE (see Current state). Follow-up when convenient: cut the owner-side
   portal/coupon/loyalty remnants listed above + drop `qrcode`.
2. DONE (see Current state). Debt recovery at the POS is done too — the
   remaining offline gaps are EXPENSE capture at the POS and a reconciliation
   that survives a dead network (the close is still online-only, and the pilot
   metric is closed-day rate at the hour connectivity is worst).
3. Two-sided amadeni (THE demo feature): add customer_phone to debts
   (+ migration), SMS on debt creation and on every recovery via Africa's
   Talking or MTN SMS API, queued offline through the outbox. Kinyarwanda
   template: "Wafashe ibicuruzwa bya Rwf X kuri [venue]. Umwenda wose: Rwf Y."
4. Onboarding wizard: venue name → owner PIN → staff PINs → quick-add ~20
   products (bar/restaurant/motel starter templates). Stranger to first sale
   in <10 min unaided.
5. Owner daily closing SMS: "Today: Rwf X sales · Rwf Y cash expected · Rwf Z
   new debts · top item: ___" fired from reconciliation.
6. Split OwnerDashboard.jsx (~3k lines) into modules; add a sale-header
   (invoice-level) table — groundwork for EBM invoices, refunds, payment
   matching. Build the table, not the features.
7. Super-admin: tenant list + plan_status (trial/active/read_only) + suspend.
   Lapsed venues go READ-ONLY, never locked out of their data.
8. Later (post-revenue): replace xlsx@0.18.5 (CVEs, 424KB), code-split the
   634KB main chunk, EBM VSDC/OSDC fiscal adapter behind the outbox.

## Context worth knowing

- eKash unified MoMo/Airtel/bank merchant codes nationally on 14 Jul 2026 —
  future payment auto-matching opportunity; nobody has built on it yet.
- Closest competitor: Kayko (Kigali, $1.2M seed, ~8,500 merchants, ~6% paid
  conversion, EMI licence, payments-first). Our lane: operations-first
  (shrinkage, amadeni, reconciliation) + offline reliability.
- Real incumbent is the paper notebook (ikaye). Beat it on speed first.
- Dev machine: Windows, PowerShell, paths contain a space
  ("C:\Users\DIGITAL AXIS\...") — always quote paths in commands.
