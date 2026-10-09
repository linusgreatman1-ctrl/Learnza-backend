// Pure-logic unit tests (no server, no database):  npm test
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

test('join codes: 8 characters, no look-alike characters, not repeating', () => {
  const { generateJoinCode, generateAccessCode, safeEqual } = require('../../src/utils');
  const seen = new Set();
  for (let i = 0; i < 500; i++) {
    const c = generateJoinCode();
    assert.match(c, /^[A-Z2-9]{8}$/);
    assert.doesNotMatch(c, /[01OIL]/);
    seen.add(c);
  }
  assert.ok(seen.size > 495, 'codes should be effectively unique');
  assert.equal(generateAccessCode(12).length, 12);
  assert.ok(safeEqual('ABC', 'ABC'));
  assert.ok(!safeEqual('ABC', 'ABD'));
  assert.ok(!safeEqual('ABC', 'ABCD'));
});

test('lockout: only locks while lockedUntil is in the future', () => {
  const { lockedMessage, MAX_ATTEMPTS } = require('../../src/lockout');
  assert.equal(MAX_ATTEMPTS, 5);
  assert.equal(lockedMessage({ lockedUntil: null }), null);
  assert.equal(lockedMessage({ lockedUntil: new Date(Date.now() - 1000) }), null);
  assert.match(lockedMessage({ lockedUntil: new Date(Date.now() + 5 * 60000) }), /5 minutes/);
  assert.match(lockedMessage({ lockedUntil: new Date(Date.now() + 1000) }), /1 minute\b/);
});

test('plans: prices live on the server and agree with each other', () => {
  const { getPlan, PLANS } = require('../../src/config/plans');
  for (const [name, p] of Object.entries(PLANS)) {
    assert.equal(p.amountKobo, p.amountNaira * 100, name);
    assert.ok(p.days > 0 && p.aiMinutes > 0);
  }
  assert.throws(() => getPlan('WEEKLY'));
});

test('coin packs: priced and sized consistently', () => {
  const coins = require('../../src/services/coins.service');
  assert.equal(coins.SECONDS_PER_COIN, 60);
  assert.deepEqual(coins.PACKS.map((p) => [p.coins, p.amountKobo]), [[30, 250000], [60, 480000], [90, 700000], [120, 900000]]);
  for (const p of coins.PACKS) assert.equal(p.minutes, (p.coins * coins.SECONDS_PER_COIN) / 60);
  assert.equal(coins.getPack('COINS_30').coins, 30);
  assert.equal(coins.getPack('nope'), null);
  assert.equal(coins.walletSeconds({ balance: 2, aiSecondsCredit: 45 }), 165);
});

test('settings: every definition has a sane default and a label', () => {
  const { DEFINITIONS } = require('../../src/settings');
  for (const [key, d] of Object.entries(DEFINITIONS)) {
    assert.ok(d.label && d.help && d.category, key);
    if (d.type === 'select') assert.ok(d.options.includes(d.default), key);
    if (d.type === 'boolean') assert.equal(typeof d.default, 'boolean', key);
    if (d.type === 'number') assert.equal(typeof d.default, 'number', key);
  }
});

