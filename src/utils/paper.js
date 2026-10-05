// How a written paper is set and timed at Nigerian higher institutions.
//
// One rule everywhere in the app (tests, mock exams, past-question practice, semester exams):
//   Section A  20 objective questions   15 minutes   (0.75 minute each)
//   Section B   5 theory questions      1 hour 30    (18 minutes each)
// A test with a different number of questions gets time in the same proportion.
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

const OBJECTIVE_PER_PAPER = 20;
const THEORY_PER_PAPER = 5;
const OBJECTIVE_MINUTES_EACH = 15 / OBJECTIVE_PER_PAPER;   // 0.75
const THEORY_MINUTES_EACH = 90 / THEORY_PER_PAPER;         // 18

// Minutes allowed for a set of questions (each needs a questionType of 'THEORY' or anything else).
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
  },
  POLYTECHNIC: {
    label: 'Polytechnic (ND/HND)', body: 'NBTE', examShare: 60, caShare: 40, theoryMarks: 8,
    guide: 'a polytechnic (ND/HND) semester examination set to NBTE curricula. Section B is five structured questions, each with parts (a), (b), (c) using NBTE-style command words: "State", "List", "Define", "Describe", "Explain", "Differentiate between", "Outline", "Calculate", "Sketch and label" (only if no diagram is needed to read it). Favour practical, workplace and industry application of the course content, and short, precise answers over long essays.',
  },
  MONOTECHNIC: {
    label: 'Monotechnic', body: 'NBTE', examShare: 60, caShare: 40, theoryMarks: 8,
    guide: 'a monotechnic semester examination (a single-discipline technical institution regulated by NBTE). Section B is five structured questions, each with parts (a), (b), (c) using NBTE-style command words ("State", "List", "Define", "Describe", "Explain", "Differentiate between", "Outline", "Calculate"). Stay close to the vocational competence the course builds: procedures, standards, safety, tools and real situations on the job.',
  },
  COLLEGE_OF_EDUCATION: {
    label: 'College of Education (NCE)', body: 'NCCE', examShare: 60, caShare: 40, theoryMarks: 8,
    guide: 'a College of Education (NCE) semester examination set to NCCE minimum standards. Section B is five structured questions, each with parts (a), (b), (c): "Define/State", "Explain", then an application to teaching, such as "How would you apply this in a classroom?" or "Give two classroom examples". Keep the language clear and examination-friendly, and link content to the teacher-in-training\'s work where it fits the course.',
  },
  OTHER: {
    label: 'Higher institution', body: null, examShare: 70, caShare: 30, theoryMarks: 10,
    guide: 'a Nigerian higher-institution semester examination. Section B is five structured questions, each with parts (a), (b), (c) running from recall to explanation to application.',
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
  return { ...rest, objectiveCount: qs.length - theory, theoryCount: theory, minutes: minutesFor(qs) };
}
// Questions are pulled for their type only (no text or answers) so a list stays light.
const TIMING_INCLUDE = { _count: { select: { questions: true } }, questions: { select: { questionType: true } } };

module.exports = { withTiming, TIMING_INCLUDE, OBJECTIVE_PER_PAPER, THEORY_PER_PAPER, minutesFor, PROFILES, profileFor, totalMarks };
