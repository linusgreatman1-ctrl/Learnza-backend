const express = require('express');
const prisma = require('../db');
const { requireAuth, requireRole } = require('../auth');
const { notifyMany } = require('../services/notification.service');

// Elections inside one school. A lecturer can also run a class representative election for one of their
// own courses: only the students enrolled in that course stand and vote. The school admin sets one up (a student union / SUG election, or
// an election among lecturers), opens it, and watches the count; students and lecturers (whichever
// the election is for) vote once, in secret.
//
// "Secret" is built into the data, not just promised: ElectionVote says WHAT was chosen and which
// group (student or lecturer) chose it; ElectionVoter says WHO has voted. Nothing links the two,
// so even the admin sees totals and a turnout list, never who picked whom.
const router = express.Router();
router.use(requireAuth);

const KINDS = { STUDENT_SUG: { candidateRole: 'STUDENT', defaultVoters: 'STUDENTS' }, LECTURER: { candidateRole: 'LECTURER', defaultVoters: 'LECTURERS' }, CLASS_REP: { candidateRole: 'STUDENT', defaultVoters: 'STUDENTS' } };
const VOTERS = ['STUDENTS', 'LECTURERS', 'BOTH'];
const roleOkFor = (election, role) => (election.voters === 'BOTH' ? role === 'STUDENT' || role === 'LECTURER' : election.voters === 'STUDENTS' ? role === 'STUDENT' : role === 'LECTURER');
const clean = (v, n) => String(v == null ? '' : v).trim().slice(0, n);
const isLecturer = (req) => req.user.role === 'LECTURER';
const ownScope = (req) => (isLecturer(req) ? { createdById: req.user.id, kind: 'CLASS_REP' } : {});
// A lecturer may only run a class election for a course they teach, in their own school.
async function teachesCourse(req, courseId) {
  if (!courseId) return null;
  const row = await prisma.courseLecturer.findFirst({ where: { lecturerId: req.user.id, courseId }, include: { course: { include: { department: { select: { schoolId: true } } } } } });
  return row && row.course && row.course.department && row.course.department.schoolId === req.user.schoolId ? row.course : null;
}
// The elections in `list` this person may vote in: the right kind of person and, for a class election,
// a student enrolled in that course.
async function eligibleFor(user, list) {
  const byRole = list.filter((e) => roleOkFor(e, user.role));
  const classOnes = byRole.filter((e) => e.kind === 'CLASS_REP');
  if (!classOnes.length) return byRole;
  const mineCourses = await prisma.enrollment.findMany({ where: { studentId: user.id, courseId: { in: classOnes.map((e) => e.courseId) } }, select: { courseId: true } });
  const enrolled = new Set(mineCourses.map((c) => c.courseId));
  return byRole.filter((e) => e.kind !== 'CLASS_REP' || enrolled.has(e.courseId));
}
const eligible1 = async (user, e) => (await eligibleFor(user, [e])).length === 1;

// DRAFT / UPCOMING (opened, but its start time has not come) / OPEN / CLOSED. An election whose
// closing time has passed is closed even if nobody pressed the button.
function stateOf(e) {
  const now = new Date();
  if (e.status === 'DRAFT') return 'DRAFT';
  if (e.status === 'CLOSED' || (e.closesAt && e.closesAt <= now)) return 'CLOSED';
  if (e.opensAt && e.opensAt > now) return 'UPCOMING';
  return 'OPEN';
}

const admin = [requireRole('ADMIN')];
const voter = [requireRole('STUDENT', 'LECTURER')];
const mine = (req) => ({ schoolId: req.user.schoolId });

function requireSchool(req, res, next) {
  if (!req.user.schoolId) return res.status(404).json({ error: 'Elections belong to a school.' });
  next();
}
router.use(requireSchool);

