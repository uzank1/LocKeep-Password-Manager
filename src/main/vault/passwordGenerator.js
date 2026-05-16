/**
 * ============================================================================
 * LOCKEEP PASSWORD MANAGER — Password Generator
 * ============================================================================
 * High-level password generation with strength analysis, presets, and
 * passphrase support. Wraps secureRandom.generatePassword with UX helpers.
 *
 * IMPORTANT: Only invoke from Electron Main Process.
 * ============================================================================
 */

'use strict';

const { generatePassword: coreGenerate, uniformRandomInt } = require('../crypto/secureRandom');

// ─── Strength Presets ───────────────────────────────────────────────────────

const PRESETS = {
  /** PIN-like: 6 digits */
  pin: { length: 6, uppercase: false, lowercase: false, digits: true, symbols: false },

  /** Basic: 12 chars, letters + digits */
  basic: { length: 12, uppercase: true, lowercase: true, digits: true, symbols: false },

  /** Strong: 20 chars, full charset (DEFAULT) */
  strong: { length: 20, uppercase: true, lowercase: true, digits: true, symbols: true },

  /** Maximum: 32 chars, full charset */
  maximum: { length: 32, uppercase: true, lowercase: true, digits: true, symbols: true },

  /** Paranoid: 64 chars, full charset */
  paranoid: { length: 64, uppercase: true, lowercase: true, digits: true, symbols: true }
};

// ─── Wordlist for passphrases (EFF short wordlist subset — 200 words) ───────
// These are common, easy-to-type English words for memorable passphrases.
const WORDLIST = [
  'anchor','apple','arrow','badge','baker','beach','blade','blank','blaze','bloom',
  'board','bonus','brave','brick','bridge','brush','cabin','cable','cargo','cedar',
  'chain','chalk','charm','chase','chess','chief','cider','claim','clash','cliff',
  'climb','cloud','coast','coral','craft','crane','crash','creek','crown','crush',
  'cycle','dance','delta','depot','diary','dodge','draft','dream','drift','drone',
  'eagle','earth','ember','equal','essay','event','extra','fable','feast','fiber',
  'field','flame','flask','fleet','flock','flood','flute','focal','forge','forum',
  'frame','frost','gamma','genre','ghost','giant','given','glass','globe','grain',
  'grand','grape','graph','grasp','grave','green','grill','grove','guard','guest',
  'guide','haven','heart','hedge','hoist','honey','horse','house','human','humor',
  'index','inner','input','ivory','jewel','joint','judge','juice','karma','knack',
  'knock','label','lance','large','laser','latch','layer','lemon','level','light',
  'linen','lodge','logic','lunar','major','manor','maple','march','match','media',
  'merge','metal','minor','model','moral','mount','mural','nerve','noble','north',
  'novel','nurse','ocean','olive','onset','opera','orbit','outer','oxide','panel',
  'paper','patch','pause','pearl','phase','piano','pilot','pixel','place','plant',
  'plaza','plume','point','polar','pound','power','press','pride','prime','print',
  'prize','probe','prose','pulse','purse','quest','quiet','quota','radar','range',
  'rapid','realm','rebel','reign','relay','ridge','rival','river','robin','royal',
  'rural','saint','salad','scale','scene','scope','scout','serve','shade','shaft'
];

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Generates a secure random password with the given options.
 *
 * @param {Object} [options] - Generation options
 * @param {number}  [options.length=20]      - Password length (4–128)
 * @param {boolean} [options.uppercase=true]  - Include uppercase letters
 * @param {boolean} [options.lowercase=true]  - Include lowercase letters
 * @param {boolean} [options.digits=true]     - Include digits
 * @param {boolean} [options.symbols=true]    - Include symbols
 * @param {string}  [options.exclude='']      - Characters to exclude
 * @param {string}  [options.preset]          - Use a named preset (overrides other options)
 *
 * @returns {{ password: string, entropy: number, charsetSize: number, strength: string }}
 */
function generate(options = {}) {
  // If a preset is specified, use its options (user can still override length)
  let opts = { ...options };
  if (opts.preset && PRESETS[opts.preset]) {
    opts = { ...PRESETS[opts.preset], ...options, preset: undefined };
  }

  const result = coreGenerate(opts.length || 20, {
    uppercase: opts.uppercase,
    lowercase: opts.lowercase,
    digits:    opts.digits,
    symbols:   opts.symbols,
    exclude:   opts.exclude
  });

  return {
    ...result,
    strength: classifyStrength(result.entropy)
  };
}

