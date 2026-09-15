require('dotenv').config();
const bcrypt = require('bcryptjs');
const prisma = require('./db');

async function main() {
  const existing = await prisma.school.findFirst();
  if (existing) {
    console.log('Database already seeded, skipping full seed.');
    await backfillDemoSubscription();
    await backfillSchoolLicense();
    await backfillAccessCodes();
    await backfillSchoolLocation();
    await backfillSemester();
    await backfillDemoContactDetails();
    await backfillHostels();
    return;
  }

  const school = await prisma.school.create({
    data: {
      name: 'Edo College of Education',
      location: 'Igueben',
      licenseStatus: 'ACTIVE',
      licenseExpiresAt: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
    },
  });
  const semester = await prisma.semester.create({
    data: { schoolId: school.id, name: 'First Semester 2025/2026', isCurrent: true },
  });

  const departments = await Promise.all(
    [
      { code: 'ENG', name: 'English' },
      { code: 'MTH', name: 'Mathematics' },
      { code: 'CSC', name: 'Computer Science' },
      { code: 'BIO', name: 'Biology' },
      { code: 'ECE', name: 'Early Childhood Care Education' },
      { code: 'ECO', name: 'Economics' },
    ].map((d) => prisma.department.create({ data: { ...d, schoolId: school.id } }))
  );
  const [eng, mth, csc, bio, ece, eco] = departments;

  const adminPass = await bcrypt.hash('Admin@123', 10);
  const admin = await prisma.user.create({
    data: {
      fullName: 'School Administrator',
      email: 'admin@edocoe.edu.ng',
      passwordHash: adminPass,
      phone: '+2348030000001',
      role: 'ADMIN',
      staffId: 'ADM-001',
      schoolId: school.id,
    },
  });

  const lecturerPass = await bcrypt.hash('Lecturer@123', 10);
  const lecturer = await prisma.user.create({
    data: {
      fullName: 'Dr. Osaretin Igbinedion',
      email: 'lecturer@edocoe.edu.ng',
      passwordHash: lecturerPass,
      phone: '+2348030000002',
      role: 'LECTURER',
      staffType: 'ACADEMIC',
      staffId: 'STF-014',
      departmentId: csc.id,
      schoolId: school.id,
      accessCode: 'LECT2026',
    },
  });

  const studentPass = await bcrypt.hash('Student@123', 10);
  const student = await prisma.user.create({
    data: {
      fullName: 'Blessing Aigbogun',
      email: 'student@edocoe.edu.ng',
      passwordHash: studentPass,
      phone: '+2348030000003',
      role: 'STUDENT',
      matricNumber: 'ECOE/23/CSC/041',
      departmentId: csc.id,
      schoolId: school.id,
      accessCode: 'STUD2026',
    },
  });

  // Demo account carries an active subscription so visitors can try the paid AI
  // Teacher / recorded-lecture features without a real payment.
  await prisma.subscription.create({
    data: {
      userId: student.id,
      plan: 'YEARLY',
      status: 'ACTIVE',
      startedAt: new Date(),
      expiresAt: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
    },
  });

  const csc101 = await prisma.course.create({
    data: { departmentId: csc.id, code: 'CSC 101', title: 'Introduction to Computer Science', level: 'NCE 1', semester: 'First', semesterId: semester.id },
  });
  const csc102 = await prisma.course.create({
    data: { departmentId: csc.id, code: 'CSC 102', title: 'Introduction to Programming', level: 'NCE 1', semester: 'Second', semesterId: semester.id },
  });
  await prisma.course.create({
    data: { departmentId: mth.id, code: 'MTH 101', title: 'Algebra and Trigonometry', level: 'NCE 1', semester: 'First', semesterId: semester.id },
  });
  await prisma.course.create({
    data: { departmentId: eng.id, code: 'ENG 101', title: 'Use of English I', level: 'NCE 1', semester: 'First', semesterId: semester.id },
  });
  await prisma.course.create({
    data: { departmentId: bio.id, code: 'BIO 101', title: 'General Biology I', level: 'NCE 1', semester: 'First', semesterId: semester.id },
  });
  await prisma.course.create({
    data: { departmentId: ece.id, code: 'ECE 101', title: 'Foundations of Early Childhood Education', level: 'NCE 1', semester: 'First', semesterId: semester.id },
  });
  await prisma.course.create({
    data: { departmentId: eco.id, code: 'ECO 101', title: 'Principles of Economics I', level: 'NCE 1', semester: 'First', semesterId: semester.id },
  });

  await prisma.enrollment.create({ data: { studentId: student.id, courseId: csc101.id } });
  await prisma.enrollment.create({ data: { studentId: student.id, courseId: csc102.id } });

  await prisma.lesson.create({
    data: {
      courseId: csc101.id,
      title: 'What is a Computer?',
      order: 1,
      authorId: lecturer.id,
      script:
        'Welcome to Introduction to Computer Science. In this lesson, we define a computer as an electronic device that accepts data as input, processes that data according to a set of instructions, and produces information as output. We will look at the four main operations of a computer: input, processing, storage, and output, and see everyday examples of each from a Nigerian classroom setting.',
    },
  });
  await prisma.lesson.create({
    data: {
      courseId: csc101.id,
      title: 'Generations of Computers',
      order: 2,
      authorId: lecturer.id,
      script:
        'Computers have evolved through five generations, starting with vacuum tubes in the first generation, moving to transistors in the second, integrated circuits in the third, microprocessors in the fourth, and today artificial intelligence in the fifth generation. Each generation brought computers that were smaller, faster, and more affordable than the one before it.',
    },
  });
  await prisma.lesson.create({
    data: {
      courseId: csc102.id,
      title: 'Introduction to Algorithms',
      order: 1,
      authorId: lecturer.id,
      script:
        'An algorithm is a step by step procedure for solving a problem or accomplishing a task. Before writing any computer program, a programmer first designs an algorithm. We will practice writing an algorithm for a simple everyday task: making a cup of tea, and then translate it into a flowchart.',
    },
  });

  await prisma.libraryResource.create({
    data: {
      courseId: csc101.id,
      title: 'Computer Studies for Colleges of Education',
      author: 'A. O. Fagbola',
      type: 'Textbook',
      fileUrl: 'https://example.org/library/computer-studies-coe.pdf',
      uploaderId: lecturer.id,
    },
  });
  await prisma.libraryResource.create({
    data: {
      courseId: csc102.id,
      title: 'Introduction to Programming Logic - Past Questions 2020-2024',
      author: 'Edo COE Examinations Unit',
      type: 'Past Question',
      fileUrl: 'https://example.org/library/csc102-past-questions.pdf',
      uploaderId: lecturer.id,
    },
  });

  const group = await prisma.studyGroup.create({
    data: { courseId: csc101.id, name: 'CSC 101 Study Circle', creatorId: student.id },
  });
  await prisma.groupMembership.create({ data: { groupId: group.id, studentId: student.id } });
  await prisma.groupMessage.create({
    data: { groupId: group.id, senderId: student.id, body: 'Anyone free to review the generations of computers topic before Friday?' },
  });

  await prisma.assessment.create({
    data: {
      courseId: csc101.id,
      title: 'CA 1: Introduction to Computers',
      type: 'CA',
      durationMin: 15,
      authorId: lecturer.id,
      questions: {
        create: [
          {
            text: 'Which of these is NOT one of the four main operations of a computer?',
            options: JSON.stringify(['Input', 'Processing', 'Marketing', 'Output']),
            correctIndex: 2,
            order: 0,
          },
          {
            text: 'The fourth generation of computers is best known for the use of:',
            options: JSON.stringify(['Vacuum tubes', 'Transistors', 'Microprocessors', 'Artificial intelligence']),
            correctIndex: 2,
            order: 1,
          },
        ],
      },
    },
  });

  console.log('Seed complete.');
  console.log('Admin login:    admin@edocoe.edu.ng / Admin@123');
  console.log('Lecturer login: lecturer@edocoe.edu.ng / Lecturer@123');
  console.log('Student login:  student@edocoe.edu.ng / Student@123');
}

