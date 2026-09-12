# CampusPass

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

## Deploying for a real public link

This environment has no GitHub CLI or Render/Railway CLI configured, so it hasn't been deployed yet. To get a public URL:
1. Push this folder to a new GitHub repo.
2. Create a Render (or Railway) web service from that repo — build command `npm install && npx prisma generate`, start command `npm start`.
3. Add a persistent Postgres database for production (SQLite's local file won't survive Render's ephemeral filesystem) and set `DATABASE_URL` + `JWT_SECRET` env vars.
4. Run `npx prisma db push` and `node src/seed.js` once against the production database.

Ask the coding assistant to drive this once you're ready — it can use your logged-in browser session to set up Render/GitHub, or you can hand it a Render API key.
