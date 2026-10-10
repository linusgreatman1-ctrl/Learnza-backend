const crypto = require('crypto');
const prisma = require('../db');
const ai = require('./aiProvider.service');
const { OBJECTIVE_PER_PAPER, THEORY_PER_PAPER, YEAR_PAPER, paperYears, profileFor } = require('../utils/paper');

// The system writes practice material for every course on a student's dashboard — school
// courses and self-study courses alike — so nobody has to wait for a lecturer to set it:
//
//   CBT mock exams   2 papers, plus a fresh one each week (up to 8)
//   Past questions   1 paper in the style of the institution's past papers (and one a month, up to 6)
//   Practice bank    40 questions with explanations (40 more each month, up to 160)
//
// A mock or past-question PAPER is set the way the student's own kind of institution sets one
// (utils/paper.js): Section A is 20 objective questions in 15 minutes, Section B is 5 theory
// questions in 1 hour 30, and the two parts are taken separately. Each part is an ordinary
// Assessment (flagged generated) so the existing screens, timers and marking work unchanged; the
// two share a paperId. The practice bank lives in PlatformQuestion and is drawn 20 at a time.
// Past-question papers are WRITTEN IN THE STYLE of past papers; they are not scans of real ones,
// and say so in their titles.
//
// Everything runs in the background, one AI request at a time (providers rate-limit), and is
// idempotent: asking again while a course is being written, or after it is done, does nothing.

const DAY = 24 * 60 * 60 * 1000;
const PLAN = {
  MOCK: { perYear: true },   // one CBT mock paper for every year from 2016
  PAST: { perYear: true },   // one past-question paper for every year from 2016
  PRACTICE: { initial: 1, perSet: 40, topUpEvery: 30 * DAY, max: 4 },
};
const PRACTICE_CHUNK = 20;
// Courses finished before this date were written under the earlier plan and are checked again for the yearly papers.
const YEARLY_PLAN_FROM = new Date('2026-10-10T00:00:00Z');
const RETRY_COOLDOWN_MS = 15 * 60 * 1000;

const inFlight = new Set();          // `${kind}:${id}` currently being written
const lastFailure = new Map();       // `${kind}:${id}` -> time of the last failed attempt
let chain = Promise.resolve();       // one AI request at a time, across all courses
const enqueue = (fn) => { const run = chain.then(fn, fn); chain = run.catch(() => {}); return run; };

const SYSTEM_OBJECTIVE = `You write multiple-choice exam questions for students at Nigerian higher institutions (universities, polytechnics, monotechnics, colleges of education). Reply with JSON only, exactly:
{ "title": string, "questions": [ { "text": string, "options": [string, string, string, string], "correctIndex": number, "explanation": string } ] }
Rules:
- Exactly the number of questions asked for; each has exactly 4 options and one correct answer (correctIndex 0-3).
- Test understanding of the course, not trivia; cover a broad spread of its topics; vary difficulty.
- Options must be plausible; never "all of the above" / "none of the above".
- "explanation" is one clear sentence saying why the answer is right.
- Plain text only, no markdown. No question may depend on a diagram.
Return JSON only, no prose before or after.`;

const SYSTEM_THEORY = `You set the theory section of a written examination for students at Nigerian higher institutions. Reply with JSON only, exactly:
{ "title": string, "questions": [ { "text": string, "modelAnswer": string } ] }
Rules:
- Exactly the number of questions asked for. Each question is worth the same total marks, stated in the request.
- Each question has parts labelled (a), (b), (c), each on its own line inside "text" (use \\n between parts), with the marks for that part in brackets at its end, e.g. "(a) Define inflation. (2 marks)". The part marks must add up to the question's total.
- Spread the questions across different topics of the course; vary the command words; no two questions may overlap.
- "modelAnswer" is a marking guide: the points an examiner would look for in each part, with the marks each earns, in plain sentences.
- Plain text only, no markdown. No question may depend on a diagram.
Return JSON only, no prose before or after.`;

const STYLE = {
  MOCK: 'a CBT mock exam: balanced mix of recall, understanding and application, as in a computer-based test',
  PAST: 'past-question practice: phrased the way questions typically appear in past examination papers of this kind of institution on this course (do NOT claim they are real past papers)',
  PRACTICE: 'topic practice questions, each focused on one concept, easy to medium difficulty',
};

async function askWithRetry(system, userPrompt) {
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const out = await ai.askForJson(system, userPrompt);
      if (out && Array.isArray(out.questions) && out.questions.length) return out;
      throw new Error('AI returned no questions');
    } catch (err) {
      lastErr = err;
      if (err.code === 'AI_NOT_CONFIGURED') throw err;
      // provider rate limit / overload: wait and try again
      if (/429|quota|rate|overload|unavailable|exhaust/i.test(String(err.message))) await new Promise((r) => setTimeout(r, 20000 * (attempt + 1)));
      else if (attempt === 0) await new Promise((r) => setTimeout(r, 2000));
      else break;
    }
  }
  throw lastErr;
}