// ---- shared: the tally ---------------------------------------------------------------------
async function tally(election) {
  const [votes, positions] = await Promise.all([
    prisma.electionVote.groupBy({ by: ['positionId', 'candidateId', 'voterRole'], where: { electionId: election.id }, _count: { _all: true } }),
    prisma.electionPosition.findMany({ where: { electionId: election.id }, orderBy: { order: 'asc' }, include: { candidates: { orderBy: { name: 'asc' } } } }),
  ]);
  return positions.map((p) => {
    const rows = p.candidates.map((c) => {
      const mineVotes = votes.filter((v) => v.candidateId === c.id);
      const students = mineVotes.filter((v) => v.voterRole === 'STUDENT').reduce((a, v) => a + v._count._all, 0);
      const lecturers = mineVotes.filter((v) => v.voterRole === 'LECTURER').reduce((a, v) => a + v._count._all, 0);
      return { id: c.id, name: c.name, manifesto: c.manifesto, photoUrl: c.photoUrl, votes: students + lecturers, byStudents: students, byLecturers: lecturers };
    });
    const total = rows.reduce((a, r) => a + r.votes, 0);
    const top = Math.max(0, ...rows.map((r) => r.votes));
    return {
      id: p.id, title: p.title, totalVotes: total,
      tied: top > 0 && rows.filter((r) => r.votes === top).length > 1,
      candidates: rows.map((r) => ({ ...r, percent: total ? Math.round((r.votes / total) * 100) : 0, leading: top > 0 && r.votes === top })).sort((a, b) => b.votes - a.votes),
    };
  });
}

async function turnout(election) {
  const roles = [];
  if (election.voters !== 'LECTURERS') roles.push('STUDENT');
  if (election.voters !== 'STUDENTS') roles.push('LECTURER');
  const out = {};
  for (const role of roles) {
    const [eligible, voted] = await Promise.all([
      election.kind === 'CLASS_REP'
        ? prisma.enrollment.count({ where: { courseId: election.courseId, student: { status: 'ACTIVE', schoolId: election.schoolId } } })
        : prisma.user.count({ where: { schoolId: election.schoolId, role, status: 'ACTIVE' } }),
      prisma.electionVoter.count({ where: { electionId: election.id, voterRole: role } }),
    ]);
    out[role === 'STUDENT' ? 'students' : 'lecturers'] = { eligible, voted };
  }
  return out;
}

// ---- admin ---------------------------------------------------------------------------------
async function validateBody(req) {
  const title = clean(req.body.title, 120);
  const lecturer = isLecturer(req);
  const kind = lecturer ? 'CLASS_REP' : String(req.body.kind || '');
  if (!title) return { error: 'Give the election a title.' };
  if (!KINDS[kind] || (!lecturer && kind === 'CLASS_REP')) return { error: 'Choose a student union (SUG) election or a lecturers\' election.' };
  let courseId = null;
  if (lecturer) {
    const course = await teachesCourse(req, String(req.body.courseId || ''));
    if (!course) return { error: 'Choose one of your own courses.' };
    courseId = course.id;
  }
  const voters = lecturer ? 'STUDENTS' : VOTERS.includes(req.body.voters) ? req.body.voters : KINDS[kind].defaultVoters;
  const positions = Array.isArray(req.body.positions) ? req.body.positions : [];
  if (!positions.length || positions.length > 12) return { error: 'Add between 1 and 12 positions (e.g. President, Secretary).' };
  const opensAt = req.body.opensAt ? new Date(req.body.opensAt) : null;
  const closesAt = req.body.closesAt ? new Date(req.body.closesAt) : null;
  if ((opensAt && isNaN(opensAt)) || (closesAt && isNaN(closesAt))) return { error: 'That date does not look right.' };
  if (opensAt && closesAt && closesAt <= opensAt) return { error: 'The closing time must be after the opening time.' };

  const candidateRole = KINDS[kind].candidateRole;
  const shaped = [];
  const usedUsers = new Set();
  for (const [i, p] of positions.entries()) {
    const ptitle = clean(p.title, 80);
    const cands = Array.isArray(p.candidates) ? p.candidates : [];
    if (!ptitle) return { error: `Position ${i + 1} needs a title.` };
    if (!cands.length || cands.length > 15) return { error: `"${ptitle}" needs between 1 and 15 candidates.` };
    const list = [];
    for (const c of cands) {
      let name = clean(c.name, 100);
      let photoUrl = null;
      let userId = null;
      if (c.userId) {
        const u = await prisma.user.findFirst({ where: { id: String(c.userId), schoolId: req.user.schoolId, role: candidateRole, status: 'ACTIVE', ...(courseId ? { enrollments: { some: { courseId } } } : {}) }, select: { id: true, fullName: true, avatarUrl: true } });
        if (!u) return { error: courseId ? `A candidate for "${ptitle}" is not enrolled in that course.` : `A candidate for "${ptitle}" is not ${candidateRole === 'STUDENT' ? 'a student' : 'a lecturer'} of your school.` };
        userId = u.id; name = name || u.fullName; photoUrl = u.avatarUrl;
        if (usedUsers.has(`${i}:${u.id}`)) return { error: `${u.fullName} is listed twice for "${ptitle}".` };
        usedUsers.add(`${i}:${u.id}`);
      }
      if (!name) return { error: `Every candidate for "${ptitle}" needs a name.` };
      list.push({ userId, name, manifesto: clean(c.manifesto, 600) || null, photoUrl });
    }
    shaped.push({ title: ptitle, order: i, candidates: list });
  }
  return { data: { title, description: clean(req.body.description, 600) || null, kind, courseId, voters, opensAt, closesAt, resultsVisible: !!req.body.resultsVisible }, positions: shaped };
}

