const express = require('express');
const prisma = require('../db');
const { requireAuth, requireRole } = require('../auth');
const { notify } = require('../services/notification.service');

// Final-year Project & Defense, the way Nigerian higher institutions run it:
//   1. the student proposes a topic and the supervisor approves it (or sends it back);
//   2. the project is written chapter by chapter (1 Introduction, 2 Literature Review, 3 Methodology, 4 Results and
//      Discussion, 5 Summary, Conclusion and Recommendations, plus References and Appendices); the supervisor reviews each
//      one: approved, or sent back with corrections, and the student resubmits;
//   3. when chapters 1-5 are approved the supervisor clears the project for defense;
//   4. the defense is scheduled (date, venue, panel), held, and marked: the panel scores it, the verdict is Passed,
//      Passed with corrections, Re-present, or Failed;
//   5. after corrections the supervisor signs the project off; the final mark is the supervisor's assessment (40) plus the
//      defense panel's (60), graded A-F on the Nigerian scale.
// It works the same for a school's lecturers and students and for an independent lecturer and their students.
const router = express.Router();
router.use(requireAuth);

const CHAPTERS = [
  { n: 1, title: 'Chapter One: Introduction' },
  { n: 2, title: 'Chapter Two: Literature Review' },
  { n: 3, title: 'Chapter Three: Research Methodology' },
  { n: 4, title: 'Chapter Four: Results and Discussion' },
  { n: 5, title: 'Chapter Five: Summary, Conclusion and Recommendations' },
  { n: 6, title: 'References and Appendices' },
];
const CORE = [1, 2, 3, 4, 5];                                       // the chapters that must be approved before a defense
const VERDICTS = ['PASSED', 'PASSED_WITH_CORRECTIONS', 'REPRESENT', 'FAILED'];
const clean = (v, n) => String(v == null ? '' : v).trim().slice(0, n);
const gradeOf = (t) => (t >= 70 ? 'A' : t >= 60 ? 'B' : t >= 50 ? 'C' : t >= 45 ? 'D' : t >= 40 ? 'E' : 'F');

const present = (p, chapters, defense, extra = {}) => ({
  id: p.id, title: p.title, abstract: p.abstract, session: p.session, status: p.status, topicNote: p.topicNote,
  supervisorId: p.supervisorId, supervisorScore: p.supervisorScore, finalScore: p.finalScore, grade: p.finalScore == null ? null : gradeOf(p.finalScore),
  createdAt: p.createdAt, updatedAt: p.updatedAt,
  chapters: CHAPTERS.map((c) => {
    const row = chapters.find((x) => x.number === c.n);
    return { number: c.n, title: c.title, status: row ? row.status : 'NOT_STARTED', content: row ? row.content : '', fileUrl: row ? row.fileUrl : '', feedback: row ? row.feedback : '', version: row ? row.version : 0, submittedAt: row ? row.submittedAt : null, reviewedAt: row ? row.reviewedAt : null };
  }),
  defense: defense ? { kind: defense.kind, scheduledAt: defense.scheduledAt, venue: defense.venue, panel: defense.panel, status: defense.status, presentation: defense.presentation, mastery: defense.mastery, questions: defense.questions, documentation: defense.documentation, panelTotal: defense.panelTotal, verdict: defense.verdict, corrections: defense.corrections, correctionsDue: defense.correctionsDue, remarks: defense.remarks } : null,
  ...extra,
});
async function load(id) {
  const p = await prisma.project.findUnique({ where: { id } });
  if (!p) return null;
  const [chapters, defense] = await Promise.all([prisma.projectChapter.findMany({ where: { projectId: id } }), prisma.projectDefense.findUnique({ where: { projectId: id } })]);
  return { p, chapters, defense };
}
const nameOf = async (id) => { const u = id ? await prisma.user.findUnique({ where: { id }, select: { fullName: true } }) : null; return u ? u.fullName : null; };

// ── the student ─────────────────────────────────────────────────────────
router.get('/projects/supervisors', requireRole('STUDENT'), async (req, res) => {
  if (!req.user.schoolId) return res.json({ supervisors: [] });
  const rows = await prisma.user.findMany({ where: { schoolId: req.user.schoolId, role: 'LECTURER', status: 'ACTIVE' }, orderBy: { fullName: 'asc' }, select: { id: true, fullName: true } });
  res.json({ supervisors: rows });
});

