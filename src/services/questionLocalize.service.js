'use strict';
// Questions in the language the student chose. Every question a student is shown (tests, past questions, CBT mocks, practice,
// the daily challenge, and the explanations and model answers that come back after) is translated here, so a student who
// picked Yoruba, Hausa, Igbo or Pidgin sees the question, the options and the explanation in that language, in every section.
//
// The answers never change: options keep their order and their number (the right answer is stored as an option number), and
// formulas, numbers, symbols, code, proper names and exam terms are left exactly as they are. A translation is made once, kept
// (QuestionTranslation) and shared by every student who needs the same question in the same language. If the AI cannot
// translate right now the question is shown in English rather than not at all.
const crypto = require('crypto');
const prisma = require('../db');
const ai = require('./aiProvider.service');
const { isLang, LANGS, directive } = require('../utils/language');

const BATCH = 8;
const PARALLEL = 4;

// The language a student's questions are shown in: the AI language when one is chosen, otherwise the language of the app.
function contentLanguage(user) {
  if (!user) return 'en';
  const a = user.aiLanguage, u = user.uiLanguage;
  if (isLang(a) && a !== 'en') return a;
  return isLang(u) ? u : 'en';
}

const fields = (q) => ({ text: q.text || '', options: Array.isArray(q.options) ? q.options : null, modelAnswer: q.modelAnswer || '', explanation: q.explanation || '' });
const hashOf = (q) => crypto.createHash('sha1').update(JSON.stringify(fields(q))).digest('hex');

const inflight = new Map();   // "language:hash" -> promise, so two students asking at once cost one translation

function clean(s, n) { return typeof s === 'string' ? s.trim().slice(0, n) : ''; }

// One batch of questions -> a Map of hash -> { text, options, modelAnswer, explanation } for those that came back whole.
async function translateBatch(batch, language) {
  const L = LANGS[language];
  if (process.env.LZ_FAKE_AI === '1') {
    return new Map(batch.map(({ hash, q }) => [hash, {
      text: `[${L.name}] ${q.text}`, options: Array.isArray(q.options) ? q.options.map((o) => `[${L.name}] ${o}`) : null,
      modelAnswer: q.modelAnswer ? `[${L.name}] ${q.modelAnswer}` : '', explanation: q.explanation ? `[${L.name}] ${q.explanation}` : '',
    }]));
  }
  const system = `You translate exam questions for students into ${L.name} (${L.native}). Translate the question text, every answer option, the model answer and the explanation. Rules: keep the options in exactly the same order and the same number (the right answer is stored as an option number, so reordering or merging options would mark students wrong); keep mathematical formulas, numbers, units, symbols, chemical formulae, code, proper names and official examination or curriculum terms exactly as they are; if an option is only a number, a formula, a symbol, a name or code, copy it unchanged; never change what is being asked, never hint at or reveal the answer, and never add or remove facts.` + directive(language);
  const user = `Translate these ${batch.length} questions. Respond with ONLY a JSON array of exactly ${batch.length} objects, in the same order, each of this shape: { "n": number (same as the input), "text": string, "options": [string, ...] or null, "modelAnswer": string, "explanation": string }. Use null for options and an empty string for modelAnswer or explanation exactly where the input has none.\n\n` +
    JSON.stringify(batch.map(({ q }, i) => ({ n: i, ...fields(q) })));
  const parsed = await ai.askForJson(system, user);
  const list = Array.isArray(parsed) ? parsed : Array.isArray(parsed && parsed.questions) ? parsed.questions : [];
  const out = new Map();
  for (const r of list) {
    const src = batch[Number(r && r.n)];
    if (!src) continue;
    const f = fields(src.q);
    const text = clean(r.text, 4000);
    if (f.text && !text) continue;      // an item that has no question text (only an explanation) needs none back
    let options = null;
    if (f.options) {
      if (!Array.isArray(r.options) || r.options.length !== f.options.length) continue;     // an option went missing: not used
      options = r.options.map((o, i) => clean(String(o), 1000) || f.options[i]);
    }
    out.set(src.hash, { text, options, modelAnswer: f.modelAnswer ? clean(r.modelAnswer, 4000) || f.modelAnswer : '', explanation: f.explanation ? clean(r.explanation, 4000) || f.explanation : '' });
  }
  return out;
}

async function pool(tasks, size) {
  const results = [];
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(size, tasks.length) }, async () => {
    while (next < tasks.length) { const i = next++; results[i] = await tasks[i](); }
  }));
  return results;
}

// items: [{ text, options: string[]|null, modelAnswer?, explanation?, ...anything else }] -> the same items, in the language.
async function localize(items, language) {
  if (!Array.isArray(items) || !items.length || !isLang(language) || language === 'en') return items;
  try {
    const hashes = items.map(hashOf);
    const unique = [...new Set(hashes)];
    const rows = await prisma.questionTranslation.findMany({ where: { language, hash: { in: unique } } });
    const have = new Map();
    for (const r of rows) { try { have.set(r.hash, JSON.parse(r.payload)); } catch { /* a damaged row is made again */ } }

    const waiting = [];
    const todo = [];
    const seen = new Set();
    items.forEach((q, i) => {
      const h = hashes[i];
      if (have.has(h) || seen.has(h)) return;
      seen.add(h);
      const key = language + ':' + h;
      if (inflight.has(key)) waiting.push(inflight.get(key).then((t) => { if (t) have.set(h, t); }));
      else todo.push({ hash: h, q });
    });

    const batches = [];
    for (let i = 0; i < todo.length; i += BATCH) batches.push(todo.slice(i, i + BATCH));
    const tasks = batches.map((batch) => async () => {
      const done = translateBatch(batch, language).catch((e) => { console.error('[questions] translation failed:', e.message); return new Map(); });
      batch.forEach(({ hash }) => inflight.set(language + ':' + hash, done.then((m) => m.get(hash) || null)));
      const got = await done;
      for (const { hash } of batch) {
        inflight.delete(language + ':' + hash);
        const t = got.get(hash);
        if (!t) continue;
        have.set(hash, t);
        await prisma.questionTranslation.create({ data: { hash, language, payload: JSON.stringify(t) } }).catch(() => { /* another student saved it first */ });
      }
    });
    await Promise.all([pool(tasks, PARALLEL), ...waiting]);

    return items.map((q, i) => {
      const t = have.get(hashes[i]);
      if (!t) return q;
      const out = { ...q };
      if (q.text && t.text) out.text = t.text;
      if (Array.isArray(q.options) && Array.isArray(t.options) && t.options.length === q.options.length) out.options = t.options;
      if (q.modelAnswer && t.modelAnswer) out.modelAnswer = t.modelAnswer;
      if (q.explanation && t.explanation) out.explanation = t.explanation;
      return out;
    });
  } catch (e) {
    console.error('[questions] could not localize:', e.message);
    return items;     // the questions are still shown, in English
  }
}

module.exports = { localize, contentLanguage, hashOf };
