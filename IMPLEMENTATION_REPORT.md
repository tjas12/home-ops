# Home Ops Feature Improvements

## A. Summary

Implemented future event windows (14 days/month, persisted locally), inclusive multi-day event display and editing, task/event reminder choices, structured Weekly Reset scheduled items, Today/Calendar integration, completion/read/delete notification cleanup and numeric PWA badges. Existing seven freeform Weekly Reset fields, auth/onboarding, household membership, static architecture and push registration remain.

Work is isolated in `pdf-improvements/`, branch `feature/pdf-improvements`, based on known-good rollback commit `e848412`. The older parent workspace was not modified. No production data or schema was written.

## B. Files Changed

- `.gitignore`
- `README.md`
- `IMPLEMENTATION_REPORT.md`
- `package.json`
- `pnpm-lock.yaml`
- `build-bundles.mjs`
- `build-static.mjs`
- `src/app.js`
- `app.bundle.001.b64`
- `app.bundle.002.b64`
- `app.bundle.003.b64`
- `app.bundle.004.b64`
- `app.bundle.005.b64`
- `app.bundle.006.b64`
- `app.bundle.007.b64`
- `app.bundle.008.b64`
- `app.bundle.009.b64`
- `app.bundle.010.b64`
- `styles.css`
- `sw.js`
- `supabase/functions/process-notifications/index.ts`
- `supabase/functions/send-home-ops-push/index.ts`
- `supabase/migrations/20261004012135_home_ops_feature_requests.sql`
- `supabase/migrations/20261004012220_notification_badge_cleanup.sql`
- `tests/build.test.mjs`
- `tests/database.test.mjs`
- `tests/frontend.test.mjs`
- `tests/mock-client.mjs`
- `tests/push.test.mjs`
- `tests/service-worker.test.mjs`

Generated `dist/` and screenshots in `test-artifacts/` are ignored. The loader `app.js`, `push.js`, old migrations, manifest, configuration and existing auth/RLS helpers were not edited.

## C. Database

The CLI generated the two incremental filenames above. They add optional reminder offsets, end-date constraints, `weekly_plan_items` with CRUD membership RLS, indexes, notification retirement and service-only Chicago scheduling RPCs. Composite foreign keys prevent cross-household plan/assignee references. Existing pending pre-reminders with NULL lead times are cancelled. Existing delivered alerts for completed items are marked read.

Production read-only inspection confirmed `events.end_date`, `notifications.read_at`, dispatch occurrence uniqueness, existing completion triggers and zero invalid event spans. Migrations have passed in isolated Postgres (PGlite) but have NOT been applied to Supabase. PGlite uses an auth fixture and a test-only pgcrypto replacement for invite-token defaults; Supabase Auth itself is external to this test.

## D. Edge Functions

- `send-home-ops-push`: recovered the deployed v3 source into the repository; preserved VAPID setup, registration, user settings, recipient resolution, cron authorization and test mode. Added service-only DST-safe scheduling RPC consumption, completed-item rechecks, atomic dispatch claims and payload notification/source IDs plus unread counts.
- `process-notifications`: replaced fixed `-05:00` midnight with a Chicago timezone RPC and skips records already read. Existing standalone reminder, routine, bill and Weekly Reset email behavior remains.

Neither function was deployed.

## E. Build

Readable canonical source is `src/app.js`. `build-bundles.mjs` normalizes UTF-8 source to CRLF and writes exactly ten base64 chunks. `build-static.mjs` regenerates them and includes all chunks in `dist/` (the old static build omitted them). The original loader is unchanged.

Before feature edits, concatenated regenerated chunks matched the original decoded module byte for byte. Baseline SHA-256: `af4a5a84b7f89e69587c8541d4ae5c7f4c3bd1a2cdbe30fb9e8c5353d07934f9`. Tests also verify repeated builds produce identical chunks and `dist/` matches source output.

## F. Tests

Commands run:

```text
node build-static.mjs
node --check src/app.js
node --check app.js
node --check push.js
node --check sw.js
node --check supabase/functions/send-home-ops-push/index.ts
node --check supabase/functions/process-notifications/index.ts
node --test tests/*.test.mjs
node --test tests/frontend.test.mjs
git diff --check
```

