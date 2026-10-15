// Questions come back in the student's chosen language; the answers never move; a translation is made once and shared.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

process.env.LZ_FAKE_AI = '1';
const rows = [];
let createCalls = 0;
const fake = {
  questionTranslation: {
    findMany: async ({ where }) => rows.filter((r) => r.language === where.language && where.hash.in.includes(r.hash)),
    create: async ({ data }) => { createCalls++; if (rows.some((r) => r.hash === data.hash && r.language === data.language)) throw new Error('dup'); rows.push(data); return data; },
  },
};
const dbPath = require.resolve(path.join('..', '..', 'src', 'db.js'));
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: fake };
const ql = require('../../src/services/questionLocalize.service');

const qs = () => [
  { id: 'a', text: 'What is 2 + 2?', options: ['3', '4', '5', '6'], order: 1 },
  { id: 'b', text: 'Define osmosis.', options: ['Movement of water', 'Movement of heat', 'Movement of light', 'Movement of sound'], explanation: 'Water moves across a membrane.', correctIndex: 0 },
];

test('English questions are left exactly as they are', async () => {
  const out = await ql.localize(qs(), 'en');
  assert.deepEqual(out, qs());
});

test('a chosen language translates the question, the options and the explanation, and keeps the order and the rest of the data', async () => {
  const out = await ql.localize(qs(), 'ha');
  assert.match(out[0].text, /^\[Hausa\] What is 2 \+ 2\?/);
  assert.equal(out[0].options.length, 4);
  assert.equal(out[0].id, 'a');
  assert.equal(out[0].order, 1);
  assert.match(out[1].explanation, /^\[Hausa\]/);
  assert.equal(out[1].correctIndex, 0);                               // the right answer is still option 0
  assert.match(out[1].options[0], /Movement of water/);               // option 0 is still the same option
});

test('a translation is saved once and shared: asking again costs nothing more', async () => {
  const before = createCalls;
  const again = await ql.localize(qs(), 'ha');
  assert.equal(createCalls, before);
  assert.match(again[0].text, /^\[Hausa\]/);
  const other = await ql.localize(qs(), 'yo');                          // another language is its own translation
  assert.match(other[0].text, /^\[Yoruba\]/);
  assert.ok(createCalls > before);
});

test('an unknown language, or no items, change nothing; a failing translator shows English instead of nothing', async () => {
  assert.deepEqual(await ql.localize(qs(), 'xx'), qs());
  assert.deepEqual(await ql.localize([], 'ha'), []);
  const saved = fake.questionTranslation.findMany;
  fake.questionTranslation.findMany = async () => { throw new Error('database down'); };
  const out = await ql.localize(qs(), 'ig');
  fake.questionTranslation.findMany = saved;
  assert.deepEqual(out, qs());
});

test('items that carry only a correction (no question text) are translated too', async () => {
  const out = await ql.localize([{ questionId: 'x', correctIndex: 1, explanation: 'Because water moves.' }], 'pcm');
  assert.match(out[0].explanation, /^\[Nigerian Pidgin\]/);
  assert.equal(out[0].correctIndex, 1);
});

test('which language the questions use: the AI language when one is chosen, otherwise the app language', () => {
  assert.equal(ql.contentLanguage({ aiLanguage: 'yo', uiLanguage: 'ha' }), 'yo');
  assert.equal(ql.contentLanguage({ aiLanguage: 'en', uiLanguage: 'ha' }), 'ha');
  assert.equal(ql.contentLanguage({ aiLanguage: 'en', uiLanguage: 'en' }), 'en');
  assert.equal(ql.contentLanguage(null), 'en');
});
