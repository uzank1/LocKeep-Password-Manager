/**
 * ============================================================================
 * LocKeep — Crypto & Password Generator Tests
 * ============================================================================
 * Run: node tests/crypto.test.js
 *
 * Tests encryption round-trips, wrong-key rejection, password generation,
 * and passphrase generation. Does NOT test vaultManager (requires Electron).
 * ============================================================================
 */

'use strict';

// We need to test the crypto modules standalone (no Electron dependency)
const path = require('path');

// Direct requires (these modules only depend on Node.js crypto + argon2)
const keyDerivation = require(path.join(__dirname, '..', 'src', 'main', 'crypto', 'keyDerivation'));
const encryption = require(path.join(__dirname, '..', 'src', 'main', 'crypto', 'encryption'));
const secureRandom = require(path.join(__dirname, '..', 'src', 'main', 'crypto', 'secureRandom'));
const passwordGen = require(path.join(__dirname, '..', 'src', 'main', 'vault', 'passwordGenerator'));

let passed = 0;
let failed = 0;

function assert(condition, testName) {
  if (condition) {
    console.log(`  ✅ PASS: ${testName}`);
    passed++;
  } else {
    console.error(`  ❌ FAIL: ${testName}`);
    failed++;
  }
}

async function runTests() {
  console.log('\n══════════════════════════════════════════════════');
  console.log('  LocKeep — Cryptographic Module Tests');
  console.log('══════════════════════════════════════════════════\n');

  // ────────────────────────────────────────────────────────────────────────
  console.log('── 1. Key Derivation (Argon2id) ──');

  const salt = keyDerivation.generateSalt();
  assert(Buffer.isBuffer(salt) && salt.length === 16, 'Salt is 16-byte Buffer');

  const key1 = await keyDerivation.deriveKey('test-password-123', salt);
  assert(Buffer.isBuffer(key1) && key1.length === 32, 'Derived key is 32-byte Buffer');

  const key2 = await keyDerivation.deriveKey('test-password-123', salt);
  assert(key1.equals(key2), 'Same password + salt produces same key');

  const key3 = await keyDerivation.deriveKey('different-password', salt);
  assert(!key1.equals(key3), 'Different password produces different key');

  const salt2 = keyDerivation.generateSalt();
  const key4 = await keyDerivation.deriveKey('test-password-123', salt2);
  assert(!key1.equals(key4), 'Same password + different salt produces different key');

  try {
    await keyDerivation.deriveKey('', salt);
    assert(false, 'Empty password should throw');
  } catch (e) {
    assert(e.message.includes('cannot be empty'), 'Empty password throws error');
  }

  const config = keyDerivation.getDefaultKdfConfig();
  assert(config.algorithm === 'argon2id', 'Default KDF is argon2id');
  assert(config.memoryCost === 65536, 'Memory cost is 64MB');

  // ────────────────────────────────────────────────────────────────────────
  console.log('\n── 2. AES-256-GCM Encryption ──');

  const testKey = await keyDerivation.deriveKey('encryption-test', salt);

  // String encryption
  const enc1 = encryption.encrypt('Hello, World!', testKey);
  assert(enc1.iv && enc1.ciphertext && enc1.authTag, 'Encrypt returns { iv, ciphertext, authTag }');

  const dec1 = encryption.decrypt(enc1, testKey, null, false);
  assert(dec1 === 'Hello, World!', 'Decrypt recovers original string');

  // Object encryption (JSON round-trip)
  const testObj = { username: 'alice', password: 's3cret!', tags: [1, 2, 3] };
  const enc2 = encryption.encrypt(testObj, testKey);
  const dec2 = encryption.decrypt(enc2, testKey);
  assert(dec2.username === 'alice' && dec2.password === 's3cret!', 'Object encrypt/decrypt round-trip');
  assert(Array.isArray(dec2.tags) && dec2.tags.length === 3, 'Array preserved in round-trip');

  // Wrong key must fail
  const wrongKey = await keyDerivation.deriveKey('wrong-password', salt);
  try {
    encryption.decrypt(enc1, wrongKey);
    assert(false, 'Decryption with wrong key should throw');
  } catch (e) {
    assert(e.message.includes('DECRYPTION FAILED'), 'Wrong key throws auth failure');
  }

  // Tampered ciphertext must fail
  try {
    const tampered = { ...enc1, ciphertext: enc1.ciphertext.slice(0, -4) + 'AAAA' };
    encryption.decrypt(tampered, testKey);
    assert(false, 'Tampered ciphertext should throw');
  } catch (e) {
    assert(e.message.includes('DECRYPTION FAILED'), 'Tampered data throws auth failure');
  }

  // Unique IVs per encryption
  const enc3 = encryption.encrypt('same data', testKey);
  const enc4 = encryption.encrypt('same data', testKey);
  assert(enc3.iv !== enc4.iv, 'Each encryption generates a unique IV');
  assert(enc3.ciphertext !== enc4.ciphertext, 'Same plaintext produces different ciphertext');

  // Compact format
  const compact = encryption.encryptCompact('compact-test', testKey);
  assert(typeof compact === 'string' && compact.split('.').length === 3, 'Compact format is dot-separated');
  const decCompact = encryption.decryptCompact(compact, testKey, false);
  assert(decCompact === 'compact-test', 'Compact decrypt recovers original');

  // ────────────────────────────────────────────────────────────────────────
  console.log('\n── 3. Secure Random ──');

  const bytes = secureRandom.randomBytes(32);
  assert(Buffer.isBuffer(bytes) && bytes.length === 32, 'randomBytes returns correct length');

  const hex = secureRandom.randomHex(16);
  assert(typeof hex === 'string' && hex.length === 32, 'randomHex returns correct hex length');

  const uuid = secureRandom.randomUUID();
  assert(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(uuid), 'UUID v4 format valid');

  // uniformRandomInt distribution test (basic)
  const counts = new Array(10).fill(0);
  for (let i = 0; i < 10000; i++) counts[secureRandom.uniformRandomInt(10)]++;
  const minCount = Math.min(...counts);
  const maxCount = Math.max(...counts);
  assert(minCount > 800 && maxCount < 1200, `Uniform distribution (min=${minCount}, max=${maxCount})`);

  // ────────────────────────────────────────────────────────────────────────
  console.log('\n── 4. Password Generator ──');

  const pw1 = secureRandom.generatePassword(20, { uppercase: true, lowercase: true, digits: true, symbols: true });
  assert(pw1.password.length === 20, 'Password is requested length (20)');
  assert(pw1.entropy > 0, `Entropy calculated: ${pw1.entropy} bits`);

  const pw2 = secureRandom.generatePassword(16, { symbols: false });
  assert(!/[!@#$%^&*()_+\-=\[\]{}|;:,.<>?\/~`]/.test(pw2.password), 'No symbols when disabled');

  const pw3 = secureRandom.generatePassword(12, { uppercase: false, lowercase: false, symbols: false });
  assert(/^\d+$/.test(pw3.password), 'Digits only when only digits enabled');

  // High-level generator with presets
  const strong = passwordGen.generate({ preset: 'strong' });
  assert(strong.password.length === 20, 'Strong preset is 20 chars');
  assert(strong.strength !== 'very_weak', `Strong preset strength: ${strong.strength}`);

  const paranoid = passwordGen.generate({ preset: 'paranoid' });
  assert(paranoid.password.length === 64, 'Paranoid preset is 64 chars');
  assert(paranoid.strength === 'excellent', `Paranoid strength: ${paranoid.strength}`);

  // Passphrase
  const phrase = passwordGen.generatePassphrase({ wordCount: 5 });
  assert(phrase.password.split('-').length >= 5, `Passphrase has >= 5 parts: "${phrase.password}"`);
  assert(phrase.entropy > 30, `Passphrase entropy: ${phrase.entropy} bits`);

  // Strength analysis
  const analysis = passwordGen.analyzeStrength('P@ssw0rd!123XY');
  assert(analysis.entropy > 0, `Analysis entropy: ${analysis.entropy}`);
  assert(analysis.strength !== 'none', `Analysis strength: ${analysis.strength}`);

  const weakAnalysis = passwordGen.analyzeStrength('abc');
  assert(weakAnalysis.strength === 'very_weak', 'Weak password detected');

  // ────────────────────────────────────────────────────────────────────────
  console.log('\n══════════════════════════════════════════════════');
  console.log(`  Results: ${passed} passed, ${failed} failed`);
  console.log('══════════════════════════════════════════════════\n');

  if (failed > 0) process.exit(1);
}

runTests().catch(err => {
  console.error('Test runner failed:', err);
  process.exit(1);
});