PASS: five test suites, zero failures. The expanded browser suite also passed after adding real service-worker precaching/cache-upgrade/offline-chunk checks. JavaScript/TypeScript syntax checks and whitespace checks passed. TypeScript checks here validate syntax, not Deno dependency/type resolution.

- Build: baseline equivalence, source-to-chunk mapping, deterministic rebuild, complete dist output.
- Database: all incremental SQL executes; new profiles without whitelist; existing household/invite RPC behavior; A/B select/insert/update/delete denial; anonymous denial; weekly completion; 5/30/60-minute scheduling; NULL/invalid offsets; winter/summer and both DST transitions; midnight-crossing offsets; date-span validation; completion cleanup; privileged scheduling access denied to members.
- Generated app in installed Edge: 390x844, 412x915 and 1440x1000; login/logout/signup/onboarding; household create/join; six navigation tabs; future/range event display; weekly create/display/complete; freeform preservation; task create/edit/no-reminder/complete; event create/edit/end-date preservation/delete/complete/calendar spans; badge zero; no page errors or horizontal overflow. Supabase responses are mocked.
- Push: mocked transport; concurrent duplicate suppression; Everyone and assigned recipients; household isolation; user opt-out; changed lead time; completed-item suppression; numeric badge payload; unauthorized cron/test rejection.
- Worker: actual browser cache upgrade removes v5; v6 contains all ten chunks; offline chunk fetch succeeds. Unit tests cover numeric badge set/clear and unsupported APIs.

Screenshots were visually inspected. Native iOS/Android install/push delivery was not tested.

## G. Regression Status

PASS below means the stated automated coverage passed. It does not certify live credentials or physical devices.

| Area | Automated Status | Production/Device Status |
| --- | --- | --- |
| Login | PASS, generated app with mocked Auth | NOT VERIFIED |
| Signup | PASS, frontend plus database profile trigger | NOT VERIFIED, email confirmation outstanding |
| Create Household | PASS, frontend and database membership access | NOT VERIFIED |
| Join Household | PASS, frontend plus real SQL invite RPC | NOT VERIFIED |
| Today | PASS | NOT DEPLOYED |
| Tasks | PASS, create/edit/complete/reminder selection | NOT DEPLOYED |
| Events | PASS, create/edit/delete/complete/range/reminders | NOT DEPLOYED |
| Calendar | PASS, inclusive multi-day spans | NOT DEPLOYED |
| Routines | PASS, existing renderer/navigation | Full routine CRUD not retested live |
| Weekly Reset | PASS, freeform preservation and scheduled integration | NOT DEPLOYED |
| Settings | PASS, existing renderer/logout | Live settings persistence not retested |
| Push | PASS, mocked scheduler/transport/security tests | FAIL release gate: physical/live verification incomplete |
| PWA | PASS, browser worker/cache/offline asset tests | FAIL release gate: iPhone/Android installation incomplete |

Household RLS: PASS in isolated Postgres. Live login/existing-household release gate: FAIL because verification is incomplete, not because a failure was observed. No merge/deployment is permitted until that gate passes.

## H. Deployment

`main` was not updated. GitHub Pages deployment was not triggered. Supabase migrations/functions were not deployed. The feature branch is intended for a draft PR only.

## I. Manual Steps

1. Use a staging Supabase project with the current push backend, apply both new migrations and deploy both modified functions.
2. Test real login/logout/signup/email confirmation, create/invite/join and existing household access. Check staging advisors and API access as authenticated users from two households.
3. Install staging on Android Chrome and iPhone Safari Home Screen. Test enable/disable/permission, test push, app open/closed, 5/30/60-minute reminders, Everyone/assigned recipients, no duplicates, clicks and badge decrement/zero.
4. Only after these checks pass, coordinate production migrations, Edge Functions and frontend merge. Confirm GitHub Pages success and repeat live smoke checks.

## J. Risks and Limits

No verified production credentials or physical devices were available; a mock Auth test cannot prove live Supabase login. PGlite proves SQL behavior with fixtures, not Supabase's full platform configuration. The production push schema was previously deployed outside the checked-in migrations; fresh environments still need that backend/configuration provisioned. Uncertain/interrupted push dispatches retain claims to avoid duplicate sends and may require operational review. There is a small unavoidable completion-versus-network-delivery race after the final source recheck. A closed second device learns badge changes on its next push or open; OS badge behavior varies. Frontend scheduled items require the migrations, and both modified functions require their scheduling RPC migration.
