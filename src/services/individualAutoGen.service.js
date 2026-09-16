const prisma = require('../db');
const quizGen = require('./quizGen.service');

// Individual (non-school) learners have no lecturer to set assignments/tests/exams --
// the app plays that role instead, on a fixed schedule per self-directed course: a
// fresh assignment every day, a test every week, and a semester exam roughly once a
// term. Students never trigger this themselves (no "generate" button) -- it's ensured
// lazily whenever they open their dashboard or a course, so it's always caught up
// without needing a separate cron/worker process.
const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;
const SEMESTER_MS = 105 * DAY_MS; // ~15 weeks, one Nigerian academic semester

function startOfToday() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

// A failed generation attempt (AI provider quota/rate-limit hit, most likely) must not
// be retried on every single dashboard/course reload -- that would hammer the provider
// with the exact same request over and over and make an existing quota problem worse.
// This in-memory cooldown (per process, reset on redeploy) is enough to bound retries
// to a sane rate without needing a persisted "last attempted" column.
const RETRY_COOLDOWN_MS = 15 * 60 * 1000;
const lastAttemptAt = new Map();

async function generateOne(course, studentId, type) {
  const cooldownKey = `${course.id}:${type}`;
  const lastTry = lastAttemptAt.get(cooldownKey);
  if (lastTry && Date.now() - lastTry < RETRY_COOLDOWN_MS) return;
  lastAttemptAt.set(cooldownKey, Date.now());
  try {
    if (type === 'ASSIGNMENT') {
      const draft = await quizGen.generateAssignment({ courseTitle: course.title, topic: course.title });
      await prisma.assessment.create({
        data: {
          individualCourseId: course.id,
          authorId: studentId,
          title: draft.title || `${course.title} — Daily Assignment`,
          type: 'ASSIGNMENT',
          durationMin: 30,
          questions: {
            create: (draft.questions || []).map((q, i) => ({
              questionType: 'THEORY', text: q.text, modelAnswer: q.modelAnswer || null, order: i,
            })),
          },
        },
      });
    } else if (type === 'CA') {
      const draft = await quizGen.generateQuiz({ courseTitle: course.title, topic: course.title });
      await prisma.assessment.create({
        data: {
          individualCourseId: course.id,
          authorId: studentId,
          title: draft.title || `${course.title} — Weekly Test`,
          type: 'CA',
          durationMin: 15,
          questions: {
            create: (draft.questions || []).map((q, i) => ({
              questionType: 'OBJECTIVE', text: q.text, options: JSON.stringify(q.options), correctIndex: q.correctIndex, order: i,
            })),
          },
        },
      });
    } else if (type === 'SEMESTER_EXAM') {
      const draft = await quizGen.generateSemesterExam({ courseTitle: course.title, topic: course.title });
      await prisma.assessment.create({
        data: {
          individualCourseId: course.id,
          authorId: studentId,
          title: draft.title || `${course.title} — Semester Exam`,
          type: 'SEMESTER_EXAM',
          durationMin: 45,
          questions: {
            create: (draft.questions || []).map((q, i) => ({
              questionType: 'OBJECTIVE', text: q.text, options: JSON.stringify(q.options), correctIndex: q.correctIndex, order: i,
            })),
          },
        },
      });
    }
  } catch (err) {
    // Best-effort: a transient AI failure (or AI not configured) shouldn't break the
    // dashboard/course load -- it just tries again next time this runs.
    if (err.code !== 'AI_NOT_CONFIGURED') console.error(`Individual auto-gen (${type}) failed:`, err.message);
  }
}

async function ensureAutoContentForCourse(course, studentId) {
  const [lastAssignment, lastTest, lastExam] = await Promise.all([
    prisma.assessment.findFirst({ where: { individualCourseId: course.id, type: 'ASSIGNMENT' }, orderBy: { createdAt: 'desc' } }),
    prisma.assessment.findFirst({ where: { individualCourseId: course.id, type: 'CA' }, orderBy: { createdAt: 'desc' } }),
    prisma.assessment.findFirst({ where: { individualCourseId: course.id, type: 'SEMESTER_EXAM' }, orderBy: { createdAt: 'desc' } }),
  ]);

  const tasks = [];
  if (!lastAssignment || lastAssignment.createdAt < startOfToday()) tasks.push(generateOne(course, studentId, 'ASSIGNMENT'));
  if (!lastTest || Date.now() - lastTest.createdAt.getTime() > WEEK_MS) tasks.push(generateOne(course, studentId, 'CA'));
  if (!lastExam || Date.now() - lastExam.createdAt.getTime() > SEMESTER_MS) tasks.push(generateOne(course, studentId, 'SEMESTER_EXAM'));
  await Promise.allSettled(tasks);
}

// Sweeps every self-directed course a student owns.
async function ensureAutoContent(studentId) {
  const courses = await prisma.individualCourse.findMany({ where: { studentId } });
  await Promise.allSettled(courses.map((c) => ensureAutoContentForCourse(c, studentId)));
}

module.exports = { ensureAutoContent, ensureAutoContentForCourse };