function cleanObjective(draft, n) {
  return (draft.questions || [])
    .filter((q) => q && q.text && Array.isArray(q.options) && q.options.length === 4 && Number.isInteger(q.correctIndex) && q.correctIndex >= 0 && q.correctIndex <= 3)
    .slice(0, n)
    .map((q) => ({ text: String(q.text).slice(0, 1000), options: q.options.map((o) => String(o).slice(0, 300)), correctIndex: q.correctIndex, explanation: q.explanation ? String(q.explanation).slice(0, 600) : null }));
}

function cleanTheory(draft, n, marks) {
  return (draft.questions || [])
    .filter((q) => q && q.text && String(q.text).trim().length > 20)
    .slice(0, n)
    .map((q) => {
      let text = String(q.text).replace(/\\n/g, '\n').trim().slice(0, 2000);
      // The marks are part of the question: if the writer left them out, state the total.
      if (!/\b\d+\s*marks?\b/i.test(text)) text += `\n[${marks} marks]`;
      return { text, modelAnswer: q.modelAnswer ? String(q.modelAnswer).slice(0, 2500) : null };
    });
}

const courseLabel = (ctx) => (ctx.code ? `${ctx.code} — ${ctx.title}` : ctx.title);
const where = (ctx) => (ctx.kind === 'school' ? { courseId: ctx.id } : { individualCourseId: ctx.id });
const contextLines = (ctx, profile) => [
  `Course: ${courseLabel(ctx)}`,
  ctx.department ? `Department: ${ctx.department}` : null,
  ctx.level ? `Level: ${ctx.level}` : null,
  ctx.institutionType ? `Institution: ${profile.label}` : null,
];

async function write(ctx, kind, setNumber) {
  const profile = profileFor(ctx.institutionType);
  const label = courseLabel(ctx);

  if (kind === 'PRACTICE') {
    const questions = [];
    for (let i = 0; i < PLAN.PRACTICE.perSet / PRACTICE_CHUNK; i++) {
      const prompt = [
        ...contextLines(ctx, profile),
        `Style: ${STYLE.PRACTICE}`,
        `Number of questions: ${PRACTICE_CHUNK}`,
        setNumber > 1 || i > 0 ? 'Other questions already exist for this course: use different questions and sub-topics from any earlier ones.' : null,
      ].filter(Boolean).join('\n');
      questions.push(...cleanObjective(await askWithRetry(SYSTEM_OBJECTIVE, prompt), PRACTICE_CHUNK));
    }
    if (questions.length < 10) throw new Error('AI returned too few usable questions');
    await prisma.platformQuestion.createMany({
      data: questions.map((q) => ({
        subject: label, level: ctx.level || null, source: 'Generated for your course',
        text: q.text, options: JSON.stringify(q.options), correctIndex: q.correctIndex, explanation: q.explanation,
        generated: true, active: true, ...where(ctx),
      })),
    });
    return;
  }

  // MOCK and PAST are written one year at a time: `setNumber` is the examination year.
  const year = setNumber;
  const name = kind === 'MOCK' ? `${label} — CBT Mock Exam ${year}` : `${label} — Past Questions ${year} Practice`;
  await createPaper(ctx, {
    style: STYLE[kind], name, assessmentType: kind === 'MOCK' ? 'Mock' : 'PAST_QUESTION', generated: true, year,
    objectiveCount: YEAR_PAPER.OBJECTIVE,
    // older years sit lower in the lists, which go by creation time
    createdAtMs: Date.now() - (new Date().getFullYear() - year) * 3600000,
  });
}

