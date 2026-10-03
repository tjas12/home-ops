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

This is a build-free static app, not Vite or Next.js. The browser reads Supabase config from `config.js`.

Install and run locally:

```bash
npm install
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

Postgres `date` columns are returned as `YYYY-MM-DD`. The app avoids UTC conversion for date-only calendar logic. Calendar dots compare exact date strings:

```js
event.event_date === formatLocalDate(cellDate)
```

Times are stored separately and rendered through `formatTime12Hour`.
