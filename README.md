# Home Ops

A mobile-first household command center that runs as one shared static PWA with separate private household workspaces. Supabase provides Auth, Postgres persistence, Row Level Security, invitations, and Edge Functions. Resend handles email delivery.

## What is included

- Supabase email/password login and account creation
- Multi-household onboarding: create a household or join with an invite
- Household membership roles: `owner` and `member`
- Household-scoped Row Level Security across shared data
- Member-based assignment with legacy `assigned_to` preserved for migration safety
- Today dashboard, tasks, reminders, calendar events, bills, routines, weekly reset, and settings
- Household settings with members, invite link generation, and owner-only member removal
- Installable mobile-first PWA shell for iPhone and Android
- Server-side email test and scheduled notification processor

## 1. Supabase setup

Create a Supabase project, then run migrations in order:

1. `supabase/migrations/202606240001_home_ops.sql`
2. `supabase/migrations/202606240002_notification_triggers.sql`
3. `supabase/migrations/202610020001_multi_household_accounts.sql`

The third migration upgrades the original two-user private schema into the multi-household model. It is incremental and keeps existing data.

It adds:

- `household_members`
- `household_invites`
- `assigned_user_id` columns
- user-level notification/push tables
- membership-aware RLS helpers
- invite acceptance and member-removal RPC functions

Existing `approved_access` records can remain for old accounts, but new normal signups no longer require manual whitelist rows.

## 2. Configure the web app

This is a static ES-module app. The browser reads Supabase config from `config.js`.
The canonical application is `src/app.js`. Keep edits there; `app.js` is the unchanged known-good loader.
`build-bundles.mjs` encodes UTF-8 source with deterministic CRLF line endings and partitions the base64 into ten ordered chunks.
`build-static.mjs` regenerates those chunks and copies the loader, all ten chunks, push module, CSS, manifest, worker and assets into `dist/`.
The initial reconstructed source reproduced the deployed module byte for byte (SHA-256 `af4a5a84b7f89e69587c8541d4ae5c7f4c3bd1a2cdbe30fb9e8c5353d07934f9`).

Install and run locally:

```bash
corepack pnpm install --frozen-lockfile
npm run build
npm run check
npm test
npm run dev
```

Then open:

```text
http://localhost:3000
```

Create `config.js` from `config.example.js`:

```js
window.HOME_OPS_CONFIG = {
  supabaseUrl: "https://YOUR_PROJECT.supabase.co",
  supabaseAnonKey: "YOUR_PUBLIC_ANON_KEY",
};
```

Never put a service-role key or Resend key in `config.js`.

## 3. Deploy static app

GitHub Pages can serve the app from the repository root.

Recommended Pages settings:

- Source: Deploy from branch
- Branch: `main`
- Folder: `/root`

The app remains static-host compatible. Backend logic stays in Supabase and Supabase Edge Functions.

## 4. Configure email functions

Set these Supabase Edge Function secrets:

```text
RESEND_API_KEY
HOME_OPS_FROM_EMAIL
CRON_SECRET
```

Deploy:

```text
supabase functions deploy send-home-ops-email
supabase functions deploy process-notifications --no-verify-jwt
```

Schedule `process-notifications` every few minutes using Supabase Cron/pg_cron or an external scheduler. Send `CRON_SECRET` in the `x-cron-secret` header.

## 5. Verification checklist

- Create User A1, create Household A, add a task/event/routine.
- Generate an invite, create/log in as User A2, accept the invite.
- Confirm A1 and A2 see Household A data.
- Create User B1, create Household B.
- Confirm Household B starts empty and cannot see Household A members or data.
- Assign tasks to Everyone, A1, and A2.
- Confirm assignment labels show household member names.
- Try an expired/invalid/reused invite and confirm it fails cleanly.
- Test on iPhone Home Screen PWA and desktop browser.

## Date safety

Postgres `date` columns are returned as `YYYY-MM-DD`. The app avoids UTC conversion for date-only calendar logic. Calendar dots and selected-day lists include every day in an inclusive event span:

```js
event.event_date <= day && (event.end_date || event.event_date) >= day
```

Times are stored separately and rendered through `formatTime12Hour`.

## Feature migrations and release order

Apply the existing migrations first, then the two new incremental migrations:

- `20261004012135_home_ops_feature_requests.sql`: optional task/event reminder lead times, end-date checks, scheduled weekly items with membership RLS and cross-household-safe references, and privileged scheduling RPCs.
- `20261004012220_notification_badge_cleanup.sql`: pending cancellation, delivered-notification retirement on completion/deletion, stale unread cleanup and unread indexes.

The production project already has push registration tables/configuration, dispatch uniqueness and VAPID keys. This change preserves them. For a fresh environment, provision the existing push backend before running push tests against that environment.
Deploy the migrations before the modified `send-home-ops-push` and `process-notifications` Edge Functions. The recovered push function uses its existing cron-header authentication and registration protocol.
Run its scheduler at least every five minutes (one minute recommended). Postgres computes task/event due timestamps in `America/Chicago`, subtracts 5/30/60 minutes and checks a five-minute delivery window, including midnight and DST boundaries. NULL means no pre-reminder; a date and time are required for a timed pre-reminder. Standalone reminder/routine schedules remain unchanged.
Occurrence keys contain source date, time and selected lead time. The unique dispatch is claimed before transport. Ambiguous failures retain the claim to prioritize avoiding duplicate delivery; inspect function logs for interrupted dispatches.

Never merge until real login, existing household access and RLS checks pass. Backend changes and frontend release must be coordinated. This branch has not been deployed.

## Weekly Reset and Today

All seven freeform fields remain editable. Scheduled Items are separate structured rows linked to the current weekly plan. Nothing parses or converts old text. An unsaved current plan is created when the first scheduled item is saved.
Today shows Scheduled Today, upcoming scheduled items when present, and completed weekly items. Weekly appointments also appear on Calendar. Upcoming Events defaults to an inclusive 14-day window; Next Month ends on the corresponding date next month, clamped for shorter months. The selector is stored locally.

## PWA and notification badges

Android: open in Chrome and install from its menu. iPhone: open in Safari, choose Add to Home Screen, then enable push from the installed app's Settings. Permission and subscription registration remain in `push.js`.
Worker cache `home-ops-v6` includes all bundle chunks and removes older Home Ops caches. Authenticated Supabase responses are not cached. Browsers without badge APIs continue normally.
Badge counts use sent, due, unread notification records filtered to the signed-in user across accessible households. Future pending notifications and read/completed records do not count. Completion/deletion triggers retire related notifications, the app refreshes its badge after completion, opening/focus, and reading, and zero clears it. Push payloads carry numeric unread counts and notification/source IDs. Clicking a notification marks that user's record read after authentication, including when opening a closed app. A background device updates its badge on its next push or app open.

## Verification

Use Node 24 or newer and the committed dependency lockfile. `npm test` runs deterministic build tests, isolated Postgres migration/RLS tests, generated-app browser tests, push transport/assignment/concurrency tests and worker badge tests. Browser tests use mock Supabase responses; they do not certify production credentials, email confirmation or real push delivery. On Windows they use installed Edge; set `HOME_OPS_BROWSER_CHANNEL=chrome` to use Chrome. Elsewhere install Playwright Chromium (`pnpm exec playwright install chromium`).
Screenshots from desktop and 390/412px mobile viewports are written to ignored `test-artifacts/`. Physical iPhone/Android installation, permission, background push and OS badges require device checks. See `IMPLEMENTATION_REPORT.md` for exact scope and outstanding release gates.