// Runs even when the rest of the seed is skipped (production already has data), so a
// redeploy after adding the Subscription model still gives the demo student an active
// plan to show off AI Teacher / recorded lectures.
async function backfillDemoSubscription() {
  const demoStudent = await prisma.user.findUnique({ where: { email: 'student@edocoe.edu.ng' } });
  if (!demoStudent) return;
  const existingSub = await prisma.subscription.findUnique({ where: { userId: demoStudent.id } });
  if (existingSub && existingSub.status === 'ACTIVE' && existingSub.expiresAt > new Date()) return;

  await prisma.subscription.upsert({
    where: { userId: demoStudent.id },
    create: {
      userId: demoStudent.id,
      plan: 'YEARLY',
      status: 'ACTIVE',
      startedAt: new Date(),
      expiresAt: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
    },
    update: {
      status: 'ACTIVE',
      startedAt: new Date(),
      expiresAt: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
    },
  });
  console.log('Backfilled an active demo subscription for student@edocoe.edu.ng');
}

async function backfillSchoolLicense() {
  const school = await prisma.school.findFirst();
  if (!school || school.licenseExpiresAt) return;
  await prisma.school.update({
    where: { id: school.id },
    data: { licenseStatus: 'ACTIVE', licenseExpiresAt: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000) },
  });
  console.log('Backfilled a school license expiry date');
}