const summary = (e, extra = {}) => ({ id: e.id, title: e.title, description: e.description, kind: e.kind, courseId: e.courseId || null, courseName: e.course ? e.course.code + ' ' + e.course.title : null, voters: e.voters, status: e.status, state: stateOf(e), opensAt: e.opensAt, closesAt: e.closesAt, resultsVisible: e.resultsVisible, createdAt: e.createdAt, ...extra });

// Both the school admin and a lecturer (for class representative elections) manage elections the same way;
// `ownScope` keeps a lecturer to their own class elections, and the admin never sees a lecturer's draft.
const manager = [requireRole('ADMIN', 'LECTURER')];
const adminOnly = [requireRole('ADMIN')];
const lecturerOnly = [requireRole('LECTURER')];

async function manageList(req, res) {
  const where = isLecturer(req) ? { ...mine(req), ...ownScope(req) } : { ...mine(req), OR: [{ kind: { not: 'CLASS_REP' } }, { status: { not: 'DRAFT' } }] };
  const list = await prisma.election.findMany({ where, orderBy: { createdAt: 'desc' }, include: { course: { select: { code: true, title: true } }, _count: { select: { positions: true, ballots: true } } } });
  res.json({ elections: list.map((e) => summary(e, { positions: e._count.positions, ballots: e._count.ballots })) });
}

// Who could stand: the school's active students or lecturers, matching the search.
async function candidatesSearch(req, res) {
  const lecturer = isLecturer(req);
  const kind = KINDS[lecturer ? 'CLASS_REP' : String(req.query.kind)];
  if (!kind || (!lecturer && String(req.query.kind) === 'CLASS_REP')) return res.status(400).json({ error: 'Say which kind of election.' });
  const q = clean(req.query.q, 60);
  const where = { schoolId: req.user.schoolId, role: kind.candidateRole, status: 'ACTIVE' };
  if (lecturer) {
    const course = await teachesCourse(req, String(req.query.courseId || ''));
    if (!course) return res.status(403).json({ error: 'Choose one of your own courses first.' });
    where.enrollments = { some: { courseId: course.id } };
  }
  if (q) where.OR = [{ fullName: { contains: q, mode: 'insensitive' } }, { matricNumber: { contains: q, mode: 'insensitive' } }, { staffId: { contains: q, mode: 'insensitive' } }];
  const users = await prisma.user.findMany({ where, orderBy: { fullName: 'asc' }, take: 15, select: { id: true, fullName: true, matricNumber: true, staffId: true, yearOfStudy: true, avatarUrl: true, department: { select: { name: true } } } });
  res.json({ people: users.map((u) => ({ id: u.id, name: u.fullName, detail: [u.matricNumber || u.staffId, u.department && u.department.name, u.yearOfStudy ? u.yearOfStudy * 100 + 'L' : null].filter(Boolean).join(' · '), avatarUrl: u.avatarUrl })) });
}

