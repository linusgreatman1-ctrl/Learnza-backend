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
  assert.equal(coins.SECONDS_PER_COIN, 300);
  assert.deepEqual(coins.PACKS.map((p) => [p.coins, p.amountKobo]), [[30, 250000], [100, 750000]]);
  for (const p of coins.PACKS) assert.equal(p.minutes, (p.coins * coins.SECONDS_PER_COIN) / 60);
  assert.equal(coins.getPack('COINS_30').coins, 30);
  assert.equal(coins.getPack('nope'), null);
  assert.equal(coins.walletSeconds({ balance: 2, aiSecondsCredit: 45 }), 645);
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