test('session: refresh tokens are stored hashed', () => {
  const { sha256 } = require('../../src/session');
  assert.equal(sha256('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});

test('the service worker only pre-caches files that exist and never touches the API', () => {
  const sw = fs.readFileSync(path.join(__dirname, '../../public/sw.js'), 'utf8');
  const shell = JSON.parse(sw.match(/const SHELL = (\[[^\]]*\])/)[1].replace(/'/g, '"'));
  for (const url of shell) {
    if (url === '/app' || url === '/schools') continue; // served by routes, not files
    assert.ok(fs.existsSync(path.join(__dirname, '../../public', url)), url + ' missing');
  }
  assert.match(sw, /api\|socket\\\.io\|uploads/);
});

test('both manifests point at real pages and an icon that exists', () => {
  for (const [file, start] of [['manifest-app.webmanifest', '/app'], ['manifest-schools.webmanifest', '/schools']]) {
    const m = JSON.parse(fs.readFileSync(path.join(__dirname, '../../public', file), 'utf8'));
    assert.equal(m.start_url, start);
    for (const icon of m.icons) assert.ok(fs.existsSync(path.join(__dirname, '../../public', icon.src)));
  }
});

test('page optimisation: local assets get a version, scripts are deferred, hosts are pre-connected', () => {
  const site = require('../../src/siteFiles');
  const html = [
    '<html><head><title>x</title>',
    '<link rel="stylesheet" href="style.css">',
    '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Sora">',
    '<link rel="manifest" href="manifest-app.webmanifest">',
    '<script src="https://cdnjs.cloudflare.com/ajax/libs/KaTeX/0.16.11/katex.min.js"></script>',
    '</head><body><script src="extras.js"></script><script src="app.js"></script></body></html>',
  ].join('\n');
  const out = site.optimisePage(html);
  const v = site.assetVersion();
  assert.ok(out.includes(`href="style.css?v=${v}"`), 'stylesheet versioned');
  assert.ok(out.includes(`src="app.js?v=${v}"`) && out.includes(`src="extras.js?v=${v}"`), 'scripts versioned');
  assert.ok(out.includes('href="https://fonts.googleapis.com/css2?family=Sora"'), 'third-party URLs untouched');
  assert.ok(out.includes('href="manifest-app.webmanifest"'), 'files outside the asset list untouched');
  assert.equal((out.match(/<script defer /g) || []).length, 3, 'every script is deferred');
  assert.ok(out.includes('rel="preconnect" href="https://cdn.socket.io"'), 'hosts pre-connected');
  assert.equal(site.optimisePage(out).match(/defer defer/), null, 'running it twice does not double up defer');
});

test('the real pages load their own scripts in dependency order (extras before app)', () => {
  for (const [page, script] of [['app.html', 'app.js'], ['schools.html', 'schools.js']]) {
    const html = fs.readFileSync(path.join(__dirname, '../../public', page), 'utf8');
    assert.ok(html.indexOf('src="extras.js"') > -1 && html.indexOf('src="extras.js"') < html.indexOf(`src="${script}"`), page);
    assert.ok(!/<script(?![^>]*\bsrc=)[^>]*>/.test(html), page + ' has an inline script, which the CSP forbids');
  }
});

test('paper timing: 20 objective in 15 minutes, 5 theory in 1h30, in proportion otherwise', () => {
  const { minutesFor, profileFor, totalMarks, PROFILES } = require('../../src/utils/paper');
  const obj = (n) => Array.from({ length: n }, () => ({ questionType: 'OBJECTIVE' }));
  const th = (n) => Array.from({ length: n }, () => ({ questionType: 'THEORY' }));
  assert.equal(minutesFor(obj(20)), 15);
  assert.equal(minutesFor(th(5)), 90);
  assert.equal(minutesFor([...obj(20), ...th(5)]), 105);
  assert.equal(minutesFor(obj(10)), 8);
  assert.equal(minutesFor([]), 1);
  // the examination's share of the course mark: universities 70, polytechnics / monotechnics / colleges of education 60
  assert.equal(totalMarks(profileFor('UNIVERSITY')), 70);
  for (const t of ['POLYTECHNIC', 'MONOTECHNIC', 'COLLEGE_OF_EDUCATION']) assert.equal(totalMarks(profileFor(t)), 60, t);
  assert.equal(profileFor('nonsense'), PROFILES.OTHER);
  for (const p of Object.values(PROFILES)) assert.equal(p.examShare + p.caShare, 100);
  for (const p of Object.values(PROFILES)) assert.equal(totalMarks(p), p.examShare);
});

test('paystack webhook signatures: HMAC-SHA512 of the raw body with the secret key', () => {
  process.env.PAYSTACK_SECRET_KEY = 'sk_test_unit';
  const crypto = require('crypto');
  const paystack = require('../../src/services/paystack.service');
  const body = Buffer.from('{"event":"charge.success"}');
  const sig = crypto.createHmac('sha512', 'sk_test_unit').update(body).digest('hex');
  assert.equal(paystack.verifyWebhookSignature(body, sig), true);
  assert.equal(paystack.verifyWebhookSignature(body, 'bad'), false);
  assert.equal(paystack.verifyWebhookSignature(Buffer.from('{"event":"other"}'), sig), false);
  assert.equal(paystack.verifyWebhookSignature(body, undefined), false);
  delete process.env.PAYSTACK_SECRET_KEY;
  assert.equal(paystack.verifyWebhookSignature(body, sig), false);
});
