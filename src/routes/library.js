const express = require('express');
const prisma = require('../db');
const { requireAuth, requireRole, logActivity } = require('../auth');
const { memoryUpload, saveUpload } = require('../services/fileUpload.service');
const { courseInSchool, hasSchool } = require('../scope');

const router = express.Router();
const upload = memoryUpload(25);

// What a user can browse: the platform's own catalog (schoolId null -- uploaded by the
// platform owner from the admin panel) plus, for school members, their own school's uploads.
// One school never sees another's resources. Independent learners see the platform catalog.
router.get('/library', requireAuth, async (req, res) => {
  const { courseId, departmentId } = req.query;
  const visible = hasSchool(req.user) ? { OR: [{ schoolId: req.user.schoolId }, { schoolId: null }] } : { schoolId: null };
  const narrow = [];
  if (courseId) narrow.push({ courseId: String(courseId) });
  if (departmentId) narrow.push({ course: { departmentId: String(departmentId) } });
  const items = await prisma.libraryResource.findMany({
    where: { AND: [visible, ...narrow] },
    include: { course: { select: { id: true, code: true, title: true, departmentId: true } }, uploader: { select: { fullName: true } } },
    orderBy: [{ type: 'asc' }, { title: 'asc' }],
  });
  res.json({ items });
});

// E-books are added and removed by the platform's backend admin only (from the admin panel). Lecturers, school admins and
// students read them; nobody at a school can upload or delete one.
router.post('/library', requireAuth, (req, res) => res.status(403).json({ error: 'Only the backend admin can add e-books to the library.' }));
router.delete('/library/:id', requireAuth, (req, res) => res.status(403).json({ error: 'Only the backend admin can remove e-books from the library.' }));

module.exports = router;
