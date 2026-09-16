require('dotenv').config();
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const prisma = require('./db');
const { PLANS } = require('./config/plans');
const gamification = require('./services/gamification.service');

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
    await backfillLibraryTextbooks();
    await backfillPastQuestionsAndMocks();
    await backfillCourseSemesters();
    await backfillSubscriptionAiCredits();
    await backfillDemoStudentActivity();
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
  const mth101 = await prisma.course.create({
    data: { departmentId: mth.id, code: 'MTH 101', title: 'Algebra and Trigonometry', level: 'NCE 1', semester: 'First', semesterId: semester.id },
  });
  const eng101 = await prisma.course.create({
    data: { departmentId: eng.id, code: 'ENG 101', title: 'Use of English I', level: 'NCE 1', semester: 'First', semesterId: semester.id },
  });
  const bio101 = await prisma.course.create({
    data: { departmentId: bio.id, code: 'BIO 101', title: 'General Biology I', level: 'NCE 1', semester: 'First', semesterId: semester.id },
  });
  const ece101 = await prisma.course.create({
    data: { departmentId: ece.id, code: 'ECE 101', title: 'Foundations of Early Childhood Education', level: 'NCE 1', semester: 'First', semesterId: semester.id },
  });
  const eco101 = await prisma.course.create({
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

  await prisma.libraryResource.createMany({
    data: [
      {
        courseId: csc101.id,
        title: 'Computer Studies for Colleges of Education',
        author: 'A. O. Fagbola',
        publisher: 'Spectrum Books',
        type: 'Textbook',
        fileUrl: 'https://example.org/library/computer-studies-coe.pdf',
        uploaderId: lecturer.id,
      },
      {
        courseId: csc102.id,
        title: 'Fundamentals of Computer Programming',
        author: 'C. E. Onyekwelu',
        publisher: 'Ababa Press',
        type: 'Textbook',
        fileUrl: 'https://example.org/library/fundamentals-programming.pdf',
        uploaderId: lecturer.id,
      },
      {
        courseId: csc102.id,
        title: 'Introduction to Programming Logic - Past Questions 2020-2024',
        author: 'Edo COE Examinations Unit',
        type: 'Past Question',
        fileUrl: 'https://example.org/library/csc102-past-questions.pdf',
        uploaderId: lecturer.id,
      },
      {
        courseId: mth101.id,
        title: 'Further Mathematics Project',
        author: 'M. F. Macrae, A. O. Kalejaiye',
        publisher: 'Pearson Education',
        type: 'Textbook',
        fileUrl: 'https://example.org/library/further-mathematics-project.pdf',
        uploaderId: lecturer.id,
      },
      {
        courseId: eng101.id,
        title: 'Effective English for Colleges of Education',
        author: 'F. E. Ojiebun, E. Ehigie',
        publisher: 'University Press PLC',
        type: 'Textbook',
        fileUrl: 'https://example.org/library/effective-english-coe.pdf',
        uploaderId: lecturer.id,
      },
      {
        courseId: bio101.id,
        title: 'Modern Biology for Senior Colleges',
        author: 'S. T. Ramalingam',
        publisher: 'Africana FIRST Publishers',
        type: 'Textbook',
        fileUrl: 'https://example.org/library/modern-biology.pdf',
        uploaderId: lecturer.id,
      },
      {
        courseId: ece101.id,
        title: 'Foundations of Early Childhood Education in Nigeria',
        author: 'P. K. Osokoya',
        publisher: 'NERDC Press',
        type: 'Textbook',
        fileUrl: 'https://example.org/library/foundations-ece-nigeria.pdf',
        uploaderId: lecturer.id,
      },
      {
        courseId: eco101.id,
        title: 'Principles of Economics for Colleges of Education',
        author: 'R. A. Anyanwu',
        publisher: 'Onitsha Academy Press',
        type: 'Textbook',
        fileUrl: 'https://example.org/library/principles-of-economics-coe.pdf',
        uploaderId: lecturer.id,
      },
    ],
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
      aiSecondsGranted: 3600 * 60,
    },
    update: {
      status: 'ACTIVE',
      startedAt: new Date(),
      expiresAt: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
    },
  });
  console.log('Backfilled an active demo subscription for student@edocoe.edu.ng');
}

// Subscriptions created before AI credit metering existed (including the demo
// student's, upserted above -- but that upsert's own `update` branch is skipped
// whenever the row is already active, which it always is here) have
// aiSecondsGranted: 0, which would read as "no minutes left" the moment enforcement
// is ever turned on. Grant each of them their plan's allotment once.
async function backfillSubscriptionAiCredits() {
  const stale = await prisma.subscription.findMany({ where: { status: 'ACTIVE', aiSecondsGranted: 0 } });
  for (const sub of stale) {
    const planConfig = PLANS[sub.plan];
    if (!planConfig) continue;
    await prisma.subscription.update({ where: { id: sub.id }, data: { aiSecondsGranted: planConfig.aiMinutes * 60 } });
  }
  if (stale.length) console.log(`Backfilled AI credit allotment onto ${stale.length} pre-existing active subscription(s)`);
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
  if (!existing) {
    await prisma.semester.create({ data: { schoolId: school.id, name: 'First Semester 2025/2026', isCurrent: true } });
    console.log('Backfilled an initial semester');
  }
  // A school with only one semester can't show the 1st/2nd Semester tab pair on the
  // course browse screen -- every school should have both, even before it's time to
  // activate the second one.
  const second = await prisma.semester.findFirst({ where: { schoolId: school.id, name: { contains: 'Second' } } });
  if (!second) {
    await prisma.semester.create({ data: { schoolId: school.id, name: 'Second Semester 2025/2026', isCurrent: false } });
    console.log('Backfilled a second semester');
  }
}