// The courses a lecturer may run a class election for.
async function myCourses(req, res) {
  const rows = await prisma.courseLecturer.findMany({ where: { lecturerId: req.user.id }, include: { course: { include: { department: { select: { schoolId: true, name: true } }, _count: { select: { enrollments: true } } } } } });
  const courses = rows.filter((r) => r.course.department.schoolId === req.user.schoolId)
    .map((r) => ({ id: r.course.id, code: r.course.code, title: r.course.title, level: r.course.level, department: r.course.department.name, students: r.course._count.enrollments }))
    .sort((a, b) => a.code.localeCompare(b.code));
  res.json({ courses });
}

async function createElection(req, res) {
  const v = await validateBody(req);
  if (v.error) return res.status(400).json({ error: v.error });
  const election = await prisma.election.create({
    data: { ...v.data, schoolId: req.user.schoolId, createdById: req.user.id, positions: { create: v.positions.map((p) => ({ title: p.title, order: p.order, candidates: { create: p.candidates } })) } },
  });
  res.status(201).json({ election: summary(election) });
}

async function myElection(req, res) {
  const e = await prisma.election.findFirst({ where: { id: req.params.id, schoolId: req.user.schoolId, ...ownScope(req) } });
  if (!e) res.status(404).json({ error: 'Election not found' });
  return e;
}

async function manageOne(req, res) {
  const e = await myElection(req, res);
  if (!e) return;
  const [positions, course] = await Promise.all([
    prisma.electionPosition.findMany({ where: { electionId: e.id }, orderBy: { order: 'asc' }, include: { candidates: { orderBy: { name: 'asc' } } } }),
    e.courseId ? prisma.course.findUnique({ where: { id: e.courseId }, select: { code: true, title: true } }) : null,
  ]);
  res.json({ election: summary({ ...e, course }), positions });
}

// Edit a draft: positions and candidates are replaced wholesale.
async function updateElection(req, res) {
  const e = await myElection(req, res);
  if (!e) return;
  if (e.status !== 'DRAFT') return res.status(409).json({ error: 'An election that has been opened can no longer be edited.' });
  const v = await validateBody(req);
  if (v.error) return res.status(400).json({ error: v.error });
  await prisma.$transaction([
    prisma.electionPosition.deleteMany({ where: { electionId: e.id } }),
    prisma.election.update({ where: { id: e.id }, data: { ...v.data, positions: { create: v.positions.map((p) => ({ title: p.title, order: p.order, candidates: { create: p.candidates } })) } } }),
  ]);
  res.json({ ok: true });
}

async function openElection(req, res) {
  const e = await myElection(req, res);
  if (!e) return;
  if (e.status !== 'DRAFT') return res.status(409).json({ error: 'This election is already open or closed.' });
  const empty = await prisma.electionPosition.count({ where: { electionId: e.id, candidates: { none: {} } } });
  if (empty) return res.status(400).json({ error: 'Every position needs at least one candidate.' });
  if (e.closesAt && e.closesAt <= new Date()) return res.status(400).json({ error: 'The closing time has already passed. Edit the election first.' });
  await prisma.election.update({ where: { id: e.id }, data: { status: 'OPEN', openedAt: new Date() } });
  const roles = e.voters === 'BOTH' ? ['STUDENT', 'LECTURER'] : [e.voters === 'STUDENTS' ? 'STUDENT' : 'LECTURER'];
  const people = await prisma.user.findMany({ where: { schoolId: e.schoolId, role: { in: roles }, status: 'ACTIVE', ...(e.kind === 'CLASS_REP' ? { enrollments: { some: { courseId: e.courseId } } } : {}) }, select: { id: true } });
  const ids = people.map((p) => p.id);
  for (let i = 0; i < ids.length; i += 100) await notifyMany(ids.slice(i, i + 100), 'Voting is open', `${e.title} — cast your vote.`, 'elections').catch(() => {});
  res.json({ ok: true, notified: ids.length });
}