router.get('/projects/mine', requireRole('STUDENT'), async (req, res) => {
  const p = await prisma.project.findFirst({ where: { studentId: req.user.id }, orderBy: { createdAt: 'desc' } });
  if (!p) return res.json({ project: null, chapters: CHAPTERS });
  const d = await load(p.id);
  res.json({ project: present(d.p, d.chapters, d.defense, { supervisorName: await nameOf(p.supervisorId) }) });
});

router.post('/projects', requireRole('STUDENT'), async (req, res) => {
  if (!req.user.schoolId) return res.status(403).json({ error: 'Project and Defense is for students who have a lecturer or school supervising them.' });
  const open = await prisma.project.findFirst({ where: { studentId: req.user.id, status: { not: 'TOPIC_REJECTED' } } });
  if (open) return res.status(409).json({ error: 'You already have a project.' });
  const title = clean(req.body.title, 200), abstract = clean(req.body.abstract, 3000);
  if (title.length < 8) return res.status(400).json({ error: 'Give your project topic in full (at least 8 characters).' });
  if (abstract.length < 20) return res.status(400).json({ error: 'Add a short description of what the project is about and what it will do.' });
  let supervisorId = clean(req.body.supervisorId, 80);
  const lecturers = await prisma.user.findMany({ where: { schoolId: req.user.schoolId, role: 'LECTURER', status: 'ACTIVE' }, select: { id: true } });
  if (!supervisorId && lecturers.length === 1) supervisorId = lecturers[0].id;               // an independent lecturer's class has one lecturer
  if (!supervisorId || !lecturers.some((l) => l.id === supervisorId)) return res.status(400).json({ error: 'Choose your supervisor.' });
  const p = await prisma.project.create({ data: { studentId: req.user.id, schoolId: req.user.schoolId, supervisorId, title, abstract, session: clean(req.body.session, 20) || null, status: 'PROPOSED' } });
  notify(supervisorId, 'New project topic to approve', req.user.fullName + ' proposed: ' + title, 'lect-projects').catch(() => {});
  res.status(201).json({ project: present(p, [], null) });
});

// the student reworks a topic the supervisor sent back
router.patch('/projects/mine', requireRole('STUDENT'), async (req, res) => {
  const p = await prisma.project.findFirst({ where: { studentId: req.user.id }, orderBy: { createdAt: 'desc' } });
  if (!p) return res.status(404).json({ error: 'You have no project yet.' });
  if (!['PROPOSED', 'TOPIC_REVISE', 'TOPIC_REJECTED'].includes(p.status)) return res.status(409).json({ error: 'The topic is already approved.' });
  const title = clean(req.body.title, 200) || p.title, abstract = clean(req.body.abstract, 3000) || p.abstract;
  const up = await prisma.project.update({ where: { id: p.id }, data: { title, abstract, status: 'PROPOSED' } });
  notify(p.supervisorId, 'Project topic updated', req.user.fullName + ' reworked the topic: ' + title, 'lect-projects').catch(() => {});
  res.json({ project: present(up, [], null) });
});