// Courses created before the semester system existed (i.e. most of the real migrated
// data, and the original seed's own courses from before this field was added) have
// semesterId: null -- the new "Browse & enroll by semester" tabs filter by semesterId,
// so an un-migrated course would silently disappear from every tab. Attach them to
// the school's current semester rather than leaving them orphaned.
async function backfillCourseSemesters() {
  const current = await prisma.semester.findFirst({ where: { isCurrent: true } });
  if (!current) return;
  const result = await prisma.course.updateMany({
    where: { semesterId: null, department: { schoolId: current.schoolId } },
    data: { semesterId: current.id },
  });
  if (result.count) console.log(`Backfilled semesterId onto ${result.count} pre-existing course(s)`);
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

// The e-Library used to default to generic "Handout" uploads with no publisher; a
// school seeded before this existed only has the original two CSC entries. This adds
// a real textbook (with author and publisher) to every other department's course so
// the department/course browse view isn't empty, and backfills the publisher onto the
// pre-existing CSC101 entry that predates the field.
async function backfillLibraryTextbooks() {
  const lecturer = await prisma.user.findUnique({ where: { email: 'lecturer@edocoe.edu.ng' } });
  if (!lecturer) return;

  await prisma.libraryResource.updateMany({
    where: { title: 'Computer Studies for Colleges of Education', publisher: null },
    data: { publisher: 'Spectrum Books' },
  });

  const targets = [
    { code: 'CSC 102', title: 'Fundamentals of Computer Programming', author: 'C. E. Onyekwelu', publisher: 'Ababa Press', fileUrl: 'https://example.org/library/fundamentals-programming.pdf' },
    { code: 'MTH 101', title: 'Further Mathematics Project', author: 'M. F. Macrae, A. O. Kalejaiye', publisher: 'Pearson Education', fileUrl: 'https://example.org/library/further-mathematics-project.pdf' },
    { code: 'ENG 101', title: 'Effective English for Colleges of Education', author: 'F. E. Ojiebun, E. Ehigie', publisher: 'University Press PLC', fileUrl: 'https://example.org/library/effective-english-coe.pdf' },
    { code: 'BIO 101', title: 'Modern Biology for Senior Colleges', author: 'S. T. Ramalingam', publisher: 'Africana FIRST Publishers', fileUrl: 'https://example.org/library/modern-biology.pdf' },
    { code: 'ECE 101', title: 'Foundations of Early Childhood Education in Nigeria', author: 'P. K. Osokoya', publisher: 'NERDC Press', fileUrl: 'https://example.org/library/foundations-ece-nigeria.pdf' },
    { code: 'ECO 101', title: 'Principles of Economics for Colleges of Education', author: 'R. A. Anyanwu', publisher: 'Onitsha Academy Press', fileUrl: 'https://example.org/library/principles-of-economics-coe.pdf' },
  ];
  let added = 0;
  for (const t of targets) {
    const course = await prisma.course.findFirst({ where: { code: t.code } });
    if (!course) continue;
    const already = await prisma.libraryResource.findFirst({ where: { courseId: course.id, title: t.title } });
    if (already) continue;
    await prisma.libraryResource.create({
      data: { courseId: course.id, title: t.title, author: t.author, publisher: t.publisher, type: 'Textbook', fileUrl: t.fileUrl, uploaderId: lecturer.id },
    });
    added++;
  }
  if (added) console.log(`Backfilled ${added} textbook(s) into the e-Library`);
}

// A big bank of real past-question and mock-exam sets across every seeded course, so
// the Past Questions and CBT Mock Exam Practice hubs have real content to practice
// with instead of being empty. Idempotent by (courseCode, title).
async function backfillPastQuestionsAndMocks() {
  const lecturer = await prisma.user.findUnique({ where: { email: 'lecturer@edocoe.edu.ng' } });
  if (!lecturer) return;
  const semester = await prisma.semester.findFirst({ where: { isCurrent: true } });

  const mc = (text, options, correctIndex) => ({ text, options: JSON.stringify(options), correctIndex, questionType: 'OBJECTIVE' });

  const bank = [
    {
      code: 'CSC 101',
      pastQuestions: [
        mc('What is a computer?', ['A device for typing only', 'An electronic device that accepts, processes and outputs data', 'A type of calculator only', 'A device that only stores files'], 1),
        mc('Which of the following is an input device?', ['Keyboard', 'Monitor', 'Printer', 'Speaker'], 0),
        mc('RAM stands for?', ['Random Access Memory', 'Read Access Memory', 'Random Application Memory', 'Read Application Module'], 0),
        mc('Which generation of computers introduced the microprocessor?', ['First', 'Second', 'Third', 'Fourth'], 3),
        mc('The CPU is often referred to as the ____ of the computer.', ['brain', 'heart', 'eye', 'hand'], 0),
        mc('Which of these is an output device?', ['Mouse', 'Scanner', 'Monitor', 'Keyboard'], 2),
        mc('Software that manages computer hardware and provides services for programs is called?', ['Operating system', 'Compiler', 'Browser', 'Antivirus'], 0),
        mc('One byte is equal to how many bits?', ['4', '8', '16', '2'], 1),
      ],
      mock: [
        mc('The physical components of a computer are called?', ['Software', 'Hardware', 'Firmware', 'Wetware'], 1),
        mc('Which storage device is non-volatile?', ['RAM', 'Cache', 'Hard disk', 'Register'], 2),
        mc('ALU stands for?', ['Arithmetic Logic Unit', 'Array Logic Unit', 'Automatic Logic Unit', 'Arithmetic Language Unit'], 0),
        mc('Which of these is a secondary storage device?', ['RAM', 'Hard disk drive', 'Cache memory', 'Register'], 1),
        mc('The first generation of computers used?', ['Transistors', 'Vacuum tubes', 'Integrated circuits', 'Microprocessors'], 1),
        mc('A set of instructions that tells a computer what to do is called?', ['Hardware', 'Data', 'Program', 'Network'], 2),
        mc("Which of the following best describes 'data'?", ['Processed information', 'Raw unprocessed facts', 'A type of software', 'A computer virus'], 1),
        mc('The smallest unit of data in a computer is?', ['Byte', 'Nibble', 'Bit', 'Word'], 2),
      ],
    },
    {
      code: 'CSC 102',
      pastQuestions: [
        mc('An algorithm is best described as?', ['A programming language', 'A step-by-step procedure for solving a problem', 'A type of computer', 'A flowchart symbol'], 1),
        mc('Which of these is a graphical representation of an algorithm?', ['Pseudocode', 'Flowchart', 'Syntax', 'Variable'], 1),
        mc('In programming, a variable is used to?', ['Store a value that can change', 'Print text only', 'Draw shapes', 'Connect to the internet'], 0),
        mc('Which symbol in a flowchart represents a decision?', ['Rectangle', 'Oval', 'Diamond', 'Circle'], 2),
        mc('Pseudocode is?', ['Actual program code', 'An informal way of describing an algorithm using plain language', 'A type of computer virus', 'A hardware component'], 1),
        mc('A loop in programming is used to?', ['Repeat a set of instructions', 'Store data permanently', 'Delete a program', 'Connect two computers'], 0),
        mc('Which of the following is NOT a programming language?', ['Python', 'Java', 'C++', 'Microsoft Word'], 3),
        mc('The process of finding and fixing errors in a program is called?', ['Compiling', 'Debugging', 'Coding', 'Formatting'], 1),
      ],
      mock: [
        mc('A flowchart terminal symbol (oval) represents?', ['Start or End', 'A decision', 'An input', 'A process'], 0),
        mc("Which of these best defines a 'constant' in programming?", ['A value that can change during execution', 'A value that does not change during execution', 'A type of loop', 'A syntax error'], 1),
        mc('The three basic control structures in programming are sequence, selection and?', ['Iteration', 'Compilation', 'Declaration', 'Variable'], 0),
        mc('Which of the following is an arithmetic operator?', ['AND', '+', 'IF', 'WHILE'], 1),
        mc('A syntax error occurs when?', ['The logic of a program is wrong', 'The rules of the programming language are broken', 'The computer is switched off', 'The program runs too slowly'], 1),
        mc("What does 'IDE' stand for in programming?", ['Integrated Development Environment', 'Internal Data Exchange', 'Interactive Design Element', 'Instructional Data Engine'], 0),
        mc('Which control structure allows a program to make a choice?', ['Sequence', 'Iteration', 'Selection', 'Assignment'], 2),
        mc('A program written in a high-level language must be translated by a?', ['Compiler or interpreter', 'Mouse', 'Monitor', 'Modem'], 0),
      ],
    },
    {
      code: 'MTH 101',
      pastQuestions: [
        mc('Simplify: 3x + 5x', ['8x', '15x', '8x²', '2x'], 0),
        mc('Solve for x: 2x + 4 = 10', ['x=2', 'x=3', 'x=6', 'x=7'], 1),
        mc('What is the value of sin 90°?', ['0', '1', '-1', '0.5'], 1),
        mc('Factorize: x² - 9', ['(x-3)(x+3)', '(x-9)(x+1)', '(x-3)²', '(x+9)(x-1)'], 0),
        mc('What is the value of cos 0°?', ['0', '1', '-1', 'undefined'], 1),
        mc('The sum of angles in a triangle is?', ['90°', '180°', '270°', '360°'], 1),
        mc('Solve: x² = 16', ['x = 4 only', 'x = ±4', 'x = 8', 'x = 2'], 1),
        mc('What is the value of tan 45°?', ['0', '1', 'undefined', '-1'], 1),
      ],
      mock: [
        mc('Simplify: 7y - 2y + 3y', ['8y', '12y', '2y', '8y²'], 0),
        mc('Solve: 5x - 3 = 2x + 9', ['x=2', 'x=3', 'x=4', 'x=6'], 2),
        mc('What is the Pythagoras theorem used for?', ['Finding angles only', 'Relating the sides of a right-angled triangle', 'Solving quadratic equations', 'Calculating area of a circle'], 1),
        mc('Expand: (x + 2)(x + 3)', ['x²+5x+6', 'x²+6x+5', 'x²+5x+5', 'x²+6'], 0),
        mc('What is sin 30°?', ['0.5', '1', '0', '0.866'], 0),
        mc('The gradient of a straight line y = mx + c is represented by?', ['c', 'm', 'x', 'y'], 1),
        mc('Solve: 3(x - 2) = 9', ['x=3', 'x=5', 'x=6', 'x=2'], 1),
        mc('Which of these is a quadratic equation?', ['x + 2 = 0', 'x² + 2x + 1 = 0', '2x = 4', 'x/2 = 3'], 1),
      ],
    },
    {
      code: 'ENG 101',
      pastQuestions: [
        mc('Choose the correct spelling.', ['Accomodate', 'Acommodate', 'Accommodate', 'Acomodate'], 2),
        mc('Identify the noun in the sentence: "The teacher praised the diligent student."', ['praised', 'diligent', 'student', 'the'], 2),
        mc('A word that describes a noun is called a/an?', ['Verb', 'Adjective', 'Adverb', 'Pronoun'], 1),
        mc("Choose the correct synonym for 'happy'.", ['Sad', 'Joyful', 'Angry', 'Tired'], 1),
        mc('Which sentence is grammatically correct?', ['She go to school every day.', 'She goes to school every day.', 'She going to school every day.', 'She gone to school every day.'], 1),
        mc("The antonym of 'ancient' is?", ['Old', 'Modern', 'Ageless', 'Historic'], 1),
        mc('Identify the part of speech of the underlined word: "She sang beautifully."', ['Noun', 'Verb', 'Adverb', 'Adjective'], 2),
        mc('Choose the correctly punctuated sentence.', ['Its a beautiful day.', "It's a beautiful day.", "Its' a beautiful day.", "It is' a beautiful day."], 1),
      ],
      mock: [
        mc("Choose the plural form of 'child'.", ['Childs', 'Childes', 'Children', 'Childrens'], 2),
        mc('Which of these is a preposition?', ['Run', 'Quickly', 'Under', 'Happy'], 2),
        mc('Identify the correctly spelled word.', ['Recieve', 'Receive', 'Receeve', 'Receve'], 1),
        mc("What is the past tense of 'go'?", ['Goed', 'Gone', 'Went', 'Going'], 2),
        mc('Choose the correct sentence.', ['Neither of the boys were present.', 'Neither of the boys was present.', 'Neither of the boys is present.', 'Neither of the boys be present.'], 1),
        mc("The synonym of 'begin' is?", ['End', 'Commence', 'Stop', 'Finish'], 1),
        mc('Identify the conjunction in: "I wanted to go, but it was raining."', ['wanted', 'but', 'raining', 'go'], 1),
        mc('Which word is an abstract noun?', ['Table', 'Honesty', 'Chair', 'Book'], 1),
      ],
    },
    {
      code: 'BIO 101',
      pastQuestions: [
        mc('The basic unit of life is the?', ['Tissue', 'Cell', 'Organ', 'Organism'], 1),
        mc('Which organelle is known as the powerhouse of the cell?', ['Nucleus', 'Ribosome', 'Mitochondrion', 'Golgi body'], 2),
        mc('Photosynthesis occurs mainly in the?', ['Roots', 'Leaves', 'Stem', 'Flower'], 1),
        mc('Which of these is a characteristic of living things?', ['Rusting', 'Reproduction', 'Melting', 'Dissolving'], 1),
        mc('The process by which plants lose water vapor through their leaves is called?', ['Respiration', 'Transpiration', 'Photosynthesis', 'Excretion'], 1),
        mc('DNA is found mainly in the?', ['Cytoplasm', 'Cell wall', 'Nucleus', 'Cell membrane'], 2),
        mc('Which of these is NOT a kingdom in classification?', ['Animalia', 'Plantae', 'Fungi', 'Mineralia'], 3),
        mc('The green pigment found in plants that absorbs light for photosynthesis is called?', ['Melanin', 'Chlorophyll', 'Hemoglobin', 'Keratin'], 1),
      ],
      mock: [
        mc('Which structure controls what enters and leaves a cell?', ['Cell wall', 'Cell membrane', 'Nucleus', 'Vacuole'], 1),
        mc('The process of cell division for growth and repair is called?', ['Meiosis', 'Mitosis', 'Fertilization', 'Osmosis'], 1),
        mc('Which gas do plants absorb during photosynthesis?', ['Oxygen', 'Nitrogen', 'Carbon dioxide', 'Hydrogen'], 2),
        mc('The study of living organisms is called?', ['Chemistry', 'Physics', 'Biology', 'Geology'], 2),
        mc('Which of these is an example of asexual reproduction?', ['Binary fission', 'Fertilization', 'Pollination', 'Mating'], 0),
        mc('Enzymes are mainly composed of?', ['Carbohydrates', 'Proteins', 'Lipids', 'Water'], 1),
        mc('Which blood cells help fight infection?', ['Red blood cells', 'White blood cells', 'Platelets', 'Plasma'], 1),
        mc('The movement of water molecules from a region of high concentration to low concentration through a semi-permeable membrane is called?', ['Diffusion', 'Osmosis', 'Active transport', 'Filtration'], 1),
      ],
    },
    {
      code: 'ECE 101',
      pastQuestions: [
        mc('Early childhood education generally covers children within the age range of?', ['0-8 years', '10-15 years', '15-18 years', '18-25 years'], 0),
        mc('Who is regarded as the father of Kindergarten education?', ['John Dewey', 'Friedrich Froebel', 'Jean Piaget', 'Maria Montessori'], 1),
        mc('Play in early childhood education is important mainly because it?', ['Wastes time', 'Aids physical, social and cognitive development', 'Has no educational value', 'Is only for entertainment'], 1),
        mc('Which theorist is known for the stages of cognitive development?', ['Lev Vygotsky', 'Jean Piaget', 'B.F. Skinner', 'Sigmund Freud'], 1),
        mc('A conducive learning environment for young children should be?', ['Safe, stimulating and child-friendly', 'Strict and silent at all times', 'Free of toys and play materials', 'Restricted to indoor activities only'], 0),
        mc('The Montessori method of education emphasizes?', ['Rote memorization', 'Child-directed, hands-on learning', 'Large class lectures', 'Standardized testing only'], 1),
        mc("Which domain of development refers to a child's ability to interact with others?", ['Physical', 'Cognitive', 'Social-emotional', 'Language'], 2),
        mc('The National Policy on Education in Nigeria recognizes early childhood education as beginning at what age?', ['0-3 years', '3-5 years', '6-8 years', '9-11 years'], 1),
      ],
      mock: [
        mc("Which of these best describes 'readiness' in early childhood education?", ['A child\'s ability to read fluently', "A child's developmental preparedness to learn a new skill", "A teacher's lesson plan", 'A type of classroom furniture'], 1),
        mc('Vygotsky\'s concept of the "Zone of Proximal Development" refers to?', ['Tasks a child can do alone', 'Tasks a child can do with guidance but not alone yet', 'Tasks a child cannot do at all', 'A physical classroom zone'], 1),
        mc('Which of these is a fine motor skill?', ['Running', 'Jumping', 'Holding a pencil', 'Climbing stairs'], 2),
        mc('A good early childhood curriculum should be?', ['Rigid and exam-focused', 'Play-based and developmentally appropriate', 'Focused only on writing', 'Designed only for gifted children'], 1),
        mc("The main caregiver's role in a child's early years includes?", ['Providing nurture, safety and stimulation', "Ignoring the child's needs", 'Enforcing strict silence', 'Preventing all play'], 0),
        mc('Which of these is an example of gross motor skill development?', ['Buttoning a shirt', 'Running and jumping', 'Cutting with scissors', 'Drawing a straight line'], 1),
        mc('Language development in early childhood is best supported by?', ['Talking, reading and singing with the child', "Limiting the child's exposure to speech", 'Only using flashcards', 'Discouraging questions'], 0),
        mc('What is the primary aim of early childhood education?', ['Preparing children for formal examinations only', 'Holistic development of the child', 'Teaching only academic subjects', 'Reducing the number of caregivers needed'], 1),
      ],
    },
    {
      code: 'ECO 101',
      pastQuestions: [
        mc('Economics is best defined as the study of?', ['How to make money quickly', 'How society allocates scarce resources', 'Government spending only', 'Business advertising'], 1),
        mc('The basic economic problem is caused by?', ['Too much money in circulation', 'Scarcity of resources relative to unlimited wants', 'Too many banks', 'Excess production'], 1),
        mc('Demand refers to?', ['The desire to own a good', 'The quantity of a good buyers are willing and able to buy at a given price', 'The total goods produced', 'The price of a good'], 1),
        mc('According to the law of demand, as price increases, quantity demanded generally?', ['Increases', 'Decreases', 'Stays the same', 'Doubles'], 1),
        mc('Which of these is a factor of production?', ['Advertising', 'Land', 'Profit', 'Demand'], 1),
        mc('Opportunity cost refers to?', ['The total cost of production', 'The value of the next best alternative forgone', 'The price of a good', 'Government tax on goods'], 1),
        mc('A market where goods are bought and sold is an example of?', ['Production', 'Exchange', 'Consumption', 'Distribution'], 1),
        mc("Which of these best describes 'supply'?", ['The desire to buy goods', 'The quantity of a good producers are willing and able to sell at a given price', 'The demand for a good', 'Government spending'], 1),
      ],
      mock: [
        mc('The law of supply states that as price increases, quantity supplied generally?', ['Decreases', 'Increases', 'Stays constant', 'Becomes zero'], 1),
        mc('Which economic system is characterized by government ownership of resources?', ['Capitalism', 'Socialism', 'Mixed economy', 'Barter economy'], 1),
        mc('The point where the supply and demand curves intersect is called?', ['Equilibrium point', 'Break-even point', 'Saturation point', 'Peak point'], 0),
        mc('Which of these is NOT a factor of production?', ['Land', 'Labour', 'Capital', 'Advertising'], 3),
        mc('Inflation refers to?', ['A general and sustained rise in price level', 'A fall in the price of goods', 'An increase in the value of money', 'A decrease in government spending'], 0),
        mc("Which of the following best describes a 'mixed economy'?", ['An economy run entirely by government', 'An economy run entirely by private individuals', 'An economy combining both private and government control', 'An economy with no trade'], 2),
        mc('Gross Domestic Product (GDP) measures?', ['The total value of goods and services produced in a country within a period', 'The population of a country', 'The total taxes collected', 'The exchange rate of a currency'], 0),
        mc('Which of these is an example of indirect tax?', ['Income tax', 'Value Added Tax (VAT)', 'Company tax', 'Property tax'], 1),
      ],
    },
  ];

  let created = 0;
  for (const entry of bank) {
    const course = await prisma.course.findFirst({ where: { code: entry.code } });
    if (!course) continue;
    const pqTitle = `${entry.code} Past Questions 2022-2024`;
    if (!(await prisma.assessment.findFirst({ where: { courseId: course.id, title: pqTitle } }))) {
      await prisma.assessment.create({
        data: {
          courseId: course.id, title: pqTitle, type: 'PAST_QUESTION', authorId: lecturer.id,
          durationMin: 20, semesterId: semester ? semester.id : null,
          questions: { create: entry.pastQuestions.map((q, i) => ({ ...q, order: i })) },
        },
      });
      created++;
    }
    const mockTitle = `${entry.code} Mock Exam`;
    if (!(await prisma.assessment.findFirst({ where: { courseId: course.id, title: mockTitle } }))) {
      await prisma.assessment.create({
        data: {
          courseId: course.id, title: mockTitle, type: 'Mock', authorId: lecturer.id,
          durationMin: 20, semesterId: semester ? semester.id : null,
          questions: { create: entry.mock.map((q, i) => ({ ...q, order: i })) },
        },
      });
      created++;
    }
  }
  if (created) console.log(`Backfilled ${created} past-question/mock-exam set(s) across ${bank.length} courses`);
}

// The demo student account (Blessing Aigbogun) is what the user actually clicks
// through to check every feature, so it needs to be fully populated everywhere --
// results across every assessment type, marked assignments, attendance, formal
// results, a study group with messages, an issued credential, and cleared
// transcript/clearance/hostel requests -- rather than showing empty states. Every
// piece here is idempotent (checked before created) like every other backfill.
async function backfillDemoStudentActivity() {
  const student = await prisma.user.findUnique({ where: { email: 'student@edocoe.edu.ng' } });
  const lecturer = await prisma.user.findUnique({ where: { email: 'lecturer@edocoe.edu.ng' } });
  if (!student || !lecturer) return;
  const semester = await prisma.semester.findFirst({ where: { isCurrent: true } });
  const school = await prisma.school.findFirst();
  if (!school) return;

  const mc = (text, options, correctIndex) => ({ text, options: JSON.stringify(options), correctIndex, questionType: 'OBJECTIVE' });

  const courseData = [
    {
      code: 'CSC 101',
      ca: [
        mc('The device used to point and click on a computer screen is called a?', ['Keyboard', 'Mouse', 'Monitor', 'Printer'], 1),
        mc('Which of these stores data permanently even when the computer is off?', ['RAM', 'Hard disk', 'Cache', 'Register'], 1),
        mc('The full form of CPU is?', ['Central Processing Unit', 'Computer Processing Unit', 'Central Program Unit', 'Central Processor Utility'], 0),
        mc('Which of these is system software?', ['Word processor', 'Operating system', 'Spreadsheet', 'Web browser'], 1),
      ],
      exam: [
        mc('The binary number system uses only which digits?', ['0 and 1', '0 to 9', 'A to F', '1 and 2'], 0),
        mc('Which part of the computer performs calculations?', ['ALU', 'Monitor', 'Keyboard', 'Printer'], 0),
        mc('A computer virus is a type of?', ['Hardware', 'Malicious software', 'Input device', 'Network cable'], 1),
        mc('The first computers were programmed using?', ['Machine language', 'Python', 'Java', 'HTML'], 0),
      ],
      assignmentTitle: 'Assignment 1: Computer Hardware Essay',
      assignmentInstructions: 'Write a 300-word essay describing the four main hardware components of a computer and their functions.',
    },
    {
      code: 'CSC 102',
      ca: [
        mc('Which of these is a valid variable declaration concept?', ['A named storage location for data', 'A printed document', 'A hardware chip', 'A monitor setting'], 0),
        mc('What does "debugging" mean?', ['Writing new code', 'Finding and fixing errors', 'Deleting a program', 'Installing software'], 1),
        mc('Which of these repeats a block of code a fixed number of times?', ['A for loop', 'An if statement', 'A print statement', 'A variable'], 0),
        mc('A function in programming is used to?', ['Group reusable code together', 'Store a single number', 'Connect to the internet', 'Format text only'], 0),
      ],
      exam: [
        mc("Which of these best describes an 'array'?", ['A single value', 'A collection of values stored together', 'A type of loop', 'A software license'], 1),
        mc('What is the output of a program called?', ['Input', 'Output', 'Algorithm', 'Syntax'], 1),
        mc('Which symbol commonly starts a comment in many programming languages?', ['//', '++', '%%', '&&'], 0),
        mc("A compiler's main job is to?", ['Translate source code into machine code', 'Connect to the internet', 'Print documents', 'Play music'], 0),
      ],
      assignmentTitle: 'Assignment 1: Write an Algorithm',
      assignmentInstructions: 'Write pseudocode and draw a flowchart for an algorithm that finds the largest of three numbers.',
    },
    {
      code: 'MTH 101',
      ca: [
        mc('Solve: x + 7 = 12', ['x=3', 'x=5', 'x=19', 'x=7'], 1),
        mc('Simplify: 4(x+2)', ['4x+2', '4x+8', 'x+8', '4x+6'], 1),
        mc('What is 15% of 200?', ['15', '30', '45', '20'], 1),
        mc('The value of x in 2x=10 is?', ['2', '5', '10', '20'], 1),
      ],
      exam: [
        mc('What is the value of pi (π) approximately?', ['3.14', '2.71', '1.41', '4.13'], 0),
        mc('Solve: x² - 4 = 0', ['x=2 or x=-2', 'x=4', 'x=0', 'x=-4'], 0),
        mc('The perimeter of a square with side 5cm is?', ['10cm', '20cm', '25cm', '15cm'], 1),
        mc('What is 7! (7 factorial) divided by 6!?', ['1', '7', '42', '6'], 1),
      ],
      assignmentTitle: 'Assignment 1: Algebra Problem Set',
      assignmentInstructions: 'Solve the 10 linear and quadratic equations distributed in class and show all working.',
    },
    {
      code: 'ENG 101',
      ca: [
        mc('Choose the correct form: "She ___ to school every day."', ['go', 'goes', 'going', 'gone'], 1),
        mc('Identify the verb: "The dog barked loudly."', ['dog', 'barked', 'loudly', 'the'], 1),
        mc('Which of these is a proper noun?', ['city', 'London', 'river', 'mountain'], 1),
        mc('The plural of "mouse" (the animal) is?', ['Mouses', 'Mice', 'Mouse', 'Mices'], 1),
      ],
      exam: [
        mc("Choose the synonym for 'rapid':", ['Slow', 'Quick', 'Quiet', 'Heavy'], 1),
        mc('Identify the correctly spelled word.', ['Definately', 'Definitely', 'Definitly', 'Deffinitely'], 1),
        mc('"Although it was raining, we went out." — "Although" is a?', ['Noun', 'Preposition', 'Conjunction', 'Adjective'], 2),
        mc("The opposite of 'generous' is?", ['Kind', 'Stingy', 'Wealthy', 'Friendly'], 1),
      ],
      assignmentTitle: 'Assignment 1: Descriptive Essay',
      assignmentInstructions: 'Write a 250-word descriptive essay on "My First Day on Campus", paying attention to grammar and structure.',
    },
    {
      code: 'BIO 101',
      ca: [
        mc('Which of these is a producer in an ecosystem?', ['Lion', 'Grass', 'Eagle', 'Human'], 1),
        mc('The human body system responsible for breathing is the?', ['Digestive system', 'Respiratory system', 'Skeletal system', 'Nervous system'], 1),
        mc('Which organ pumps blood around the body?', ['Liver', 'Heart', 'Kidney', 'Lungs'], 1),
        mc('Plants make their own food through a process called?', ['Respiration', 'Photosynthesis', 'Digestion', 'Excretion'], 1),
      ],
      exam: [
        mc('Which of these is NOT a vertebrate?', ['Fish', 'Bird', 'Insect', 'Mammal'], 2),
        mc('The powerhouse of the cell is the?', ['Nucleus', 'Mitochondrion', 'Ribosome', 'Vacuole'], 1),
        mc('Which gas is essential for respiration in humans?', ['Carbon dioxide', 'Oxygen', 'Nitrogen', 'Hydrogen'], 1),
        mc('A group of similar cells performing the same function is called a?', ['Organ', 'Tissue', 'System', 'Organism'], 1),
      ],
      assignmentTitle: 'Assignment 1: Ecosystem Report',
      assignmentInstructions: 'Describe a local ecosystem, identifying at least 3 producers, 3 consumers and 1 decomposer.',
    },
    {
      code: 'ECE 101',
      ca: [
        mc("The first three years of a child's life are best described as?", ['Adolescence', 'Early infancy/toddlerhood', 'Middle childhood', 'Puberty'], 1),
        mc('Which of these promotes social development in young children?', ['Isolation', 'Group play', 'Silence', 'Long lectures'], 1),
        mc("A 'milestone' in child development refers to?", ['A type of toy', 'A key stage of development reached at a typical age', 'A school building', 'A test score'], 1),
        mc('Storytelling in early childhood helps develop?', ['Language skills', 'Physical strength only', 'Mathematical skills only', 'None of these'], 0),
      ],
      exam: [
        mc('Who proposed the theory of psychosocial development?', ['Erik Erikson', 'Isaac Newton', 'Charles Darwin', 'Karl Marx'], 0),
        mc('A low caregiver-to-child ratio (few children per caregiver) generally leads to?', ['Worse care', 'Better individual attention', 'No difference', 'Higher cost only'], 1),
        mc('Which of these is an indoor gross motor activity?', ['Dancing', 'Reading silently', 'Painting', 'Puzzle solving'], 0),
        mc('Early childhood education programs are best evaluated by?', ['Child outcomes and development', 'Building size only', 'Number of staff only', 'Number of toys only'], 0),
      ],
      assignmentTitle: 'Assignment 1: Observation Report',
      assignmentInstructions: 'Observe a child aged 3-5 for 30 minutes and write a report describing their social, physical and language development.',
    },
    {
      code: 'ECO 101',
      ca: [
        mc("Which of these best defines 'goods'?", ['Tangible items that satisfy wants', 'Only services', 'Government policies', 'Bank loans'], 0),
        mc('A rise in the general price level over time is called?', ['Deflation', 'Inflation', 'Recession', 'Depreciation'], 1),
        mc('Which of these is a need, not a want?', ['Food', 'Jewelry', 'Video games', 'Vacation'], 0),
        mc('The study of individual markets and consumers is called?', ['Macroeconomics', 'Microeconomics', 'Public finance', 'International trade'], 1),
      ],
      exam: [
        mc('GDP stands for?', ['Gross Domestic Product', 'General Development Plan', 'Global Domestic Price', 'Gross Direct Profit'], 0),
        mc("Which of these best describes 'unemployment'?", ['People not seeking work at all', 'People able and willing to work but without a job', 'Retired persons', 'Students'], 1),
        mc("A central bank's main tool for controlling money supply is?", ['Advertising', 'Monetary policy', 'Farming subsidies', 'Tourism'], 1),
        mc('Which sector produces raw materials?', ['Primary sector', 'Secondary sector', 'Tertiary sector', 'Quaternary sector'], 0),
      ],
      assignmentTitle: 'Assignment 1: Demand and Supply',
      assignmentInstructions: 'Draw and explain a demand-and-supply diagram for rice in Nigeria, showing what happens if the price of fertilizer rises.',
    },
  ];

  let created = 0;
  for (const entry of courseData) {
    const course = await prisma.course.findFirst({ where: { code: entry.code } });
    if (!course) continue;

    await prisma.enrollment.upsert({
      where: { studentId_courseId: { studentId: student.id, courseId: course.id } },
      create: { studentId: student.id, courseId: course.id },
      update: {},
    });

    for (const [type, questions, scoreOutOf4] of [['CA', entry.ca, 4], ['SEMESTER_EXAM', entry.exam, 3]]) {
      const title = type === 'CA' ? `${entry.code} Continuous Assessment 1` : `${entry.code} Semester Exam`;
      let assessment = await prisma.assessment.findFirst({ where: { courseId: course.id, title } });
      if (!assessment) {
        assessment = await prisma.assessment.create({
          data: {
            courseId: course.id, title, type, authorId: lecturer.id, durationMin: 20,
            semesterId: semester ? semester.id : null,
            questions: { create: questions.map((q, i) => ({ ...q, order: i })) },
          },
          include: { questions: true },
        });
        created++;
      } else {
        assessment = await prisma.assessment.findUnique({ where: { id: assessment.id }, include: { questions: true } });
      }

      const existingSub = await prisma.submission.findUnique({
        where: { assessmentId_studentId: { assessmentId: assessment.id, studentId: student.id } },
      });
      if (!existingSub || !existingSub.submittedAt) {
        const qs = assessment.questions;
        const numCorrect = Math.min(scoreOutOf4, qs.length);
        const answers = qs.map((q, i) => ({ questionId: q.id, choice: i < numCorrect ? q.correctIndex : (q.correctIndex + 1) % 4 }));
        await prisma.submission.upsert({
          where: { assessmentId_studentId: { assessmentId: assessment.id, studentId: student.id } },
          create: { assessmentId: assessment.id, studentId: student.id, startedAt: new Date(), answers: JSON.stringify(answers), score: numCorrect, total: qs.length, submittedAt: new Date() },
          update: { answers: JSON.stringify(answers), score: numCorrect, total: qs.length, submittedAt: new Date() },
        });
        await gamification.recordAssessmentCompletion(student.id, numCorrect, qs.length);
        created++;
      }
    }

    // Assignment + a marked submission with lecturer feedback.
    let assignment = await prisma.assignment.findFirst({ where: { courseId: course.id, title: entry.assignmentTitle } });
    if (!assignment) {
      assignment = await prisma.assignment.create({
        data: { courseId: course.id, title: entry.assignmentTitle, instructions: entry.assignmentInstructions, authorId: lecturer.id, semesterId: semester ? semester.id : null, dueAt: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000) },
      });
      created++;
    }
    const existingAssignmentSub = await prisma.assignmentSubmission.findUnique({
      where: { assignmentId_studentId: { assignmentId: assignment.id, studentId: student.id } },
    });
    if (!existingAssignmentSub) {
      await prisma.assignmentSubmission.create({
        data: {
          assignmentId: assignment.id, studentId: student.id,
          answerText: 'Submitted assignment (demo answer for illustration purposes).',
          status: 'MARKED', score: 8, feedback: 'Well structured and on-topic — good work. Watch your referencing next time.',
          markedAt: new Date(),
        },
      });
      created++;
    }

    // Attendance: 5 recent class days, mostly present.
    const attendanceCount = await prisma.classAttendanceRecord.count({ where: { courseId: course.id, studentId: student.id } });
    if (attendanceCount === 0) {
      const statuses = ['PRESENT', 'PRESENT', 'ABSENT', 'PRESENT', 'PRESENT'];
      for (let i = 0; i < statuses.length; i++) {
        const date = new Date(Date.now() - (statuses.length - i) * 7 * 24 * 60 * 60 * 1000);
        date.setHours(0, 0, 0, 0);
        await prisma.classAttendanceRecord.create({
          data: { courseId: course.id, studentId: student.id, date, status: statuses[i], markedById: lecturer.id, semesterId: semester ? semester.id : null },
        });
      }
      created++;
    }

    // Formal (lecturer-published) result.
    const existingResult = await prisma.result.findFirst({ where: { courseId: course.id, studentId: student.id } });
    if (!existingResult) {
      await prisma.result.create({
        data: {
          courseId: course.id, studentId: student.id, authorId: lecturer.id,
          term: semester ? semester.name : '1st Semester 2025/2026', semesterId: semester ? semester.id : null,
          score: 78, grade: 'B', remark: 'Good performance, keep it up.',
        },
      });
      created++;
    }
  }

  // Study group with a few messages, in her first course.
  const csc101 = await prisma.course.findFirst({ where: { code: 'CSC 101' } });
  if (csc101) {
    let group = await prisma.studyGroup.findFirst({ where: { courseId: csc101.id } });
    if (!group) {
      group = await prisma.studyGroup.create({ data: { courseId: csc101.id, name: 'CSC101 Study Buddies', creatorId: student.id } });
      created++;
    }
    await prisma.groupMembership.upsert({
      where: { groupId_studentId: { groupId: group.id, studentId: student.id } },
      create: { groupId: group.id, studentId: student.id },
      update: {},
    });
    const messageCount = await prisma.groupMessage.count({ where: { groupId: group.id } });
    if (messageCount === 0) {
      await prisma.groupMessage.createMany({
        data: [
          { groupId: group.id, senderId: student.id, body: 'Hi everyone! Does anyone have notes from Monday\'s class?' },
          { groupId: group.id, senderId: student.id, body: 'I found the past questions for CSC101 in the e-Library — really helpful for revision.' },
        ],
      });
      created++;
    }
  }

  // Credential, transcript/clearance/hostel requests -- all in a fully-resolved state
  // so every Digital ID row shows real, complete data rather than a pending button.
  const existingCredential = await prisma.credential.findFirst({ where: { studentId: student.id } });
  if (!existingCredential) {
    await prisma.credential.create({
      data: { studentId: student.id, title: "Dean's List Certificate — 1st Semester 2025/2026", verifyCode: crypto.randomBytes(6).toString('hex') },
    });
    created++;
  }

  const existingTranscript = await prisma.transcriptRequest.findFirst({ where: { studentId: student.id } });
  if (!existingTranscript) {
    await prisma.transcriptRequest.create({ data: { studentId: student.id, status: 'ISSUED', issuedAt: new Date() } });
    created++;
  } else if (existingTranscript.status !== 'ISSUED') {
    await prisma.transcriptRequest.update({ where: { id: existingTranscript.id }, data: { status: 'ISSUED', issuedAt: new Date() } });
    created++;
  }

  const existingClearance = await prisma.clearanceRequest.findFirst({ where: { studentId: student.id } });
  if (!existingClearance) {
    await prisma.clearanceRequest.create({ data: { studentId: student.id, status: 'CLEARED', decidedAt: new Date() } });
    created++;
  } else if (existingClearance.status === 'PENDING') {
    await prisma.clearanceRequest.update({ where: { id: existingClearance.id }, data: { status: 'CLEARED', decidedAt: new Date() } });
    created++;
  }

  const existingHostelApp = await prisma.hostelApplication.findFirst({ where: { studentId: student.id } });
  if (!existingHostelApp || existingHostelApp.status !== 'APPROVED') {
    const hostel = await prisma.hostel.findFirst({ where: { schoolId: school.id } });
    if (existingHostelApp) {
      await prisma.hostelApplication.update({ where: { id: existingHostelApp.id }, data: { status: 'APPROVED', hostelId: hostel ? hostel.id : null, roomAssigned: 'Room 14, Block B', decidedAt: new Date() } });
    } else {
      await prisma.hostelApplication.create({ data: { studentId: student.id, status: 'APPROVED', hostelId: hostel ? hostel.id : null, roomAssigned: 'Room 14, Block B', decidedAt: new Date() } });
    }
    created++;
  }

  // A couple of read/unread notifications so the dashboard's notification list isn't empty.
  const notifCount = await prisma.notification.count({ where: { userId: student.id } });
  if (notifCount === 0) {
    await prisma.notification.createMany({
      data: [
        { userId: student.id, title: 'Assignment marked', body: 'Your CSC 101 assignment has been marked — score 8/10.', link: 'my-dashboard' },
        { userId: student.id, title: 'Welcome to Learnza', body: 'Explore My Dashboard, e-Library and Study Groups to get started.', link: 'my-dashboard', read: true },
      ],
    });
    created++;
  }

  if (created) console.log(`Backfilled ${created} demo-student activity item(s) for Blessing Aigbogun`);
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
