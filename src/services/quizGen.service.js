const ai = require('./aiProvider.service');

const TEST_SYSTEM_PROMPT = `You are writing a short multiple-choice quiz for a self-directed learner studying on their own. Reply with JSON only, matching exactly:
{
  "title": string,
  "questions": [
    { "text": string, "options": [string, string, string, string], "correctIndex": number }
  ]
}
Rules:
- Exactly 5 questions, each with exactly 4 options and one correct answer (correctIndex is 0-3).
- Questions should test real understanding of the topic, not trivia.
Return JSON only, no prose before or after.`;

const ASSIGNMENT_SYSTEM_PROMPT = `You are writing a short free-response assignment for a self-directed learner studying on their own -- there is no teacher to mark it, so the learner will compare their own answer against a model answer afterward. Reply with JSON only, matching exactly:
{
  "title": string,
  "questions": [
    { "text": string, "modelAnswer": string }
  ]
}
Rules:
- 1 to 3 open-ended questions that require a written explanation, not a one-word answer.
- "modelAnswer" is a model answer the learner can compare their own answer against -- 2 to 4 sentences.
Return JSON only, no prose before or after.`;

async function generateQuiz({ courseTitle, topic }) {
  const userPrompt = `Course of study: ${courseTitle}\nQuiz topic requested: ${topic}`;
  return ai.askForJson(TEST_SYSTEM_PROMPT, userPrompt);
}

async function generateAssignment({ courseTitle, topic }) {
  const userPrompt = `Course of study: ${courseTitle}\nAssignment topic requested: ${topic}`;
  return ai.askForJson(ASSIGNMENT_SYSTEM_PROMPT, userPrompt);
}

const SEMESTER_EXAM_SYSTEM_PROMPT = `You are writing a semester-ending multiple-choice exam for a self-directed learner studying on their own. Reply with JSON only, matching exactly:
{
  "title": string,
  "questions": [
    { "text": string, "options": [string, string, string, string], "correctIndex": number }
  ]
}
Rules:
- Exactly 15 questions, each with exactly 4 options and one correct answer (correctIndex is 0-3).
- Cover a broad spread of sub-topics within the course, testing real understanding, not trivia.
Return JSON only, no prose before or after.`;

async function generateSemesterExam({ courseTitle, topic }) {
  const userPrompt = `Course of study: ${courseTitle}\nSemester exam scope: ${topic}`;
  return ai.askForJson(SEMESTER_EXAM_SYSTEM_PROMPT, userPrompt);
}

module.exports = { generateQuiz, generateAssignment, generateSemesterExam };
