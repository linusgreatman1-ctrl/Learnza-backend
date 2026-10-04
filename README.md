# Learnza

A learning platform for **all Nigerian higher institutions** — universities, polytechnics, monotechnics, colleges of education and others. One backend (Node/Express + Prisma + Postgres) serves three separate apps, in the same shape as the sibling project PassNow:

| URL | App | Who uses it | How they sign in |
|---|---|---|---|
| `/app` (and `/`) | **Student app** | independent learners (not tied to a school) | email + password (self-register, forgot/reset password by email) |
| `/schools` | **Schools app** | school admins, lecturers, staff, school students | school admin: **school name + join code**. Everyone else: **full name + school name + access code** |
| `/admin` | **Super-admin panel** | the platform owner | email + password |

Schools **cannot register themselves**. The platform owner onboards a school from the panel; the school gets a permanent 8-character **join code** and a one-year licence. The school admin then signs in to `/schools`, adds departments, courses, lecturers, staff and students — each person gets an **access code** to sign in with (no email needed). There is no admissions feature: institutions already run their own admission process.

## What the apps do

- **Learning**: courses, lessons (lecturer video/script or AI Teacher with a lip-synced avatar), tests/CBT/semester exams with auto-marking, assignments and projects, past questions, digital lab, e-library, AI research assistant, study groups (chat, files, voice notes, polls, "seen by" receipts), live classes with recordings, class attendance, formal results, gamification (points, streaks, badges — no leaderboard of other students' scores).
- **School administration**: directory of lecturers / staff / students, semesters, hostels and allocations, transcript and clearance requests, credentials with public verification, academic record, disciplinary records, staff attendance / CPD / publications, bulk in-app/email/SMS messages.
- **Money**: student subscriptions (Paystack or Flutterwave) and **coins** — a pay-as-you-go top-up for live AI Teacher minutes once the plan's included minutes run out (1 coin = 5 minutes; packs of 30 / 100).
- **Help**: support tickets, live chat (AI assistant answers until a person from the team replies), app reviews.
- **Installable**: both apps are PWAs (manifest, offline shell, "new version available" prompt).

### Super-admin panel

Dashboard · Analytics · Questions (practice question bank) · Lessons · Courses · AI Conversations · AI Teacher · Demonstrations (digital lab) · Payments · Coins · Gamification · Attendance · Results · Academic Records · Users · Teachers · Schools (onboarding, join codes, renew/suspend) · Subscriptions · Announcements · Bulk Email · Bulk SMS · Support Tickets · App Reviews · Live Chat · Live Classes · e-Library · Codes (school join codes and people's access codes) · **Code Editor** · App Settings (paywall override, maintenance mode, sign-up open/closed, AI switch, daily AI question limit) · Platform Admins · Audit Log · System Logs.

**Code Editor.** Edit the apps' front-end files (`public/*`) from the panel with a live preview. Edits autosave as a *draft* that only the preview shows; publishing needs your password, goes live for everyone immediately, and every version is kept for one-click rollback. Published edits live in the database, so a redeploy does not wipe them. Guard rails: JavaScript must parse and JSON must be valid before a draft saves, the service worker and the admin panel itself are not editable (so you can always roll back), and every publish/rollback/restore is in the Audit Log. A bad logic change can still break the apps for users — check the preview, and use History → Roll back if it happens.

## Security model

- 15-minute access tokens + rotating, hashed, 30-day refresh tokens (per-tab, per-app session keys). Signing out or changing a password revokes refresh tokens immediately.
- Password sign-in lockout (5 failures → 15 minutes); rate limits count only *failed* sign-ins (a campus often shares one IP).
- A suspended school or lapsed licence blocks everyone at that school at sign-in, refresh and on every request.
- **Tenant isolation**: every route that takes a course, assessment, assignment, group, result… id proves it belongs to the caller's school first (`src/scope.js`) and answers 404 otherwise. `tests/isolation.js` covers this with two schools.
- `helmet` with a strict content-security policy (no inline scripts).

## Running locally

```bash
npm install
cp .env.example .env        # fill in DATABASE_URL, JWT_SECRET and the super-admin seed
npx prisma db push
npm run dev                 # http://localhost:4100  → redirects to /app
```

On boot the server creates the super admin from `SEED_SUPER_ADMIN_EMAIL` / `SEED_SUPER_ADMIN_PASSWORD` if none exists (idempotent). Sign in at `/admin`, onboard a school, copy its join code, and sign in at `/schools`.

## Tests

```bash
npm test                                   # unit tests, no server or database needed
```

The API suites run against a **running server and a scratch database** (never production — they create schools and users). Start the server with the same `DATABASE_URL`/`JWT_SECRET`, then:

```bash
SUPER_EMAIL=… SUPER_PASSWORD=… LOG_FILE=server.log node tests/e2e.js          # auth, sessions, schools, lockout, rate limits
SUPER_EMAIL=… SUPER_PASSWORD=… node tests/isolation.js                         # two-school isolation + add lecturer/student flows
SUPER_EMAIL=… SUPER_PASSWORD=… node tests/platform.js                          # announcements, payments, settings, library…
SUPER_EMAIL=… SUPER_PASSWORD=… node tests/support-coins.js                     # tickets, chat, reviews, coins, polls
SUPER_EMAIL=… SUPER_PASSWORD=… node tests/oversight.js                         # oversight views, question bank, logs, codes, Code Editor
```

`e2e.js` finishes by tripping the sign-in rate limiter, so restart the server between runs.

## Deploying (Railway)

Live at **https://learnza-backend-production.up.railway.app**. Pushing to `main` does not deploy by itself — redeploy from source:

```bash
railway redeploy --yes --from-source
```

- Build: `npm install && npx prisma generate`
- Pre-deploy: `npx prisma db push --accept-data-loss` (runs on every deploy; review schema changes for anything destructive first)
- Start: `npm start`, health check `/health`

### Environment variables

See `.env.example`. Required: `DATABASE_URL`, `JWT_SECRET`, `SEED_SUPER_ADMIN_EMAIL`, `SEED_SUPER_ADMIN_PASSWORD`. Optional features switch on when their variables are present: AI (`GEMINI_API_KEY` or `ANTHROPIC_API_KEY`), AI avatar (`SIMLI_*`), payments (`PAYSTACK_SECRET_KEY` / `FLUTTERWAVE_*`), email (`SMTP_*`), SMS (`TERMII_*`), file storage (`CLOUDINARY_*` — without it uploads go to local disk, which a redeploy wipes).
