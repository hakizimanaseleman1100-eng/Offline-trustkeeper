# Sovereign Hospitality OS — SaaS Plan

**North star:** ship as SaaS for many bars/motels. **Setup simplicity and
operating simplicity are the top priority** — a new venue gets running in
minutes, daily use is low-friction, no technical steps.

---

## Where we stand

**Already SaaS-friendly**
- Every table is scoped by a `business_id` column — the data model is already
  row-level multi-tenant in shape (one shared schema, not per-tenant DBs).
- Offline-first with sync; clean, low-tap UI; fast PIN staff switching.
- One Supabase project + Vercel auto-deploy.

**The blockers**
1. **No tenant isolation.** `CURRENT_BUSINESS_ID = 'biz_123'` is hardcoded, and
   RLS is wide-open (`using(true)`) with a public anon key. Two venues today
   would see each other's data. *This is the gate — nothing ships to a second
   customer until it's fixed.*
2. **Setup isn't self-serve.** A new venue only works because we run ~10 SQL
   migrations by hand and scope to a fixed business. Customers can't do that.
3. **No accounts, no billing, no vendor/ops tooling.**

---

## Decisions to lock first (Stage 0)

| Decision | Recommendation | Why |
|---|---|---|
| Auth model | **Business account (email+password via Supabase Auth) + staff PIN within it.** The device logs in once as the venue; staff switch by PIN. | Keeps the fast shared-device PIN UX while giving real per-tenant isolation. Per-staff cloud accounts would break the counter-service flow. |
| Tenancy style | **Row-level in one shared schema**, isolated by `business_id` + RLS. | Already the shape; no per-tenant migrations; cheapest to run/scale. |
| Billing provider | **Local-first (Flutterwave / Paystack / MoMo)** over Stripe. | Market is Rwanda, MoMo-heavy; card-only Stripe is a poor fit. *Your call.* |
| Migration workflow | **Supabase CLI in CI** (stop pasting SQL by hand). | Reliable schema changes are table-stakes for SaaS. |

---

## Stage 1 — Multi-tenant foundation (security-critical, the gate)

- `businesses` table (id, name, plan, created_at) and `profiles` (auth user →
  business_id, role).
- Turn on **Supabase Auth**; a signup creates a business row + owner profile in
  one transaction.
- Replace the hardcoded `CURRENT_BUSINESS_ID` everywhere with the **authenticated
  business's id** (from the session/profile).
- **Rewrite RLS on every table**: `using (business_id = auth_business_id())`
  via a `SECURITY DEFINER` helper; delete the permissive `using(true)` policies.
- Client: a business login screen **before** the PIN pad; cache the business
  session + id locally so **PIN login still works offline** all day.
- One-time migrate the existing `biz_123` data into a real business row.

_Outcome: multiple venues can use it safely. Everything below builds on this._

## Stage 2 — Self-serve onboarding (the simplicity payoff)

- After signup, a short **wizard**: venue name → stations (default "Main Bar",
  skippable) → owner + staff PINs → products (starter templates / quick add).
- Sensible defaults so any step can be skipped and they can start selling.
- Replace the `1234` default-owner backdoor with owner creation at signup.
- Empty-state guidance throughout ("Add your first product", etc.).

_Outcome: empty account → selling in minutes, no help needed._

## Stage 3 — Billing & plans

- Subscriptions: free trial → paid; provider integration + webhooks to flip
  status; gate access (read-only / soft lock) when lapsed.
- Keep tiers minimal (simplicity) — ideally one plan to start.

_Outcome: it's a business._

## Stage 4 — Vendor ops & reliability

- Supabase CLI migrations in CI (no more manual SQL).
- Super-admin view: list tenants, support, suspend/reactivate.
- Error monitoring, backups, basic rate limiting.

## Stage 5 — Scale polish

- Code-split the ~520KB bundle; make it an installable PWA.
- Per-tenant data export; account/data deletion (privacy).
- Kitchen push notifications; optional per-venue branding.

---

## Recommended order

**0 (decide) → 1 (isolate) → 2 (onboard) → 3 (bill) → 4 (ops) → 5 (polish).**

Stage 1 is the hard gate and the biggest single change (it touches auth, RLS,
and the hardcoded business id across the app). Stage 2 is where the
"setup simplicity" promise gets delivered. 3 makes it monetizable; 4–5 harden
it for real customers.
