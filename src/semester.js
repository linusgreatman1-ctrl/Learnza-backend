const prisma = require('./db');

// The school's active semester -- new courses/assessments/assignments/attendance/
// results get stamped with this so "every activity is by semester" without every
// route having to re-derive it.
async function getCurrentSemesterId(schoolId) {
  if (!schoolId) return null;
  const current = await prisma.semester.findFirst({ where: { schoolId, isCurrent: true } });
  return current ? current.id : null;
}

module.exports = { getCurrentSemesterId };
