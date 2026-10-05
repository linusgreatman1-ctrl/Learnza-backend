const prisma = require('../db');
const ai = require('./aiProvider.service');

// The system writes practice material for every course on a student's dashboard — school
// courses and self-study courses alike — so nobody has to wait for a lecturer to set it:
//
//   CBT mock exams   2 sets of 10 questions, plus a fresh one each week (up to 8)
//   Past questions   1 set of 20 in the style of Nigerian exam papers (and one a month, up to 6)
//   Practice bank    30 questions with explanations (30 more each month, up to 120)
//
// Mock and past-question sets are ordinary Assessments (flagged generated) so the existing
// screens, timers and marking work unchanged. The practice bank lives in PlatformQuestion.
// Past-question sets are WRITTEN IN THE STYLE of past papers; they are not scans of real ones,
// and say so in their titles.
//
// Everything runs in the background, one AI request at a time (providers rate-limit), and is
// idempotent: asking again while a course is being written, or after it is done, does nothing.

const DAY = 24 * 60 * 60 * 1000;
const PLAN = {
  MOCK: { initial: 2, perSet: 10, topUpEvery: 7 * DAY, max: 8 },
  PAST: { initial: 1, perSet: 20, topUpEvery: 30 * DAY, max: 6 },
  PRACTICE: { initial: 1, perSet: 30, topUpEvery: 30 * DAY, max: 4 },
};
const RETRY_COOLDOWN_MS = 15 * 60 * 1000;

const inFlight = new Set();          // `${kind}:${id}` currently being written
const lastFailure = new Map();       // `${kind}:${id}` -> time of the last failed attempt
let chain = Promise.resolve();       // one AI request at a time, across all courses
const enqueue = (fn) => { const run = chain.then(fn, fn); chain = run.catch(() => {}); return run; };

const SYSTEM = `You write multiple-choice exam questions for students at Nigerian higher institutions (universities, polytechnics, monotechnics, colleges of education). Reply with JSON only, exactly:
{ "title": string, "questions": [ { "text": string, "options": [string, string, string, string], "correctIndex": number, "explanation": string } ] }
Rules:
- Exactly the number of questions asked for; each has exactly 4 options and one correct answer (correctIndex 0-3).
- Test understanding of the course, not trivia; cover a broad spread of its topics; vary difficulty.
- Options must be plausible; never "all of the above" / "none of the above".
- "explanation" is one clear sentence saying why the answer is right.
- Plain text only, no markdown. No question may depend on a diagram.
Return JSON only, no prose before or after.`;

const STYLE = {
  MOCK: 'a CBT mock exam: balanced mix of recall, understanding and application, as in a computer-based test',
  PAST: 'past-question practice: phrased the way questions typically appear in Nigerian university/polytechnic examinations on this course (do NOT claim they are real past papers)',
  PRACTICE: 'topic practice questions, each focused on one concept, easy to medium difficulty',
};

