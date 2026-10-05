const express = require('express');
const { requireAuth, requireRole } = require('../auth');
const practice = require('../services/practiceGen.service');

// The status of the mock exams, past questions and practice questions the system writes for each
// course on a student's dashboard. The CBT Mock, Past Questions and Practice screens call
// /ensure when they open (it starts anything missing, in the background) and then poll /status
// to show "preparing your questions…" until a course is ready.
const router = express.Router();
router.use(requireAuth, requireRole('STUDENT'));

router.post('/ensure', async (req, res) => {
  res.json({ courses: await practice.ensureForStudent(req.user) });
});

router.get('/status', async (req, res) => {
  res.json({ courses: await practice.statusForStudent(req.user) });
});

module.exports = router;