async function closeElection(req, res) {
  const e = await myElection(req, res);
  if (!e) return;
  if (e.status !== 'OPEN') return res.status(409).json({ error: 'Only an open election can be closed.' });
  await prisma.election.update({ where: { id: e.id }, data: { status: 'CLOSED', closedAt: new Date() } });
  res.json({ ok: true });
}

async function resultsVisibleSet(req, res) {
  const e = await myElection(req, res);
  if (!e) return;
  await prisma.election.update({ where: { id: e.id }, data: { resultsVisible: !!req.body.visible } });
  res.json({ ok: true });
}

async function removeElection(req, res) {
  const e = await myElection(req, res);
  if (!e) return;
  if (e.status !== 'DRAFT') return res.status(409).json({ error: 'Only an election that has not been opened can be deleted. Close it instead and keep the record.' });
  await prisma.election.delete({ where: { id: e.id } });
  res.json({ ok: true });
}

// Everything the admin needs to see: each candidate's votes (with the student/lecturer split),
// who is leading, how many of those eligible have voted, and the list of people who HAVE voted.
async function manageResults(req, res) {
  const e = await myElection(req, res);
  if (!e) return;
  if (e.courseId) e.course = await prisma.course.findUnique({ where: { id: e.courseId }, select: { code: true, title: true } });
  const [positions, turn, roll] = await Promise.all([
    tally(e),
    turnout(e),
    prisma.electionVoter.findMany({ where: { electionId: e.id }, orderBy: { votedAt: 'desc' }, take: 1000 }),
  ]);
  const people = roll.length ? await prisma.user.findMany({ where: { id: { in: roll.map((r) => r.voterId) } }, select: { id: true, fullName: true, matricNumber: true, staffId: true } }) : [];
  const byId = new Map(people.map((p) => [p.id, p]));
  res.json({
    election: summary(e),
    positions,
    turnout: turn,
    voted: roll.map((r) => ({ name: byId.get(r.voterId) ? byId.get(r.voterId).fullName : 'Former member', idNumber: byId.get(r.voterId) ? (byId.get(r.voterId).matricNumber || byId.get(r.voterId).staffId) : null, role: r.voterRole, at: r.votedAt })),
  });
}

// the school admin
router.get('/manage', ...adminOnly, manageList);
router.get('/manage/candidates', ...adminOnly, candidatesSearch);       // before /manage/:id
router.post('/manage', ...adminOnly, createElection);
router.get('/manage/:id', ...adminOnly, manageOne);
router.put('/manage/:id', ...adminOnly, updateElection);
router.post('/manage/:id/open', ...adminOnly, openElection);
router.post('/manage/:id/close', ...adminOnly, closeElection);
router.post('/manage/:id/results-visible', ...adminOnly, resultsVisibleSet);
router.delete('/manage/:id', ...adminOnly, removeElection);
router.get('/manage/:id/results', ...adminOnly, manageResults);

// a lecturer's class representative election: the same steps, for their own courses only
router.get('/class/courses', ...lecturerOnly, myCourses);
router.get('/class/candidates', ...lecturerOnly, candidatesSearch);
router.get('/class', ...lecturerOnly, manageList);
router.post('/class', ...lecturerOnly, createElection);
router.get('/class/:id', ...lecturerOnly, manageOne);
router.put('/class/:id', ...lecturerOnly, updateElection);
router.post('/class/:id/open', ...lecturerOnly, openElection);
router.post('/class/:id/close', ...lecturerOnly, closeElection);
router.post('/class/:id/results-visible', ...lecturerOnly, resultsVisibleSet);
router.delete('/class/:id', ...lecturerOnly, removeElection);
router.get('/class/:id/results', ...lecturerOnly, manageResults);

// ---- voters --------------------------------------------------------------------------------
// How many elections are waiting on this person (the dashboard banner). Admins see how many are open.
router.get('/summary', async (req, res) => {
  const list = await prisma.election.findMany({ where: { schoolId: req.user.schoolId, status: 'OPEN' } });
  const open = list.filter((e) => stateOf(e) === 'OPEN');
  if (req.user.role === 'ADMIN') return res.json({ open: open.length, pending: 0 });
  const eligible = await eligibleFor(req.user, open);
  const voted = eligible.length ? await prisma.electionVoter.findMany({ where: { voterId: req.user.id, electionId: { in: eligible.map((e) => e.id) } }, select: { electionId: true } }) : [];
  const done = new Set(voted.map((v) => v.electionId));
  res.json({ open: eligible.length, pending: eligible.filter((e) => !done.has(e.id)).length });
});