// save a chapter (a draft) or hand it in to the supervisor
router.put('/projects/mine/chapters/:n', requireRole('STUDENT'), async (req, res) => {
  const n = parseInt(req.params.n, 10);
  if (!CHAPTERS.some((c) => c.n === n)) return res.status(404).json({ error: 'No such chapter.' });
  const p = await prisma.project.findFirst({ where: { studentId: req.user.id }, orderBy: { createdAt: 'desc' } });
  if (!p) return res.status(404).json({ error: 'You have no project yet.' });
  if (['PROPOSED', 'TOPIC_REVISE', 'TOPIC_REJECTED'].includes(p.status)) return res.status(409).json({ error: 'Wait for your supervisor to approve the topic before you write the chapters.' });
  if (['DEFENSE_SCHEDULED', 'DEFENDED', 'COMPLETED'].includes(p.status) && n <= 5 && p.status !== 'DEFENDED') return res.status(409).json({ error: 'The project is cleared for defense; the chapters are locked.' });
  const existing = await prisma.projectChapter.findUnique({ where: { projectId_number: { projectId: p.id, number: n } } });
  if (existing && existing.status === 'APPROVED') return res.status(409).json({ error: 'This chapter is already approved.' });
  const content = clean(req.body.content, 60000), fileUrl = clean(req.body.fileUrl, 500);
  if (!content && !fileUrl) return res.status(400).json({ error: 'Write the chapter, or add a link to the file.' });
  const submit = req.body.submit === true;
  const data = { content, fileUrl, status: submit ? 'SUBMITTED' : 'DRAFT', ...(submit ? { submittedAt: new Date(), version: (existing ? existing.version : 0) + 1 } : {}) };
  const row = existing
    ? await prisma.projectChapter.update({ where: { id: existing.id }, data })
    : await prisma.projectChapter.create({ data: { projectId: p.id, number: n, title: CHAPTERS.find((c) => c.n === n).title, ...data, version: submit ? 1 : 0 } });
  if (submit && p.status === 'TOPIC_APPROVED') await prisma.project.update({ where: { id: p.id }, data: { status: 'IN_PROGRESS' } });
  if (submit) notify(p.supervisorId, 'A chapter was handed in', req.user.fullName + ' submitted ' + row.title, 'lect-projects').catch(() => {});
  const d = await load(p.id);
  res.json({ project: present(d.p, d.chapters, d.defense, { supervisorName: await nameOf(p.supervisorId) }) });
});

// ── the supervisor (a school lecturer or an independent lecturer) ───────
const mine = (req) => ({ supervisorId: req.user.id });
router.get('/projects/supervised', requireRole('LECTURER'), async (req, res) => {
  const rows = await prisma.project.findMany({ where: mine(req), orderBy: { updatedAt: 'desc' } });
  const students = await prisma.user.findMany({ where: { id: { in: rows.map((r) => r.studentId) } }, select: { id: true, fullName: true, matricNumber: true, courseOfStudy: true, attendedDepartment: true, yearOfStudy: true } });
  const waiting = await prisma.projectChapter.findMany({ where: { projectId: { in: rows.map((r) => r.id) }, status: 'SUBMITTED' }, select: { projectId: true } });
  res.json({ projects: rows.map((p) => { const s = students.find((x) => x.id === p.studentId) || {}; return { id: p.id, title: p.title, status: p.status, session: p.session, studentName: s.fullName, matricNumber: s.matricNumber, programme: s.courseOfStudy || s.attendedDepartment || '', level: s.yearOfStudy ? s.yearOfStudy * 100 + 'L' : '', chaptersWaiting: waiting.filter((w) => w.projectId === p.id).length, finalScore: p.finalScore, grade: p.finalScore == null ? null : gradeOf(p.finalScore) }; }) });
});

async function ownProject(req, res) {
  const d = await load(req.params.id);
  if (!d || d.p.supervisorId !== req.user.id) { res.status(404).json({ error: 'Project not found.' }); return null; }
  return d;
}
const reply = async (res, id, extra) => { const d = await load(id); const s = await prisma.user.findUnique({ where: { id: d.p.studentId }, select: { fullName: true, matricNumber: true, courseOfStudy: true, attendedDepartment: true, yearOfStudy: true } }); res.json({ project: present(d.p, d.chapters, d.defense, { student: s, ...(extra || {}) }) }); };

router.get('/projects/:id', requireRole('LECTURER'), async (req, res) => { const d = await ownProject(req, res); if (d) await reply(res, d.p.id); });

