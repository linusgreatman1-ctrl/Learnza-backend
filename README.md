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
- **Money**: student subscriptions (monthly ₦10,000 / yearly ₦105,000) and **coins** (1 coin = 1 minute of live AI Teacher time; packs of 30 / 100) — paid like PassNow: **Flutterwave** (card, bank, USSD, mobile money; verified server-side and by webhook) or a **bank transfer / USSD** request that the super admin confirms in the panel. Paystack is not supported. Everything settles through one idempotent path (`src/services/payments.service.js`) that checks the amount paid.
- **Practice made for each course**: for every course on a student's dashboard (school or independent) the system writes 2 CBT mock exams, a past-question-style practice set and a 30-question practice bank, topped up weekly (`src/services/practiceGen.service.js`). Past-question sets are honest practice written from the course, not real papers.
- **Elections**: the school admin runs a student union (SUG) or lecturer election; lecturers and/or students vote once on a secret ballot (no voter id is stored with a vote); the admin sees every candidate's votes with the student/lecturer split, turnout and who has voted — never who voted for whom.
- **Help**: support tickets, live chat (AI assistant answers until a person from the team replies), app reviews.
- **Digital ID**: every account — independent student, school student, lecturer, non-academic staff, school admin — has a PassNow-style card (role badge, photo, ID number, institution, department, level, QR code, "Save as picture"). Anyone can add their own photo; a school admin can set anyone's in the directory, and a lecturer can set the photo of students in their classes. Only facts the account actually holds are shown.
- **Installable**: both apps are PWAs (manifest, offline shell, "new version available" prompt).

### Super-admin panel

Dashboard · Analytics · Questions (practice question bank) · Lessons · Courses · AI Conversations · AI Teacher · Demonstrations (digital lab) · Payments · Coins · Gamification · Attendance · Results · Academic Records · Users · Teachers · Schools (onboarding, join codes, renew/suspend) · Subscriptions · Announcements · Bulk Email · Bulk SMS · Support Tickets · App Reviews · Live Chat · Live Classes · e-Library · Access Codes · Code Editor · Live Preview · Codes · App Settings (paywall override, maintenance mode, sign-up open/closed, AI switch, daily AI question limit) · Platform Admins · Audit Log · System Logs.

**Code Editor, Live Preview and Codes** (modelled on PassNow's). *Code Editor*: search a file for an exact snippet, see each match in context, replace one occurrence or all. *Codes*: the complete raw source of either app, edited and saved whole, with find-next. *Live Preview*: the real running app in a frame with a "jump to screen" menu built from the app's own sidebar. Saves are live immediately (no deploy step), stored in the database so a redeploy does not wipe them, and each one keeps a backup you can restore from the Code Editor's Backups table. Guard rails: JavaScript must parse and JSON must be valid before anything saves, a replacement that would break a file is refused, the service worker and the admin panel itself are not editable (so you can always undo), and every save, replace, restore and revert is in the Audit Log. Only a super admin can use them. Because edits are immediate, a change that parses but misbehaves reaches users at once — undo it from Backups.

Also in the panel: **Access Codes** (view and reissue people's access codes and schools' join codes).

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
SUPER_EMAIL=… SUPER_PASSWORD=… node tests/digital-id.js                        # every role signs in and has a Digital ID; photo permissions
SUPER_EMAIL=… SUPER_PASSWORD=… node tests/oversight.js                         # oversight views, question bank, logs, codes, Code Editor
SUPER_EMAIL=… SUPER_PASSWORD=… node tests/commerce.js                          # payments, bank transfers, coins, elections, generated practice (start the server with LZ_FAKE_AI=1 FLUTTERWAVE_WEBHOOK_HASH=whash FLUTTERWAVE_PUBLIC_KEY=FLWPUBK-test)
SUPER_EMAIL=… SUPER_PASSWORD=… node tests/perf.js                              # query-count / N+1 check (LZ_QUERY_COUNT=1 on the server)
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

See `.env.example`. Required: `DATABASE_URL`, `JWT_SECRET`, `SEED_SUPER_ADMIN_EMAIL`, `SEED_SUPER_ADMIN_PASSWORD`. Optional features switch on when their variables are present: AI (`GEMINI_API_KEY` or `ANTHROPIC_API_KEY`), AI avatar (`SIMLI_*`), payments (`FLUTTERWAVE_PUBLIC_KEY`, `FLUTTERWAVE_SECRET_KEY`, `FLUTTERWAVE_WEBHOOK_HASH`; bank details via `PAY_*`; webhook URL `/api/billing/webhook/flutterwave`), email (`SMTP_*`), SMS (`TERMII_*`), file storage (`CLOUDINARY_*` — without it uploads go to local disk, which a redeploy wipes).
