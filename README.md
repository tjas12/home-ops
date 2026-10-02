# Home Ops

A mobile-first private household command center for two approved users. The frontend is a build-free PWA; Supabase provides authentication, shared Postgres persistence, row-level security, and server functions. Resend handles email.

## What is included

- Approved-email login for Husband and Wife
- Household-scoped row-level security on every shared table
- Today dashboard with progress, overdue items, routines, events, reminders, and bills
- Task, reminder, event, bill, and routine CRUD
- Helpful empty states, loading indicators, delete confirmations, and mobile-friendly forms
- Exact date-string calendar matching (no UTC conversion of date-only values)
- Daily routine completion records
- Weekly Reset drafting and persistence
- Refresh on focus, tab resume, and page restore
- Installable PWA shell
- Server-side Resend test email and scheduled notification processor
- Notification delivery log and household notification settings

## Run locally

```bash
npm install
npm run dev
```

Then open `http://localhost:3000`.

## Configure Supabase

Copy `config.example.js` to `config.js` and add your public Supabase values:

```js
window.HOME_OPS_CONFIG = {
  supabaseUrl: "https://YOUR_PROJECT.supabase.co",
  supabaseAnonKey: "YOUR_PUBLIC_ANON_KEY",
};
```

Never put a Supabase service-role key or Resend API key in browser files.

## Build

```bash
npm run build
```

The static app is copied into `dist/`.