router.post('/projects/:id/topic', requireRole('LECTURER'), async (req, res) => {
  const d = await ownProject(req, res); if (!d) return;
  const decision = String(req.body.decision || '');
  const note = clean(req.body.note, 1000);
  if (!['APPROVE', 'REVISE', 'REJECT'].includes(decision)) return res.status(400).json({ error: 'Choose approve, send back, or reject.' });
  if (decision !== 'APPROVE' && !note) return res.status(400).json({ error: 'Say why, so the student knows what to change.' });
  if (!['PROPOSED', 'TOPIC_REVISE'].includes(d.p.status)) return res.status(409).json({ error: 'The topic has already been decided.' });
  const status = decision === 'APPROVE' ? 'TOPIC_APPROVED' : decision === 'REVISE' ? 'TOPIC_REVISE' : 'TOPIC_REJECTED';
  await prisma.project.update({ where: { id: d.p.id }, data: { status, topicNote: note || null } });
  notify(d.p.studentId, decision === 'APPROVE' ? 'Your project topic is approved' : 'Your project topic needs attention', (decision === 'APPROVE' ? 'You can start writing Chapter One. ' : '') + (note || ''), 'my-project').catch(() => {});
  await reply(res, d.p.id);
});

router.post('/projects/:id/chapters/:n/review', requireRole('LECTURER'), async (req, res) => {
  const d = await ownProject(req, res); if (!d) return;
  const n = parseInt(req.params.n, 10);
  const ch = d.chapters.find((c) => c.number === n);
  if (!ch || ch.status !== 'SUBMITTED') return res.status(409).json({ error: 'That chapter is not waiting for review.' });
  const decision = String(req.body.decision || ''), feedback = clean(req.body.feedback, 4000);
  if (!['APPROVE', 'CORRECTION'].includes(decision)) return res.status(400).json({ error: 'Approve the chapter or send it back for correction.' });
  if (decision === 'CORRECTION' && !feedback) return res.status(400).json({ error: 'Write what the student must correct.' });
  await prisma.projectChapter.update({ where: { id: ch.id }, data: { status: decision === 'APPROVE' ? 'APPROVED' : 'CORRECTION', feedback: feedback || null, reviewedAt: new Date() } });
  notify(d.p.studentId, ch.title + (decision === 'APPROVE' ? ' approved' : ': corrections needed'), feedback || 'Your supervisor approved this chapter.', 'my-project').catch(() => {});
  await reply(res, d.p.id);
});

// all five core chapters approved: the supervisor clears the project for defense, with the supervisor's own assessment (out of 40)
router.post('/projects/:id/clear', requireRole('LECTURER'), async (req, res) => {
  const d = await ownProject(req, res); if (!d) return;
  if (!['TOPIC_APPROVED', 'IN_PROGRESS'].includes(d.p.status)) return res.status(409).json({ error: 'This project cannot be cleared now.' });
  if (!CORE.every((n) => d.chapters.some((c) => c.number === n && c.status === 'APPROVED'))) return res.status(409).json({ error: 'Approve Chapters One to Five first.' });
  const score = parseInt(req.body.supervisorScore, 10);
  if (!Number.isInteger(score) || score < 0 || score > 40) return res.status(400).json({ error: 'Enter your assessment of the student\'s work as a mark out of 40.' });
  await prisma.project.update({ where: { id: d.p.id }, data: { status: 'READY_FOR_DEFENSE', supervisorScore: score } });
  notify(d.p.studentId, 'Cleared for defense', 'Your supervisor has cleared your project for defense. The date will be announced.', 'my-project').catch(() => {});
  await reply(res, d.p.id);
});

router.post('/projects/:id/defense', requireRole('LECTURER'), async (req, res) => {
  const d = await ownProject(req, res); if (!d) return;
  if (!['READY_FOR_DEFENSE', 'DEFENSE_SCHEDULED'].includes(d.p.status)) return res.status(409).json({ error: 'Clear the project for defense first.' });
  const when = new Date(req.body.scheduledAt);
  if (isNaN(when) || when.getTime() < Date.now() - 3600 * 1000) return res.status(400).json({ error: 'Choose a date and time in the future.' });
  const data = { kind: req.body.kind === 'INTERNAL' ? 'INTERNAL' : 'FINAL', scheduledAt: when, venue: clean(req.body.venue, 200) || 'To be announced', panel: clean(req.body.panel, 500), status: 'SCHEDULED' };
  if (d.defense) await prisma.projectDefense.update({ where: { projectId: d.p.id }, data }); else await prisma.projectDefense.create({ data: { projectId: d.p.id, ...data } });
  await prisma.project.update({ where: { id: d.p.id }, data: { status: 'DEFENSE_SCHEDULED' } });
  notify(d.p.studentId, 'Your project defense is scheduled', when.toLocaleString('en-NG') + ' · ' + data.venue + (data.panel ? ' · Panel: ' + data.panel : ''), 'my-project').catch(() => {});
  await reply(res, d.p.id);
});