async function backfillAccessCodes() {
  const demoLecturer = await prisma.user.findUnique({ where: { email: 'lecturer@edocoe.edu.ng' } });
  if (demoLecturer && !demoLecturer.accessCode) {
    await prisma.user.update({ where: { id: demoLecturer.id }, data: { accessCode: 'LECT2026' } });
    console.log('Backfilled access code for demo lecturer');
  }
  const demoStudent = await prisma.user.findUnique({ where: { email: 'student@edocoe.edu.ng' } });
  if (demoStudent && !demoStudent.accessCode) {
    await prisma.user.update({ where: { id: demoStudent.id }, data: { accessCode: 'STUD2026' } });
    console.log('Backfilled access code for demo student');
  }
}

// Runs even when the rest of the seed is skipped, so a school seeded before the
// location field existed still gets one.
async function backfillSchoolLocation() {
  const school = await prisma.school.findFirst();
  if (!school || school.location) return;
  await prisma.school.update({ where: { id: school.id }, data: { location: 'Igueben' } });
  console.log('Backfilled school location');
}

// A school seeded before the Semester model existed has no semester at all --
// give it one so the semester switcher and "every activity is by semester" features
// have something to attach new activity to.
async function backfillSemester() {
  const school = await prisma.school.findFirst();
  if (!school) return;
  const existing = await prisma.semester.findFirst({ where: { schoolId: school.id } });
  if (existing) return;
  await prisma.semester.create({ data: { schoolId: school.id, name: 'First Semester 2025/2026', isCurrent: true } });
  console.log('Backfilled an initial semester');
}

// Demo accounts seeded before phone/staffType existed get them filled in so the
// example accounts look complete in the admin directory.
async function backfillDemoContactDetails() {
  const lecturer = await prisma.user.findUnique({ where: { email: 'lecturer@edocoe.edu.ng' } });
  if (lecturer && !lecturer.phone) {
    await prisma.user.update({ where: { id: lecturer.id }, data: { phone: '+2348030000002', staffType: 'ACADEMIC' } });
    console.log('Backfilled contact details for demo lecturer');
  }
  const student = await prisma.user.findUnique({ where: { email: 'student@edocoe.edu.ng' } });
  if (student && !student.phone) {
    await prisma.user.update({ where: { id: student.id }, data: { phone: '+2348030000003' } });
    console.log('Backfilled contact details for demo student');
  }
  const admin = await prisma.user.findUnique({ where: { email: 'admin@edocoe.edu.ng' } });
  if (admin && !admin.phone) {
    await prisma.user.update({ where: { id: admin.id }, data: { phone: '+2348030000001' } });
    console.log('Backfilled contact details for demo admin');
  }
}

// Named hostels are a new model -- a school seeded before it existed has none, and any
// already-approved hostel application (like the demo student's) predates it too, so it
// has no hostelId to group under in the hostel-by-name admin view.
async function backfillHostels() {
  const school = await prisma.school.findFirst();
  if (!school) return;
  let daws = await prisma.hostel.findFirst({ where: { schoolId: school.id, name: 'Daws Hostel' } });
  if (!daws) {
    daws = await prisma.hostel.create({ data: { schoolId: school.id, name: 'Daws Hostel' } });
    await prisma.hostel.create({ data: { schoolId: school.id, name: 'Mammy Hostel' } });
    console.log('Backfilled example hostels: Daws Hostel, Mammy Hostel');
  }
  const orphanedApproved = await prisma.hostelApplication.findMany({
    where: { status: 'APPROVED', hostelId: null, student: { schoolId: school.id } },
  });
  for (const app of orphanedApproved) {
    await prisma.hostelApplication.update({ where: { id: app.id }, data: { hostelId: daws.id } });
  }
  if (orphanedApproved.length) console.log(`Backfilled hostelId onto ${orphanedApproved.length} pre-existing approved application(s)`);
}

if (require.main === module) {
  main()
    .catch((e) => {
      console.error(e);
      process.exit(1);
    })
    .finally(() => prisma.$disconnect());
}

module.exports = main;
