// How a written paper is set and timed at Nigerian higher institutions.
//
// The papers the SYSTEM writes for students (CBT mock exams, past-question practice, the semester
// exam of a self-study course, practice questions) are set like this:
//   Section A  20 objective questions   15 minutes   (0.75 minute each)
//   Section B   5 theory questions      40 minutes   (8 minutes each)
// Tests, quizzes, assignments and semester exams that a LECTURER sets are the lecturer's own: any
// number of questions, timed at 1 minute per question as before.
//
// What differs between institutions is the share of the marks the semester examination carries
// and how the theory questions are worded. The profiles below are written from the regulators'
// published standards:
//   Universities (NUC benchmark standards): semester examination 60-70% of the course mark,
//     continuous assessment 30-40%; papers run 1-3 hours.
//   Polytechnics and monotechnics (NBTE curricula): continuous assessment normally 40%, semester
//     examination 60%; theory and practical kept in roughly 60:40; the 5-point GPA scale with
//     A 75+, AB 70-74, B 65-69, BC 60-64, C 55-59, CD 50-54, D 45-49, E 40-44, F below 40.
//   Colleges of Education (NCCE): continuous assessment 40%, semester examination 60%.
// The profile fixes the paper's total mark (Section A + Section B) so that it matches the
// examination's share of the course mark.

// The yearly CBT mock and past-question papers (2016 to the current year) are fuller papers: 30 objective questions
// (15 minutes) and 5 theory questions (40 minutes), set in the style of that kind of institution.
const YEAR_PAPER = { OBJECTIVE: 30, THEORY: 5, FIRST_YEAR: 2016 };
function paperYears(now = new Date()) {
  const out = [];
  for (let y = Math.min(now.getFullYear(), 2026); y >= YEAR_PAPER.FIRST_YEAR; y--) out.push(y);
  return out;
}

const OBJECTIVE_PER_PAPER = 20;
const THEORY_PER_PAPER = 5;
const OBJECTIVE_MINUTES_EACH = 15 / OBJECTIVE_PER_PAPER;   // 0.75
const THEORY_MINUTES_EACH = 40 / THEORY_PER_PAPER;         // 8

// Minutes allowed for an assessment: the paper's own time if the system wrote it as a paper section,
// otherwise 1 minute per question (what lecturers' tests have always had).
function timingFor(assessment, questions) {
  const list = questions || assessment.questions || [];
  if (assessment.section && assessment.durationMin) return assessment.durationMin;
  return Math.max(1, list.length);
}

// The paper rule for a set of questions (each needs a questionType of 'THEORY' or anything else).
function minutesFor(questions) {
  const list = Array.isArray(questions) ? questions : [];
  const theory = list.filter((q) => q.questionType === 'THEORY').length;
  const objective = list.length - theory;
  return Math.max(1, Math.ceil(objective * OBJECTIVE_MINUTES_EACH + theory * THEORY_MINUTES_EACH));
}

const PROFILES = {
  UNIVERSITY: {
    label: 'University', body: 'NUC', examShare: 70, caShare: 30, theoryMarks: 10,
    guide: 'a university semester examination (NUC standards). Section B is five essay-type questions, each with parts (a), (b), (c) that build from definition to explanation to discussion, evaluation or application. Use command words such as "Define", "Explain", "Discuss", "Critically examine", "Distinguish between", "With the aid of examples, …", "Evaluate". Expect depth of argument, not one-line answers.',
    objectiveGuide: "Objective questions as a Nigerian university department sets them: a clear stem and four options (A to D); mostly application and analysis (case stems such as 'A student observes ... which of the following explains this?'), definitions and principles, 'Which of the following is NOT ...', and short numerical items where the course calls for them. Use the terminology of the standard university textbooks for the course.",
  },
  POLYTECHNIC: {
    label: 'Polytechnic (ND/HND)', body: 'NBTE', examShare: 60, caShare: 40, theoryMarks: 8,
    guide: 'a polytechnic (ND/HND) semester examination set to NBTE curricula. Section B is five structured questions, each with parts (a), (b), (c) using NBTE-style command words: "State", "List", "Define", "Describe", "Explain", "Differentiate between", "Outline", "Calculate", "Sketch and label" (only if no diagram is needed to read it). Favour practical, workplace and industry application of the course content, and short, precise answers over long essays.',
    objectiveGuide: 'Objective questions as an NBTE polytechnic department sets them: short, direct stems; practical and technical content (identify the correct procedure, tool, unit, standard or formula), workplace situations, and calculations with clean numbers. Use the terms of the NBTE course specification.',
  },
  MONOTECHNIC: {
    label: 'Monotechnic', body: 'NBTE', examShare: 60, caShare: 40, theoryMarks: 8,
    guide: 'a monotechnic semester examination (a single-discipline technical institution regulated by NBTE). Section B is five structured questions, each with parts (a), (b), (c) using NBTE-style command words ("State", "List", "Define", "Describe", "Explain", "Differentiate between", "Outline", "Calculate"). Stay close to the vocational competence the course builds: procedures, standards, safety, tools and real situations on the job.',
    objectiveGuide: 'Objective questions as a monotechnic sets them: short, direct stems on the vocational competence the course builds (procedures, standards, safety, tools, materials, real job situations), with calculations where the trade needs them. Use the terms of the NBTE course specification.',
  },
  COLLEGE_OF_EDUCATION: {
    label: 'College of Education (NCE)', body: 'NCCE', examShare: 60, caShare: 40, theoryMarks: 8,
    guide: 'a College of Education (NCE) semester examination set to NCCE minimum standards. Section B is five structured questions, each with parts (a), (b), (c): "Define/State", "Explain", then an application to teaching, such as "How would you apply this in a classroom?" or "Give two classroom examples". Keep the language clear and examination-friendly, and link content to the teacher-in-training\'s work where it fits the course.',
    objectiveGuide: 'Objective questions as a College of Education sets them under NCCE minimum standards: clear, direct stems on the NCE course content, balancing recall with application to teaching (learners, lesson planning, classroom management, curriculum), in simple examination-friendly English.',
  },
  OTHER: {
    label: 'Higher institution', body: null, examShare: 70, caShare: 30, theoryMarks: 10,
    guide: 'a Nigerian higher-institution semester examination. Section B is five structured questions, each with parts (a), (b), (c) running from recall to explanation to application.',
    objectiveGuide: 'Objective questions as a Nigerian higher institution sets them: a clear stem and four plausible options, covering recall, understanding and application of the course.',
  },
};

function profileFor(institutionType) {
  return PROFILES[institutionType] || PROFILES.OTHER;
}

// Section A is 1 mark per question; Section B carries the rest of the examination mark.
function totalMarks(profile) {
  return OBJECTIVE_PER_PAPER + THEORY_PER_PAPER * profile.theoryMarks;
}

// What the lists show for each assessment: how many of each kind and the time allowed.
function withTiming(a) {
  const qs = a.questions || [];
  const theory = qs.filter((q) => q.questionType === 'THEORY').length;
  const { questions, ...rest } = a;
  return { ...rest, objectiveCount: qs.length - theory, theoryCount: theory, minutes: timingFor(a, qs) };
}
// Questions are pulled for their type only (no text or answers) so a list stays light.
const TIMING_INCLUDE = { _count: { select: { questions: true } }, questions: { select: { questionType: true } } };

module.exports = {
  YEAR_PAPER, paperYears, timingFor, withTiming, TIMING_INCLUDE, OBJECTIVE_PER_PAPER, THEORY_PER_PAPER, minutesFor, PROFILES, profileFor, totalMarks };