// after the defense: the panel's marks (presentation 20, mastery of the work 20, answers to questions 15, documentation 5 = 60) and the verdict
router.post('/projects/:id/defense/result', requireRole('LECTURER'), async (req, res) => {
  const d = await ownProject(req, res); if (!d) return;
  if (d.p.status !== 'DEFENSE_SCHEDULED' || !d.defense) return res.status(409).json({ error: 'No defense is scheduled for this project.' });
  const lim = { presentation: 20, mastery: 20, questions: 15, documentation: 5 };
  const scores = {};
  for (const k of Object.keys(lim)) {
    const v = parseInt(req.body[k], 10);
    if (!Number.isInteger(v) || v < 0 || v > lim[k]) return res.status(400).json({ error: `${k[0].toUpperCase() + k.slice(1)} must be a mark from 0 to ${lim[k]}.` });
    scores[k] = v;
  }
  const verdict = String(req.body.verdict || '');
  if (!VERDICTS.includes(verdict)) return res.status(400).json({ error: 'Choose the panel\'s verdict.' });
  const corrections = clean(req.body.corrections, 3000);
  if ((verdict === 'PASSED_WITH_CORRECTIONS' || verdict === 'REPRESENT') && !corrections) return res.status(400).json({ error: 'List the corrections the student must make.' });
  const panelTotal = scores.presentation + scores.mastery + scores.questions + scores.documentation;
  const finalScore = (d.p.supervisorScore || 0) + panelTotal;
  const due = req.body.correctionsDue ? new Date(req.body.correctionsDue) : null;
  await prisma.projectDefense.update({ where: { projectId: d.p.id }, data: { ...scores, panelTotal, verdict, corrections: corrections || null, correctionsDue: due && !isNaN(due) ? due : null, remarks: clean(req.body.remarks, 1000) || null, status: 'HELD' } });
  const status = verdict === 'PASSED' ? 'COMPLETED' : verdict === 'FAILED' ? 'DEFENDED' : 'DEFENDED';
  await prisma.project.update({ where: { id: d.p.id }, data: { status, finalScore: verdict === 'REPRESENT' ? null : finalScore } });
  notify(d.p.studentId, 'Your defense result is ready', ({ PASSED: 'Passed', PASSED_WITH_CORRECTIONS: 'Passed with corrections', REPRESENT: 'You are to re-present', FAILED: 'Not passed' })[verdict] + (verdict === 'REPRESENT' ? '' : ' · ' + finalScore + '/100 (' + gradeOf(finalScore) + ')'), 'my-project').catch(() => {});
  await reply(res, d.p.id);
});

// corrections made: the supervisor signs the project off
router.post('/projects/:id/complete', requireRole('LECTURER'), async (req, res) => {
  const d = await ownProject(req, res); if (!d) return;
  if (d.p.status !== 'DEFENDED' || !d.defense || d.defense.verdict !== 'PASSED_WITH_CORRECTIONS') return res.status(409).json({ error: 'Only a project that passed with corrections is signed off here.' });
  await prisma.project.update({ where: { id: d.p.id }, data: { status: 'COMPLETED' } });
  notify(d.p.studentId, 'Project signed off', 'Your supervisor has approved your corrections. Your project is complete.', 'my-project').catch(() => {});
  await reply(res, d.p.id);
});

// a student who must re-present is put back to be scheduled again
router.post('/projects/:id/represent', requireRole('LECTURER'), async (req, res) => {
  const d = await ownProject(req, res); if (!d) return;
  if (d.p.status !== 'DEFENDED' || !d.defense || d.defense.verdict !== 'REPRESENT') return res.status(409).json({ error: 'This project is not waiting to be re-presented.' });
  await prisma.project.update({ where: { id: d.p.id }, data: { status: 'READY_FOR_DEFENSE' } });
  await reply(res, d.p.id);
});

module.exports = router;
module.exports.CHAPTERS = CHAPTERS;
