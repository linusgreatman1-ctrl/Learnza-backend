const prisma = require('../db');

// One matric number format for every school: SCHOOLCODE/YEAR/DEPTCODE/NNN, for example OKM/2026/CSC/004.
// SCHOOLCODE is made from the school's name (its capital letters, or the first letters of its words). The serial counts every
// student already holding a number for that school, department and year, so two people never get the same one. It is made when a
// student is added without a matric number (by the school admin or a lecturer).
const STOP = new Set(['of', 'the', 'and', 'for', 'in', 'at', 'a']);

function schoolCode(name) {
  const words = String(name || '').replace(/[^A-Za-z0-9 ]+/g, ' ').split(/\s+/).filter((w) => w && !STOP.has(w.toLowerCase()));
  let code = words.length > 1 ? words.map((w) => w[0]).join('') : (words[0] || 'SCH').slice(0, 4);
  code = code.toUpperCase().slice(0, 6);
  return code || 'SCH';
}

const deptCode = (d) => (String((d && d.code) || '').replace(/[^A-Za-z0-9]+/g, '').toUpperCase() || 'GEN');

async function generateMatricNumber(school, department, year) {
  const yr = String(year || new Date().getFullYear());
  const prefix = `${schoolCode(school && school.name)}/${yr}/${deptCode(department)}/`;
  const rows = await prisma.user.findMany({
    where: { schoolId: school.id, role: 'STUDENT', matricNumber: { startsWith: prefix, mode: 'insensitive' } },
    select: { matricNumber: true },
  });
  let max = 0;
  for (const r of rows) {
    const n = parseInt(String(r.matricNumber).slice(prefix.length), 10);
    if (Number.isFinite(n) && n > max) max = n;
  }
  // belt and braces: never hand out a number that is already taken
  for (let n = max + 1; n < max + 50; n++) {
    const candidate = prefix + String(n).padStart(3, '0');
    const taken = await prisma.user.findFirst({ where: { schoolId: school.id, role: 'STUDENT', matricNumber: { equals: candidate, mode: 'insensitive' } }, select: { id: true } });
    if (!taken) return candidate;
  }
  return prefix + String(max + 1).padStart(3, '0') + '-' + Date.now().toString(36).toUpperCase();
}

module.exports = { generateMatricNumber, schoolCode };
