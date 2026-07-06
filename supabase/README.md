# Database migrations

The Supabase schema for this project lives here as plain SQL, applied in order.
There is no automated runner — each file is meant to be pasted into the
**Supabase SQL editor** and run once, oldest first.

## How to apply a migration

1. Open your project at <https://supabase.com/dashboard>.
2. Go to **SQL Editor → New query**.
3. Paste the contents of the next un-applied file from `migrations/`.
4. Click **Run**.

Every migration is written to be **idempotent** (guarded with `IF NOT EXISTS`),
so re-running one by accident is harmless.

## Applied order

| File | What it does |
|------|--------------|
| `0001_staff_and_identity.sql` | Adds the `staff` table (PIN login) and stamps `staff_id` / `staff_name` onto `hospitality_sales` and `audit_logs`. |

After running `0001`, the app's PIN login and per-waiter accountability work
end-to-end. Until then, the app falls back to a local-only default owner
(PIN `1234`) so it stays usable offline on first run.
