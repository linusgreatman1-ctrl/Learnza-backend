require('dotenv').config();
const bcrypt = require('bcryptjs');
const prisma = require('./db');

async function main() {
  const existing = await prisma.school.findFirst();
  if (existing) {
    console.log('Database already seeded, skipping.');
    return;
  }

  const school = await prisma.school.create({
    data: { name: 'Edo College of Education' },
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
      role: 'LECTURER',
      staffId: 'STF-014',
      departmentId: csc.id,
      schoolId: school.id,
    },
  });

  const studentPass = await bcrypt.hash('Student@123', 10);
  const student = await prisma.user.create({
    data: {
      fullName: 'Blessing Aigbogun',
      email: 'student@edocoe.edu.ng',
      passwordHash: studentPass,
      role: 'STUDENT',
      matricNumber: 'ECOE/23/CSC/041',
      departmentId: csc.id,
      schoolId: school.id,
    },
  });

  const csc101 = await prisma.course.create({
    data: { departmentId: csc.id, code: 'CSC 101', title: 'Introduction to Computer Science', level: 'NCE 1', semester: 'First' },
  });
  const csc102 = await prisma.course.create({
    data: { departmentId: csc.id, code: 'CSC 102', title: 'Introduction to Programming', level: 'NCE 1', semester: 'Second' },
  });
  await prisma.course.create({
    data: { departmentId: mth.id, code: 'MTH 101', title: 'Algebra and Trigonometry', level: 'NCE 1', semester: 'First' },
  });
  await prisma.course.create({
    data: { departmentId: eng.id, code: 'ENG 101', title: 'Use of English I', level: 'NCE 1', semester: 'First' },
  });
  await prisma.course.create({
    data: { departmentId: bio.id, code: 'BIO 101', title: 'General Biology I', level: 'NCE 1', semester: 'First' },
  });
  await prisma.course.create({
    data: { departmentId: ece.id, code: 'ECE 101', title: 'Foundations of Early Childhood Education', level: 'NCE 1', semester: 'First' },
  });
  await prisma.course.create({
    data: { departmentId: eco.id, code: 'ECO 101', title: 'Principles of Economics I', level: 'NCE 1', semester: 'First' },
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

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
