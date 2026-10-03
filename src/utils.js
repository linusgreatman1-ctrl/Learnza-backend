const crypto = require('crypto');

// Avoids visually ambiguous characters (0/O, 1/I/L) since codes get read aloud/typed
// by hand from a printed directory or a message.
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

// crypto.randomInt, not a byte-modulo, so every character is equally likely.
function randomCode(length) {
  let code = '';
  for (let i = 0; i < length; i++) code += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
  return code;
}

// Per-user login code for school lecturers, staff, students and extra admins.
function generateAccessCode(length = 8) {
  return randomCode(length);
}

// A school's permanent join code, issued once by the super admin when onboarding it.
function generateJoinCode() {
  return randomCode(8);
}

// Constant-time string comparison for secrets (join codes) so a mismatch can't be
// timed to learn how many leading characters were right.
function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  if (x.length !== y.length) return false;
  return crypto.timingSafeEqual(x, y);
}

module.exports = { generateAccessCode, generateJoinCode, safeEqual };
