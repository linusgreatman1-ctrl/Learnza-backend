const express = require('express');
const { requireAuth } = require('../auth');
const { requireActiveSubscription } = require('../subscription');
const ai = require('../services/aiProvider.service');
const { aiGuard, aiDailyLimit, logAiConversation } = require('../aiGuard');
const { directive, isLang } = require('../utils/language');

const router = express.Router();

const SYSTEM_PROMPT = `You are Learnza's AI research assistant, helping a higher-institution student or lecturer in Nigeria think through an academic topic, project, or assignment. You cannot browse the web and have no live sources -- never invent fake citations, DOIs, page numbers, or author names presented as real references. Instead: explain core concepts clearly, suggest how to structure a project/essay/lesson, propose good search terms and the TYPES of sources worth looking for (e.g. "a recent WAEC/NUC curriculum review," "a peer-reviewed journal on X"), and flag where the student should verify with their lecturer or library. Be concise and practical, using plain paragraphs or short bullet lists -- no markdown headers.`;

// Free for lecturers/admins (a staff tool); students need an active subscription,
// same as the other AI-cost-bearing features.
router.post('/research-assistant/ask', requireAuth, aiGuard, requireActiveSubscription, aiDailyLimit, async (req, res) => {
  const { question, spoken } = req.body;
  if (!question || !question.trim()) return res.status(400).json({ error: 'Type a question or topic first.' });
  // The answer comes back in the language chosen under Settings > Language (or the one picked for this question).
  const language = isLang(req.body.language) ? req.body.language : req.user.aiLanguage;
  // A question asked by voice is answered to be listened to: short, flowing sentences, no bullet marks or symbols.
  const spokenStyle = spoken ? '\n\nThis answer will be read aloud to the student, so write it as natural speech: short flowing sentences, no bullet points, numbering or symbols, and keep it under about 170 words.' : '';

  try {
    const answer = await ai.askForText(SYSTEM_PROMPT + directive(language) + spokenStyle, question.trim());
    await logAiConversation(req.user.id, 'RESEARCH', question.trim(), answer);
    res.json({ answer, language });
  } catch (err) {
    if (err.code === 'AI_NOT_CONFIGURED') return res.status(503).json({ error: err.message, code: err.code });
    res.status(502).json({ error: 'The research assistant had trouble responding. Please try again.' });
  }
});

// The answer, spoken: used when the browser has no voice of its own for the chosen language (most devices have none
// for Yoruba, Hausa or Igbo). Returns raw 16-bit mono PCM at 24 kHz as base64, which the page plays straight away.
router.post('/research-assistant/speak', requireAuth, aiGuard, requireActiveSubscription, async (req, res) => {
  const text = String((req.body && req.body.text) || '').replace(/\s+/g, ' ').trim().slice(0, 1800);
  if (!text) return res.status(400).json({ error: 'Nothing to read out.' });
  try {
    const audio = await ai.synthesizeSpeech(text);
    res.json({ data: audio.data, sampleRate: audio.sampleRate || 24000 });
  } catch (err) {
    if (err.code === 'AI_NOT_CONFIGURED') return res.status(503).json({ error: err.message, code: err.code });
    res.status(502).json({ error: 'The voice could not be made just now.' });
  }
});

module.exports = router;
