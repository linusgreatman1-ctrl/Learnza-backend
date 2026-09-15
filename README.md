# Learnza

A free higher-institution learning platform for students, lecturers and school admin — built for the **Edo College of Education** pilot. Separate codebase from PassNow; shares the same architectural pattern (Node/Express + Prisma + a static vanilla-JS frontend) but its own database, auth and deploy.

## What's built (core learning loop, MVP)

- **Auth**: JWT-based, roles STUDENT / LECTURER / ADMIN. Students self-register; lecturers/admin accounts are provisioned by the school admin.
- **Academics**: School → Department → Course structure, enrollment.
- **AI Teacher lessons**: lecturers write a narration script per lesson; the browser's built-in Web Speech API (`speechSynthesis`) reads it aloud with live word-highlighting — a genuinely free, zero-API-cost "AI teacher," with an optional recorded video URL alongside it.
- **e-Library**: textbooks / past questions / handouts per course, uploaded as a file (stored on local disk — swap for Cloudinary/S3 before scaling) or an external link.
- **Study groups**: per-course, student-created, with chat. No leaderboard, no ranking (by design).
- **CBT / CA tests**: lecturer-authored multiple-choice assessments, auto-graded on submit, results visible to the lecturer.
- **School admin**: manage departments/courses, staff & student directory, and a lecturer activity log (logins, lessons published, resources uploaded, assessments created). Student activity is deliberately never tracked here.

## Not built yet (from the original brief)

Live video classrooms, AI research assistant (students & lecturers), AI-generated assessment feedback, digital ID / smart cards, full admissions pipeline, transcripts/clearance/graduation workflow, attendance/CPD/publications tracking for staff, finance/subscription billing (₦10,000/mo, ₦105,000/yr, school licensing), and a true AI-avatar teacher (e.g. Simli-style video avatar) — all deferred pending scope/budget decisions and API keys.

## Running locally

```bash
npm install
npx prisma db push
node src/seed.js   # only needed once, seeds Edo College of Education demo data
npm run dev
```

Demo logins (seeded):
- Admin: `admin@edocoe.edu.ng` / `Admin@123`
- Lecturer: `lecturer@edocoe.edu.ng` / `Lecturer@123`
- Student: `student@edocoe.edu.ng` / `Student@123`

## Deploying

Live at **https://learnza-backend-production.up.railway.app** — a Railway project (`learnza-backend`), auto-deploying from `main`, with its own managed Postgres database (migrated from an earlier Render + Supabase setup; same data).

- Build: `npm install && npx prisma generate`
- Pre-deploy: `npx prisma db push --accept-data-loss` (must run as a pre-deploy step, not part of the build — the build container has no access to Railway's private network, so `db push` can't reach the database at build time)
- Start: `npm start`, health check `/health`
- Env vars: `NODE_ENV=production`, `DATABASE_URL` (references the Postgres service), `JWT_SECRET`

To redeploy: push to `main`. `src/seed.js` runs automatically on every boot and is a no-op once a `School` row exists, so it's safe on a populated database.

An earlier deployment lived on Render (`render.yaml`, still in this repo) with the database on Supabase — check whether that's still running before assuming it's retired.