// Sets one paper -- Section A (objective) and Section B (theory) -- the way this kind of
// institution sets its examinations. Used for mock and past-question papers and for the
// semester exam of a self-study course.
async function createPaper(ctx, { style, name, assessmentType, setNumber = 1, generated = true, year = null, objectiveCount = OBJECTIVE_PER_PAPER, createdAtMs = null }) {
  const profile = profileFor(ctx.institutionType);
  const earlier = year
    ? `This paper is for the ${year} examination year. Make its questions and sub-topics different from papers for other years, and spread them across the whole course.`
    : (setNumber > 1 ? `This is paper number ${setNumber}: use different questions and sub-topics from earlier papers.` : null);
  const common = [...contextLines(ctx, profile), `Style: ${style}`, year ? `Examination year: ${year}` : null];

  // Section A. A long section is asked for in batches of at most 15 so the AI never has to return a huge answer;
  // each later batch is shown the earlier questions so nothing repeats.
  const objective = [];
  while (objective.length < objectiveCount) {
    const want = Math.min(15, objectiveCount - objective.length);
    const prompt = [
      ...common,
      profile.objectiveGuide ? `Set as for ${profile.objectiveGuide}` : null,
      `Number of questions: ${want}`,
      earlier,
      objective.length ? `These questions are already in the paper, so ask about other topics and do not repeat them:\n${objective.map((q) => '- ' + q.text.slice(0, 90)).join('\n')}` : null,
    ].filter(Boolean).join('\n');
    const got = cleanObjective(await askWithRetry(SYSTEM_OBJECTIVE, prompt), want);
    if (!got.length) break;
    objective.push(...got);
    if (got.length < want) break;
  }
  if (objective.length < Math.min(10, objectiveCount)) throw new Error('AI returned too few usable objective questions');
  const theory = cleanTheory(await askWithRetry(SYSTEM_THEORY, [
    ...common,
    `Set as for ${profile.guide}`,
    'Question type: THEORY',
    `Number of questions: ${THEORY_PER_PAPER}`,
    `Marks per question: ${profile.theoryMarks}`,
    earlier,
  ].filter(Boolean).join('\n')), THEORY_PER_PAPER, profile.theoryMarks);
  if (theory.length < 3) throw new Error('AI returned too few usable theory questions');

  const paperId = crypto.randomUUID();
  const base = { ...where(ctx), authorId: ctx.authorId, type: assessmentType, generated, paperId, sentAt: new Date(), semesterId: ctx.semesterId || null };
  // Both sections or neither, so a failure never leaves half a paper. Section A is stamped a moment
  // earlier so lists, which go by creation time, always show it first.
  const now = createdAtMs || Date.now();
  const minutesA = Math.max(1, Math.ceil(objective.length * 0.75));
  await prisma.$transaction([
    prisma.assessment.create({
      data: {
        ...base, createdAt: new Date(now), title: `${name} · Section A (Objective)`, section: 'OBJECTIVE', durationMin: minutesA, totalMarks: objective.length,
        questions: { create: objective.map((q, i) => ({ questionType: 'OBJECTIVE', text: q.text, options: JSON.stringify(q.options), correctIndex: q.correctIndex, explanation: q.explanation, order: i })) },
      },
    }),
    prisma.assessment.create({
      data: {
        ...base, createdAt: new Date(now + 2), title: `${name} · Section B (Theory)`, section: 'THEORY', durationMin: 90, totalMarks: theory.length * profile.theoryMarks,
        questions: { create: theory.map((q, i) => ({ questionType: 'THEORY', text: q.text, modelAnswer: q.modelAnswer, order: i })) },
      },
    }),
  ]);
}

// What exists for this course now (a paper counts once, by its Section A).
async function inventory(ctx) {
  const w = where(ctx);
  const sectionA = (type) => prisma.assessment.findMany({ where: { ...w, generated: true, type, section: 'OBJECTIVE' }, select: { title: true } });
  const yearsIn = (rows, label) => new Set(rows.map((r) => { const m = r.title.match(new RegExp(label)); return m ? Number(m[1]) : null; }).filter(Boolean));
  const [mockRows, pastRows, practice, lastPractice] = await Promise.all([
    sectionA('Mock'),
    sectionA('PAST_QUESTION'),
    prisma.platformQuestion.count({ where: { ...w, generated: true } }),
    prisma.platformQuestion.findFirst({ where: { ...w, generated: true }, orderBy: { createdAt: 'desc' }, select: { createdAt: true } }),
  ]);
  return {
    mockYears: yearsIn(mockRows, 'CBT Mock Exam (20\\d\\d) ·'),
    pastYears: yearsIn(pastRows, 'Past Questions (20\\d\\d) Practice ·'),
    practiceSets: Math.ceil(practice / PLAN.PRACTICE.perSet),
    lastPractice: lastPractice && lastPractice.createdAt,
  };
}

// The work still to do: a paper for every year that is missing (the newest first, so the latest paper is
// ready soonest), then the practice bank (which feeds the Daily Challenge).
function todo(inv, { topUp }) {
  const jobs = [];
  const old = (d, every) => d && Date.now() - d.getTime() > every;
  for (const y of paperYears()) if (!inv.mockYears.has(y)) jobs.push(['MOCK', y]);
  for (const y of paperYears()) if (!inv.pastYears.has(y)) jobs.push(['PAST', y]);
  if (inv.practiceSets < PLAN.PRACTICE.initial) jobs.push(['PRACTICE', inv.practiceSets + 1]);
  if (topUp && !jobs.length && inv.practiceSets < PLAN.PRACTICE.max && old(inv.lastPractice, PLAN.PRACTICE.topUpEvery)) jobs.push(['PRACTICE', inv.practiceSets + 1]);
  return jobs;
}

