const express = require('express');
const { requireAuth } = require('../auth');
const { requireActiveSubscription } = require('../subscription');
const ai = require('../services/aiProvider.service');

const router = express.Router();

const SYSTEM_PROMPT = `You are Learnza's AI research assistant, helping a higher-institution student or lecturer in Nigeria think through an academic topic, project, or assignment. You cannot browse the web and have no live sources -- never invent fake citations, DOIs, page numbers, or author names presented as real references. Instead: explain core concepts clearly, suggest how to structure a project/essay/lesson, propose good search terms and the TYPES of sources worth looking for (e.g. "a recent WAEC/NUC curriculum review," "a peer-reviewed journal on X"), and flag where the student should verify with their lecturer or library. Be concise and practical, using plain paragraphs or short bullet lists -- no markdown headers.`;

// Free for lecturers/admins (a staff tool); students need an active subscription,
// same as the other AI-cost-bearing features.
router.post('/research-assistant/ask', requireAuth, requireActiveSubscription, async (req, res) => {
  const { question } = req.body;
  if (!question || !question.trim()) return res.status(400).json({ error: 'Type a question or topic first.' });

  try {
    const answer = await ai.askForText(SYSTEM_PROMPT, question.trim());
    res.json({ answer });
  } catch (err) {
    if (err.code === 'AI_NOT_CONFIGURED') return res.status(503).json({ error: err.message, code: err.code });
    res.status(502).json({ error: 'The research assistant had trouble responding. Please try again.' });
  }
});

module.exports = router;
