const prisma = require('./db');

// Platform settings the owner edits from the admin panel (Settings). Every setting here has
// a real reader somewhere in the server -- nothing is a switch that does nothing:
//   subscriptionEnforced  src/subscription.js   paywall on/off without a redeploy
//   maintenanceMode       src/server.js         everyone but the owner gets a 503 + message
//   registrationOpen      src/routes/auth.js    can new independent students sign up
//   aiEnabled             src/aiGuard.js        kill switch for every AI feature
//   aiQuestionsPerDay     src/aiGuard.js        per-student cap on research/lab questions
//
// Reads are synchronous (from memory) so they can sit in hot paths and in sync helpers like
// isEnforced(). The cache is loaded at boot, updated immediately on a save, and re-read every
// minute so a second server instance picks up a change too.
const DEFINITIONS = {
  featureStudyGroups: {
    type: 'boolean', default: true, category: 'Features',
    label: 'Study groups',
    help: 'Turn off to stop students using study groups and their chat. Everyone sees the change at once; the page and the server both obey it.',
  },
  featureLibrary: {
    type: 'boolean', default: true, category: 'Features',
    label: 'e-Library',
    help: 'Turn off to hide and block the e-Library. Everyone sees the change at once; the page and the server both obey it.',
  },
  featureLiveClasses: {
    type: 'boolean', default: true, category: 'Features',
    label: 'Live classes',
    help: 'Turn off to stop live classes from starting or being joined. Everyone sees the change at once; the page and the server both obey it.',
  },
  featureMeetings: {
    type: 'boolean', default: true, category: 'Features',
    label: 'Meetings',
    help: 'Turn off to stop meetings and the meeting schedule. Everyone sees the change at once; the page and the server both obey it.',
  },
  featureElections: {
    type: 'boolean', default: true, category: 'Features',
    label: 'Elections',
    help: 'Turn off to hide and block elections and class representative voting. Everyone sees the change at once; the page and the server both obey it.',
  },
  featureFees: {
    type: 'boolean', default: true, category: 'Features',
    label: 'School fees',
    help: 'Turn off to hide and block fee payment. Everyone sees the change at once; the page and the server both obey it.',
  },
  subscriptionEnforced: {
    type: 'select', options: ['env', 'on', 'off'], default: 'env', category: 'Billing',
    label: 'Subscription paywall',
    help: '"env" follows the REQUIRE_SUBSCRIPTION environment variable. "on" / "off" overrides it from here, no redeploy needed.',
  },
  maintenanceMode: {
    type: 'boolean', default: false, category: 'Platform',
    label: 'Maintenance mode',
    help: 'While on, the apps show the message below and every request fails with 503. This panel keeps working.',
  },
  maintenanceMessage: {
    type: 'text', default: 'Learnza is down for a short maintenance. Please try again in a few minutes.', category: 'Platform',
    label: 'Maintenance message',
    help: 'Shown to students, lecturers and school admins while maintenance mode is on.',
  },
  registrationOpen: {
    type: 'boolean', default: true, category: 'Platform',
    label: 'Independent student sign-up open',
    help: 'Turn off to stop new people registering on the Student app. Existing accounts and schools are unaffected.',
  },
  aiEnabled: {
    type: 'boolean', default: true, category: 'AI',
    label: 'Learnza features enabled',
    help: 'Master switch for Learnza Lecturer, the research assistant, lab questions and Learnza-generated content.',
  },
  aiQuestionsPerDay: {
    type: 'number', default: 0, min: 0, category: 'AI',
    label: 'Research & lab questions per student per day',
    help: '0 means unlimited. Lecturers and admins are never limited.',
  },
};

const cache = new Map();
let loaded = false;

function coerce(def, raw) {
  if (def.type === 'boolean') return raw === true || raw === 'true';
  if (def.type === 'number') {
    const n = Number(raw);
    return Number.isFinite(n) ? Math.max(def.min ?? -Infinity, Math.round(n)) : def.default;
  }
  if (def.type === 'select') return def.options.includes(raw) ? raw : def.default;
  return String(raw == null ? '' : raw).slice(0, 500);
}

async function load() {
  const rows = await prisma.appSetting.findMany();
  const next = new Map();
  for (const row of rows) {
    const def = DEFINITIONS[row.key];
    if (!def) continue;
    try { next.set(row.key, coerce(def, JSON.parse(row.value))); } catch { /* keep default */ }
  }
  cache.clear();
  for (const [k, v] of next) cache.set(k, v);
  loaded = true;
}

function get(key) {
  const def = DEFINITIONS[key];
  if (!def) throw new Error('Unknown setting ' + key);
  return cache.has(key) ? cache.get(key) : def.default;
}

async function set(key, value) {
  const def = DEFINITIONS[key];
  if (!def) throw new Error('Unknown setting ' + key);
  const clean = coerce(def, value);
  await prisma.appSetting.upsert({
    where: { key },
    create: { key, value: JSON.stringify(clean), category: def.category },
    update: { value: JSON.stringify(clean), category: def.category },
  });
  cache.set(key, clean);
  return clean;
}

function all() {
  return Object.entries(DEFINITIONS).map(([key, def]) => ({ key, ...def, value: get(key) }));
}

function start() {
  load().catch((e) => console.error('Could not load settings:', e.message));
  setInterval(() => load().catch(() => {}), 60 * 1000).unref();
}

module.exports = { get, set, all, load, start, DEFINITIONS, isLoaded: () => loaded };