router.get('/', ...voter, async (req, res) => {
  const list = await prisma.election.findMany({ where: { schoolId: req.user.schoolId, status: { in: ['OPEN', 'CLOSED'] } }, orderBy: { createdAt: 'desc' }, take: 50 });
  const mineList = await eligibleFor(req.user, list);
  const voted = mineList.length ? await prisma.electionVoter.findMany({ where: { voterId: req.user.id, electionId: { in: mineList.map((e) => e.id) } }, select: { electionId: true } }) : [];
  const done = new Set(voted.map((v) => v.electionId));
  res.json({ elections: mineList.map((e) => summary(e, { hasVoted: done.has(e.id) })) });
});

router.get('/:id', ...voter, async (req, res) => {
  const e = await myElection(req, res);
  if (!e) return;
  if (e.status === 'DRAFT' || !(await eligible1(req.user, e))) return res.status(404).json({ error: 'Election not found' });
  const state = stateOf(e);
  const [voted, positions] = await Promise.all([
    prisma.electionVoter.findUnique({ where: { electionId_voterId: { electionId: e.id, voterId: req.user.id } } }),
    prisma.electionPosition.findMany({ where: { electionId: e.id }, orderBy: { order: 'asc' }, include: { candidates: { orderBy: { name: 'asc' }, select: { id: true, name: true, manifesto: true, photoUrl: true } } } }),
  ]);
  const showResults = state === 'CLOSED' && e.resultsVisible;
  res.json({ election: summary(e, { hasVoted: !!voted }), positions, results: showResults ? await tally(e) : null });
});

router.post('/:id/vote', ...voter, async (req, res) => {
  const e = await myElection(req, res);
  if (!e) return;
  if (e.status === 'DRAFT' || !(await eligible1(req.user, e))) return res.status(404).json({ error: 'Election not found' });
  const state = stateOf(e);
  if (state === 'UPCOMING') return res.status(409).json({ error: 'Voting has not started yet.' });
  if (state !== 'OPEN') return res.status(409).json({ error: 'Voting is closed.' });
  const choices = Array.isArray(req.body.choices) ? req.body.choices : [];
  if (!choices.length) return res.status(400).json({ error: 'Pick at least one candidate.' });

  const positions = await prisma.electionPosition.findMany({ where: { electionId: e.id }, include: { candidates: { select: { id: true } } } });
  const seen = new Set();
  const rows = [];
  for (const c of choices) {
    const pos = positions.find((p) => p.id === String(c.positionId));
    if (!pos || !pos.candidates.some((x) => x.id === String(c.candidateId))) return res.status(400).json({ error: 'One of your choices is not on this ballot.' });
    if (seen.has(pos.id)) return res.status(400).json({ error: 'You can only choose one candidate for each position.' });
    seen.add(pos.id);
    rows.push({ electionId: e.id, positionId: pos.id, candidateId: String(c.candidateId), voterRole: req.user.role });
  }
  try {
    // The ballot paper is handed in once: the unique (election, voter) row is what prevents a
    // second vote, even from two devices at the same instant.
    await prisma.$transaction([
      prisma.electionVoter.create({ data: { electionId: e.id, voterId: req.user.id, voterRole: req.user.role } }),
      prisma.electionVote.createMany({ data: rows }),
    ]);
  } catch (err) {
    if (err.code === 'P2002') return res.status(409).json({ error: 'You have already voted in this election.' });
    throw err;
  }
  res.json({ ok: true, positionsVoted: rows.length });
});

// The owner's panel (routes/superInsights.js) reads elections across every school with these.
router.helpers = { stateOf, summary, tally, turnout };
router.handlers = { manageList, candidatesSearch, myCourses, createElection, manageOne, updateElection, openElection, closeElection, resultsVisibleSet, removeElection, manageResults };

module.exports = router;
