const ai = require('./aiProvider.service');

// Very small allowlist-by-removal SVG sanitizer -- strips script tags, event-handler
// attributes, and javascript: URIs before board content is ever trusted with
// innerHTML client-side. Matches the same safety posture PassNow uses for AI-drawn
// diagrams (an unreviewed AI-written SVG could otherwise carry an XSS payload).
function sanitizeSvg(svg) {
  if (!svg || typeof svg !== 'string') return '';
  return svg
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/\son\w+\s*=\s*(["']).*?\1/gi, '')
    .replace(/\son\w+\s*=\s*[^\s>]+/gi, '')
    .replace(/(href|xlink:href)\s*=\s*(["'])\s*javascript:.*?\2/gi, '');
}

function sanitizeBoardActions(actions) {
  if (!Array.isArray(actions)) return [];
  return actions
    .filter((a) => a && a.type && a.content != null)
    .map((a) => ({
      type: ['TEXT', 'EQUATION', 'DIAGRAM', 'GRAPH'].includes(a.type) ? a.type : 'TEXT',
      content: a.type === 'DIAGRAM' ? sanitizeSvg(String(a.content)) : a.content,
    }));
}

const LESSON_PLAN_SYSTEM = `You are an expert lecturer creating an interactive lesson for a Nigerian higher-institution (college of education) student. Reply with JSON only, matching exactly this shape:
{
  "title": string,
  "sections": [
    {
      "title": string,
      "boardText": string,
      "speechText": string,
      "checkQuestion": string | null,
      "boardActions": [
        { "type": "TEXT" | "EQUATION" | "DIAGRAM" | "GRAPH", "content": string }
      ]
    }
  ]
}
Rules:
- Exactly 3 sections, each covering one sub-topic. Keep every field concise -- this is generated live while a student waits, so a shorter response that arrives quickly beats a longer one that's slow.
- "boardText" is short bullet-style text a whiteboard would show (plain text, use "\\n" for line breaks, no markdown symbols) -- kept for backward compatibility, still fill it in.
- "speechText" is what the teacher says aloud for that section, in a warm, clear, conversational tone -- 3 to 5 sentences, not a lecture transcript.
- "checkQuestion" is a short open-ended comprehension question for exactly one section (null for the other two), checking the student understood that section.
- "boardActions" is what actually renders on the whiteboard, 1 to 2 items per section, richer than boardText where the topic calls for it:
  - "TEXT": short plain-text bullet points (like boardText).
  - "EQUATION": a single LaTeX expression as "content" (no $ delimiters), only when the topic is genuinely mathematical/scientific.
  - "DIAGRAM": a small, valid, self-contained inline SVG string as "content" (include a viewBox, keep it simple -- boxes, arrows, circles, labels), only when a labeled diagram would clarify the concept (e.g. a process flow, a labeled structure).
  - "GRAPH": "content" is a JSON string (not an object) of the shape {"type":"bar"|"line","labels":["A","B"],"values":[1,2]}, only when the topic involves comparing or trending numeric data.
  - Every section should have at least one TEXT action; only add EQUATION/DIAGRAM/GRAPH when they genuinely help, and never more than one non-TEXT action per section.
Return JSON only, no prose before or after.`;

const INTERRUPT_SYSTEM = `You are an interactive AI lecturer mid-lesson. A student just interrupted with a question. Reply with JSON only:
{
  "answer": string,
  "boardActions": [
    { "type": "TEXT" | "EQUATION" | "DIAGRAM" | "GRAPH", "content": string }
  ]
}
Answer clearly and briefly (2-4 sentences) in "answer", staying on the lesson's topic, in the same tone as a helpful lecturer. "boardActions" follows the same rules as a lesson section's board content (1-3 items, TEXT by default, EQUATION/DIAGRAM/GRAPH only when it genuinely clarifies the answer). Return JSON only.`;

const GRADE_SYSTEM = `You are grading a student's short spoken/typed answer to a comprehension check question during a lesson. Reply with JSON only:
{ "correct": boolean, "feedback": string }
"feedback" is one short encouraging sentence explaining what was right or what was missed. Be lenient with phrasing -- judge understanding, not exact wording. Return JSON only.`;

async function generateLessonPlan({ courseTitle, topic }) {
  const userPrompt = `Course: ${courseTitle}\nTopic to teach: ${topic}`;
  const plan = await ai.askForJson(LESSON_PLAN_SYSTEM, userPrompt);
  plan.sections = (plan.sections || []).map((s) => ({
    ...s,
    boardActions: sanitizeBoardActions(s.boardActions).length ? sanitizeBoardActions(s.boardActions) : [{ type: 'TEXT', content: s.boardText || '' }],
  }));
  return plan;
}

async function answerInterrupt({ courseTitle, topic, sectionTitle, question }) {
  const userPrompt = `Course: ${courseTitle}\nLesson topic: ${topic}\nCurrent section: ${sectionTitle}\nStudent's question: ${question}`;
  const result = await ai.askForJson(INTERRUPT_SYSTEM, userPrompt);
  const boardActions = sanitizeBoardActions(result.boardActions);
  // Every answer must land on the board, not just the chat log underneath it -- fall
  // back to the plain-text answer itself if the model returned no usable board content.
  return { ...result, boardActions: boardActions.length ? boardActions : [{ type: 'TEXT', content: result.answer || '' }] };
}

async function gradeCheckAnswer({ checkQuestion, studentAnswer }) {
  const userPrompt = `Question: ${checkQuestion}\nStudent's answer: ${studentAnswer}`;
  return ai.askForJson(GRADE_SYSTEM, userPrompt);
}

module.exports = { isConfigured: ai.isConfigured, generateLessonPlan, answerInterrupt, gradeCheckAnswer, synthesizeSpeech: ai.synthesizeSpeech, resamplePcm16: ai.resamplePcm16 };
