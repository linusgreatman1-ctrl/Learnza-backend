const ai = require('./aiProvider.service');

const SYSTEM_PROMPT = `You are designing a practical/laboratory demonstration for a Nigerian higher-institution course. Reply with JSON only, matching exactly:
{
  "title": string,
  "description": string,
  "steps": [
    { "title": string, "instruction": string, "expectedResult": string }
  ]
}
Rules:
- 4 to 8 steps, safe for a student to follow without specialist supervision (no hazardous chemicals, high voltage, or anything requiring protective equipment the student is unlikely to have).
- If the topic genuinely requires a real physical lab with safety equipment, instead describe a safe simulation, observation, or thought-experiment version of it, and say so in the description.
- "instruction" is what the student does; "expectedResult" is what they should observe or conclude.
Return JSON only, no prose before or after.`;

async function generateDemonstration({ courseTitle, topic }) {
  const userPrompt = `Course: ${courseTitle}\nPractical topic requested: ${topic}`;
  return ai.askForJson(SYSTEM_PROMPT, userPrompt);
}

module.exports = { generateDemonstration };
