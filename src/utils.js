const crypto = require('crypto');

// Avoids visually ambiguous characters (0/O, 1/I/L) since this gets read aloud/typed
// by hand from a printed directory.
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

function generateAccessCode(length = 8) {
  let code = '';
  const bytes = crypto.randomBytes(length);
  for (let i = 0; i < length; i++) code += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  return code;
}

module.exports = { generateAccessCode };
