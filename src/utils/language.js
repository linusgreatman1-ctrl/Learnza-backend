// The languages Learnza speaks. Three choices are kept apart on purpose: the language of the app's screens
// (uiLanguage), the language the AI teaches and answers in (aiLanguage) and the language used for listening and
// speaking (voiceLanguage). `sr` is the BCP-47 tag the browser's speech recognition and speech synthesis are given.
const LANGS = {
  en:  { code: 'en',  name: 'English',         native: 'English',       sr: 'en-NG' },
  yo:  { code: 'yo',  name: 'Yoruba',          native: 'Yorùbá',        sr: 'yo-NG' },
  ha:  { code: 'ha',  name: 'Hausa',           native: 'Hausa',         sr: 'ha-NG' },
  ig:  { code: 'ig',  name: 'Igbo',            native: 'Igbo',          sr: 'ig-NG' },
  pcm: { code: 'pcm', name: 'Nigerian Pidgin', native: 'Naijá Pidgin',  sr: 'en-NG' },
};

const isLang = (c) => Object.prototype.hasOwnProperty.call(LANGS, c);
const clean = (c, fallback = 'en') => (isLang(c) ? c : fallback);

// What the AI is told so that explanations, feedback and spoken text come back in the chosen language while the
// subject matter stays exactly as accurate as it is in English. English needs no instruction.
function directive(code) {
  if (!isLang(code) || code === 'en') return '';
  const L = LANGS[code];
  const pidgin = code === 'pcm'
    ? ' Write natural Nigerian Pidgin (the way people really speak it, e.g. "abeg", "wetin", "dey", "make we"), easy for a student to follow, not broken or exaggerated English.'
    : ` Write correct, natural ${L.name}${code === 'yo' ? ' with proper tone marks and underdots' : code === 'ig' ? ' with the proper diacritics and dotted vowels' : ''}.`;
  return `\n\nLANGUAGE: Everything the student will read or hear (explanations, what the lecturer says, board wording, feedback, answers, summaries) must be written in ${L.name} (${L.native}).${pidgin} Keep these exactly as they are and never translate or alter them: mathematical formulas and symbols, chemical formulae, units, numbers, code, proper names, and official curriculum or examination terms (such as WAEC, JAMB, NUC, NBTE). When a technical term has no well-known ${L.name} equivalent, keep the English term and add a short ${L.name} explanation in brackets the first time you use it. Never change a fact, an answer, or the order of answer options because of the language. If you are returning JSON, keep every key and the structure exactly as specified in English; only the text values are in ${L.name}.`;
}

module.exports = { LANGS, isLang, clean, directive };