const keyOf = (ctx) => `${ctx.kind}:${ctx.id}`;

// Starts writing whatever is missing for a course, in the background. Returns at once.
async function kick(ctx) {
  const key = keyOf(ctx);
  if (inFlight.has(key)) return 'generating';
  // Finished recently: nothing to ask the database about (this runs on every dashboard load).
  if (ctx.readyAt && ctx.readyAt >= YEARLY_PLAN_FROM && Date.now() - ctx.readyAt.getTime() < 7 * DAY) return 'ready';
  if (!ai.isConfigured()) return ctx.ready ? 'ready' : 'unavailable';
  const failed = lastFailure.get(key);
  if (failed && Date.now() - failed < RETRY_COOLDOWN_MS) return ctx.ready ? 'ready' : 'retry-later';
  const inv = await inventory(ctx);
  const jobs = todo(inv, { topUp: !!ctx.ready });
  if (!jobs.length) {
    if (!ctx.ready) await markReady(ctx);
    return 'ready';
  }
  inFlight.add(key);
  (async () => {
    try {
      for (const [kind, n] of jobs) await enqueue(() => write(ctx, kind, n));
      await markReady(ctx);
      lastFailure.delete(key);
    } catch (err) {
      lastFailure.set(key, Date.now());
      if (err.code !== 'AI_NOT_CONFIGURED') console.error(`Practice generation for ${key} failed:`, err.message);
    } finally {
      inFlight.delete(key);
    }
  })();
  return 'generating';
}

async function markReady(ctx) {
  const data = { practiceReadyAt: new Date() };
  if (ctx.kind === 'school') await prisma.course.update({ where: { id: ctx.id }, data }).catch(() => {});
  else await prisma.individualCourse.update({ where: { id: ctx.id }, data }).catch(() => {});
}

// ---- who the courses are -------------------------------------------------------------------
async function schoolAuthor(schoolId) {
  const admin = await prisma.user.findFirst({ where: { schoolId, role: 'ADMIN' }, orderBy: { createdAt: 'asc' }, select: { id: true } });
  return admin ? admin.id : null;
}

// Every course on this student's dashboard, as generation contexts.
async function contextsFor(user) {
  const out = [];
  if (user.schoolId) {
    const [rows, authorId, semester, school] = await Promise.all([
      prisma.enrollment.findMany({ where: { studentId: user.id }, select: { course: { select: { id: true, code: true, title: true, level: true, practiceReadyAt: true, department: { select: { name: true, schoolId: true } } } } } }),
      schoolAuthor(user.schoolId),
      prisma.semester.findFirst({ where: { schoolId: user.schoolId, isCurrent: true }, select: { id: true } }),
      prisma.school.findUnique({ where: { id: user.schoolId }, select: { institutionType: true } }),
    ]);
    if (authorId) for (const { course: c } of rows) {
      if (c.department.schoolId !== user.schoolId) continue;
      out.push({ kind: 'school', id: c.id, code: c.code, title: c.title, level: c.level, department: c.department.name, authorId, semesterId: semester && semester.id, institutionType: school && school.institutionType, ready: !!c.practiceReadyAt, readyAt: c.practiceReadyAt });
    }
  }
  const own = await prisma.individualCourse.findMany({ where: { studentId: user.id } });
  for (const c of own) out.push({ kind: 'self', id: c.id, title: c.title, authorId: user.id, institutionType: user.institutionType, ready: !!c.practiceReadyAt, readyAt: c.practiceReadyAt });
  return out;
}

const statusOf = (ctx, started) => {
  if (inFlight.has(keyOf(ctx))) return 'generating';
  if (ctx.ready || started === 'ready') return 'ready';
  return started === 'retry-later' || started === 'unavailable' ? started : 'pending';
};

// Starts generation for every course the student has, and reports where each stands.
async function ensureForStudent(user) {
  const ctxs = await contextsFor(user);
  const result = [];
  for (const ctx of ctxs) {
    const started = await kick(ctx).catch(() => 'error');
    result.push({ id: ctx.id, kind: ctx.kind, title: courseLabel(ctx), status: statusOf(ctx, started) });
  }
  return result;
}

async function statusForStudent(user) {
  const ctxs = await contextsFor(user);
  return ctxs.map((ctx) => ({ id: ctx.id, kind: ctx.kind, title: courseLabel(ctx), status: statusOf(ctx) }));
}

module.exports = { ensureForStudent, statusForStudent, kick, contextsFor, createPaper, PLAN };
