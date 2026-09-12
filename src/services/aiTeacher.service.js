const ai = require('./aiProvider.service');

const LESSON_PLAN_SYSTEM = `You are an expert lecturer creating an interactive lesson for a Nigerian higher-institution (college of education) student. Reply with JSON only, matching exactly this shape:
{
  "title": string,
  "sections": [
    { "title": string, "boardText": string, "speechText": string, "checkQuestion": string | null }
  ]
}
Rules:
- 4 to 6 sections, each covering one sub-topic.
- "boardText" is short bullet-style text a whiteboard would show (plain text, use "\\n" for line breaks, no markdown symbols).
- "speechText" is what the teacher says aloud for that section, in a warm, clear, conversational tone -- longer and more explanatory than boardText.
- "checkQuestion" is a short open-ended comprehension question for about half the sections (null for the rest), checking the student understood that section.
Return JSON only, no prose before or after.`;

const INTERRUPT_SYSTEM = `You are an interactive AI lecturer mid-lesson. A student just interrupted with a question. Reply with JSON only:
{ "answer": string }
Answer clearly and briefly (2-4 sentences), staying on the lesson's topic, in the same tone as a helpful lecturer. Return JSON only.`;

const GRADE_SYSTEM = `You are grading a student's short spoken/typed answer to a comprehension check question during a lesson. Reply with JSON only:
{ "correct": boolean, "feedback": string }
"feedback" is one short encouraging sentence explaining what was right or what was missed. Be lenient with phrasing -- judge understanding, not exact wording. Return JSON only.`;

async function generateLessonPlan({ courseTitle, topic }) {
  const userPrompt = `Course: ${courseTitle}\nTopic to teach: ${topic}`;
  return ai.askForJson(LESSON_PLAN_SYSTEM, userPrompt);
}

async function answerInterrupt({ courseTitle, topic, sectionTitle, question }) {
  const userPrompt = `Course: ${courseTitle}\nLesson topic: ${topic}\nCurrent section: ${sectionTitle}\nStudent's question: ${question}`;
  return ai.askForJson(INTERRUPT_SYSTEM, userPrompt);
}

async function gradeCheckAnswer({ checkQuestion, studentAnswer }) {
  const userPrompt = `Question: ${checkQuestion}\nStudent's answer: ${studentAnswer}`;
  return ai.askForJson(GRADE_SYSTEM, userPrompt);
}

module.exports = { isConfigured: ai.isConfigured, generateLessonPlan, answerInterrupt, gradeCheckAnswer };