async function askWithRetry(userPrompt) {
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const out = await ai.askForJson(SYSTEM, userPrompt);
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

function clean(draft, n) {
  return (draft.questions || [])
    .filter((q) => q && q.text && Array.isArray(q.options) && q.options.length === 4 && Number.isInteger(q.correctIndex) && q.correctIndex >= 0 && q.correctIndex <= 3)
    .slice(0, n)
    .map((q) => ({ text: String(q.text).slice(0, 1000), options: q.options.map((o) => String(o).slice(0, 300)), correctIndex: q.correctIndex, explanation: q.explanation ? String(q.explanation).slice(0, 600) : null }));
}

const courseLabel = (ctx) => (ctx.code ? `${ctx.code} — ${ctx.title}` : ctx.title);
const where = (ctx) => (ctx.kind === 'school' ? { courseId: ctx.id } : { individualCourseId: ctx.id });

async function write(ctx, kind, setNumber) {
  const spec = PLAN[kind];
  const prompt = [
    `Course: ${courseLabel(ctx)}`,
    ctx.department ? `Department: ${ctx.department}` : null,
    ctx.level ? `Level: ${ctx.level}` : null,
    `Style: ${STYLE[kind]}`,
    `Number of questions: ${spec.perSet}`,
    setNumber > 1 ? `This is set number ${setNumber}: use different questions and sub-topics from earlier sets.` : null,
  ].filter(Boolean).join('\n');
  const questions = clean(await askWithRetry(prompt), spec.perSet);
  if (questions.length < Math.min(5, spec.perSet)) throw new Error('AI returned too few usable questions');

  if (kind === 'PRACTICE') {
    await prisma.platformQuestion.createMany({
      data: questions.map((q) => ({
        subject: courseLabel(ctx), level: ctx.level || null, source: 'Generated for your course',
        text: q.text, options: JSON.stringify(q.options), correctIndex: q.correctIndex, explanation: q.explanation,
        generated: true, active: true, ...where(ctx),
      })),
    });
    return;
  }
  const title = kind === 'MOCK' ? `${courseLabel(ctx)} — Mock Exam ${setNumber}` : `${courseLabel(ctx)} — Past Questions Practice${setNumber > 1 ? ` ${setNumber}` : ''}`;
  await prisma.assessment.create({
    data: {
      ...where(ctx),
      authorId: ctx.authorId,
      title,
      type: kind === 'MOCK' ? 'Mock' : 'PAST_QUESTION',
      durationMin: kind === 'MOCK' ? 15 : 30,
      generated: true,
      sentAt: ctx.kind === 'school' ? new Date() : null,
      semesterId: ctx.semesterId || null,
      questions: { create: questions.map((q, i) => ({ questionType: 'OBJECTIVE', text: q.text, options: JSON.stringify(q.options), correctIndex: q.correctIndex, explanation: q.explanation, order: i })) },
    },
  });
}

// What exists for this course now.
async function inventory(ctx) {
  const w = where(ctx);
  const [mocks, pasts, practice, lastMock, lastPast, lastPractice] = await Promise.all([
    prisma.assessment.count({ where: { ...w, generated: true, type: 'Mock' } }),
    prisma.assessment.count({ where: { ...w, generated: true, type: 'PAST_QUESTION' } }),
    prisma.platformQuestion.count({ where: { ...w, generated: true } }),
    prisma.assessment.findFirst({ where: { ...w, generated: true, type: 'Mock' }, orderBy: { createdAt: 'desc' }, select: { createdAt: true } }),
    prisma.assessment.findFirst({ where: { ...w, generated: true, type: 'PAST_QUESTION' }, orderBy: { createdAt: 'desc' }, select: { createdAt: true } }),
    prisma.platformQuestion.findFirst({ where: { ...w, generated: true }, orderBy: { createdAt: 'desc' }, select: { createdAt: true } }),
  ]);
  return {
    mocks, pasts, practiceSets: Math.ceil(practice / PLAN.PRACTICE.perSet),
    lastMock: lastMock && lastMock.createdAt, lastPast: lastPast && lastPast.createdAt, lastPractice: lastPractice && lastPractice.createdAt,
  };
}

// The work still to do, in the order a student would want it (a mock to try first).
function todo(inv, { topUp }) {
  const jobs = [];
  const old = (d, every) => d && Date.now() - d.getTime() > every;
  for (let n = inv.mocks + 1; n <= PLAN.MOCK.initial; n++) jobs.push(['MOCK', n]);
  if (inv.pasts < PLAN.PAST.initial) jobs.push(['PAST', inv.pasts + 1]);
  if (inv.practiceSets < PLAN.PRACTICE.initial) jobs.push(['PRACTICE', inv.practiceSets + 1]);
  if (topUp && !jobs.length) {
    if (inv.mocks < PLAN.MOCK.max && old(inv.lastMock, PLAN.MOCK.topUpEvery)) jobs.push(['MOCK', inv.mocks + 1]);
    if (inv.pasts < PLAN.PAST.max && old(inv.lastPast, PLAN.PAST.topUpEvery)) jobs.push(['PAST', inv.pasts + 1]);
    if (inv.practiceSets < PLAN.PRACTICE.max && old(inv.lastPractice, PLAN.PRACTICE.topUpEvery)) jobs.push(['PRACTICE', inv.practiceSets + 1]);
  }
  return jobs;
}

const keyOf = (ctx) => `${ctx.kind}:${ctx.id}`;

// Starts writing whatever is missing for a course, in the background. Returns at once.
async function kick(ctx) {
  const key = keyOf(ctx);
  if (inFlight.has(key)) return 'generating';
  // Finished recently: nothing to ask the database about (this runs on every dashboard load).
  if (ctx.readyAt && Date.now() - ctx.readyAt.getTime() < 7 * DAY) return 'ready';
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
    const [rows, authorId, semester] = await Promise.all([
      prisma.enrollment.findMany({ where: { studentId: user.id }, select: { course: { select: { id: true, code: true, title: true, level: true, practiceReadyAt: true, department: { select: { name: true, schoolId: true } } } } } }),
      schoolAuthor(user.schoolId),
      prisma.semester.findFirst({ where: { schoolId: user.schoolId, isCurrent: true }, select: { id: true } }),
    ]);
    if (authorId) for (const { course: c } of rows) {
      if (c.department.schoolId !== user.schoolId) continue;
      out.push({ kind: 'school', id: c.id, code: c.code, title: c.title, level: c.level, department: c.department.name, authorId, semesterId: semester && semester.id, ready: !!c.practiceReadyAt, readyAt: c.practiceReadyAt });
    }
  }
  const own = await prisma.individualCourse.findMany({ where: { studentId: user.id } });
  for (const c of own) out.push({ kind: 'self', id: c.id, title: c.title, authorId: user.id, ready: !!c.practiceReadyAt, readyAt: c.practiceReadyAt });
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

module.exports = { ensureForStudent, statusForStudent, kick, contextsFor, PLAN };
