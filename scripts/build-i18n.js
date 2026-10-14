// Builds public/i18n/<code>.json from the translation sources in scripts/i18n/src-*.txt.
// A line is:  English ¦ Yoruba ¦ Hausa ¦ Igbo ¦ Nigerian Pidgin  (lines starting with # are comments).
// Run:  node scripts/build-i18n.js
const fs = require('fs');
const path = require('path');
const dir = path.join(__dirname, 'i18n');
const outDir = path.join(__dirname, '..', 'public', 'i18n');
const CODES = ['yo', 'ha', 'ig', 'pcm'];
const maps = Object.fromEntries(CODES.map((c) => [c, {}]));
let problems = 0, lines = 0;
for (const f of fs.readdirSync(dir).filter((x) => /^src-.*\.txt$/.test(x)).sort()) {
  fs.readFileSync(path.join(dir, f), 'utf8').split(/\r?\n/).forEach((raw, i) => {
    if (!raw.trim() || raw.startsWith('#')) return;
    const cols = raw.split(' ¦ ').map((s) => s.trim());
    if (cols.length !== 5) { console.error(`${f}:${i + 1}: expected 5 columns, got ${cols.length}: ${raw.slice(0, 70)}`); problems++; return; }
    const [en, ...tr] = cols;
    const ph = (s) => (s.match(/\{(\d|n|m)\}/g) || []).sort().join('');
    lines++;
    CODES.forEach((c, k) => {
      if (!tr[k]) { console.error(`${f}:${i + 1}: empty ${c}`); problems++; return; }
      if (ph(en) !== ph(tr[k])) { console.error(`${f}:${i + 1}: placeholders differ in ${c}: ${en}`); problems++; return; }
      maps[c][en] = tr[k];
    });
  });
}
fs.mkdirSync(outDir, { recursive: true });
CODES.forEach((c) => fs.writeFileSync(path.join(outDir, c + '.json'), JSON.stringify(maps[c], null, 0)));
console.log(`${lines} phrases x ${CODES.length} languages written to public/i18n/ (${problems} problem${problems === 1 ? '' : 's'})`);
process.exit(problems ? 1 : 0);