/**
 * Generates a random passphrase from the built-in wordlist.
 * Passphrases are easier to remember while maintaining high entropy.
 *
 * @param {Object} [options]
 * @param {number} [options.wordCount=5]     - Number of words (3–10)
 * @param {string} [options.separator='-']   - Word separator
 * @param {boolean} [options.capitalize=true] - Capitalize first letter of each word
 * @param {boolean} [options.includeNumber=true] - Append a random 2-digit number
 *
 * @returns {{ password: string, entropy: number, wordCount: number, strength: string }}
 */
function generatePassphrase(options = {}) {
  const wordCount     = Math.max(3, Math.min(10, options.wordCount || 5));
  const separator     = options.separator !== undefined ? options.separator : '-';
  const capitalize    = options.capitalize !== false;
  const includeNumber = options.includeNumber !== false;

  // Select random words using uniform distribution
  const words = [];
  for (let i = 0; i < wordCount; i++) {
    const idx = uniformRandomInt(WORDLIST.length);
    let word = WORDLIST[idx];
    if (capitalize) {
      word = word.charAt(0).toUpperCase() + word.slice(1);
    }
    words.push(word);
  }

  let passphrase = words.join(separator);

  // Optionally append a random number for extra entropy
  if (includeNumber) {
    const num = uniformRandomInt(100);
    passphrase += separator + String(num).padStart(2, '0');
  }

  // Calculate entropy: log2(wordlist_size ^ wordCount) + optional number entropy
  let entropy = wordCount * Math.log2(WORDLIST.length);
  if (includeNumber) entropy += Math.log2(100);
  entropy = Math.round(entropy * 100) / 100;

  return {
    password:  passphrase,
    entropy,
    wordCount,
    strength:  classifyStrength(entropy)
  };
}

/**
 * Analyzes the strength of a given password.
 *
 * @param {string} password - The password to analyze
 * @returns {{ entropy: number, charsetSize: number, strength: string, feedback: string[] }}
 */
function analyzeStrength(password) {
  if (!password) {
    return { entropy: 0, charsetSize: 0, strength: 'none', feedback: ['Password is empty.'] };
  }

  // Determine the effective charset size based on characters used
  let charsetSize = 0;
  const feedback = [];

  const hasLower   = /[a-z]/.test(password);
  const hasUpper   = /[A-Z]/.test(password);
  const hasDigits  = /[0-9]/.test(password);
  const hasSymbols = /[^a-zA-Z0-9]/.test(password);

  if (hasLower)   charsetSize += 26;
  if (hasUpper)   charsetSize += 26;
  if (hasDigits)  charsetSize += 10;
  if (hasSymbols) charsetSize += 32;

  if (!hasUpper)   feedback.push('Add uppercase letters for more strength.');
  if (!hasLower)   feedback.push('Add lowercase letters for more strength.');
  if (!hasDigits)  feedback.push('Add numbers for more strength.');
  if (!hasSymbols) feedback.push('Add symbols (!@#$) for more strength.');
  if (password.length < 12) feedback.push('Use at least 12 characters.');

  // Check for common patterns
  if (/(.)\1{2,}/.test(password)) feedback.push('Avoid repeating characters.');
  if (/^(123|abc|qwerty|password)/i.test(password)) feedback.push('Avoid common patterns.');

  const entropy = charsetSize > 0
    ? Math.round(password.length * Math.log2(charsetSize) * 100) / 100
    : 0;

  return {
    entropy,
    charsetSize,
    strength: classifyStrength(entropy),
    feedback
  };
}

/**
 * Returns available preset names and their descriptions.
 * @returns {Array<{ name: string, description: string, length: number }>}
 */
function getPresets() {
  return [
    { name: 'pin',      description: '6-digit PIN',              length: 6  },
    { name: 'basic',    description: 'Letters & digits (12)',     length: 12 },
    { name: 'strong',   description: 'Full charset (20)',         length: 20 },
    { name: 'maximum',  description: 'Full charset (32)',         length: 32 },
    { name: 'paranoid', description: 'Full charset (64)',         length: 64 }
  ];
}

// ─── Internal Utilities ─────────────────────────────────────────────────────

/**
 * Classifies password strength based on entropy bits.
 *
 * @param {number} entropy - Bits of entropy
 * @returns {string} Strength classification
 */
function classifyStrength(entropy) {
  if (entropy < 28)  return 'very_weak';   // < 28 bits
  if (entropy < 36)  return 'weak';        // 28–35 bits
  if (entropy < 60)  return 'fair';        // 36–59 bits
  if (entropy < 80)  return 'strong';      // 60–79 bits
  if (entropy < 120) return 'very_strong'; // 80–119 bits
  return 'excellent';                      // 120+ bits
}

module.exports = {
  generate,
  generatePassphrase,
  analyzeStrength,
  getPresets,
  PRESETS,
  WORDLIST
};
