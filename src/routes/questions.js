const express = require('express');
const prisma = require('../db');
const { requireAuth } = require('../auth');
const gamification = require('../services/gamification.service');

// Practice from the platform's question bank (curated in the admin panel). Open to every
// signed-in person; the correct answers stay on the server until a set is submitted.
const router = express.Router();
router.use(requireAuth);

router.get('/subjects', async (req, res) => {
  const rows = await prisma.platformQuestion.groupBy({ by: ['subject'], where: { active: true }, _count: { _all: true }, orderBy: { subject: 'asc' } });
  res.json({ subjects: rows.map((r) => ({ subject: r.subject, count: r._count._all })) });
});

router.get('/practice', async (req, res) => {
  const subject = String(req.query.subject || '').trim();
  if (!subject) return res.status(400).json({ error: 'Choose a subject.' });
  const count = Math.min(30, Math.max(5, parseInt(req.query.count, 10) || 10));
  const ids = (await prisma.platformQuestion.findMany({ where: { subject, active: true }, select: { id: true } })).map((q) => q.id);
  if (!ids.length) return res.status(404).json({ error: 'There are no questions for that subject yet.' });
  // Fisher–Yates on the id list, then take the first `count`.
  for (let i = ids.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [ids[i], ids[j]] = [ids[j], ids[i]]; }
  const picked = await prisma.platformQuestion.findMany({ where: { id: { in: ids.slice(0, count) } } });
  picked.sort((a, b) => ids.indexOf(a.id) - ids.indexOf(b.id));
  res.json({
    subject,
    questions: picked.map((q) => ({ id: q.id, text: q.text, options: JSON.parse(q.options), topic: q.topic, year: q.year, source: q.source })),
  });
});

router.post('/check', async (req, res) => {
  const answers = Array.isArray(req.body.answers) ? req.body.answers.slice(0, 50) : [];
  if (!answers.length) return res.status(400).json({ error: 'No answers to check.' });
  const questions = await prisma.platformQuestion.findMany({ where: { id: { in: answers.map((a) => String(a.id)) } } });
  const byId = new Map(questions.map((q) => [q.id, q]));
  let score = 0;
  const review = answers.filter((a) => byId.has(String(a.id))).map((a) => {
    const q = byId.get(String(a.id));
    const correct = Number(a.choice) === q.correctIndex;
    if (correct) score += 1;
    return { id: q.id, text: q.text, options: JSON.parse(q.options), choice: a.choice == null ? null : Number(a.choice), correctIndex: q.correctIndex, correct, explanation: q.explanation };
  });
  let points = 0;
  if (req.user.role === 'STUDENT' && review.length) {
    try { points = (await gamification.recordAssessmentCompletion(req.user.id, score, review.length)).pointsEarned || 0; } catch { /* practice still counts without points */ }
  }
  res.json({ score, total: review.length, review, points });
});

module.exports = router;
