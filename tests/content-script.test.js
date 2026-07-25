'use strict';

const assert = require('assert');
const path = require('path');

global.window = {
  location: {
    hostname: 'accounts.google.com',
    pathname: '/v3/signin/challenge/pwd',
    origin: 'https://accounts.google.com',
    href: 'https://accounts.google.com/v3/signin/challenge/pwd'
  }
};

global.chrome = {
  runtime: {
    getURL: resourcePath => resourcePath
  }
};

const LocKeepContentScript = require(path.join(__dirname, '..', 'extension', 'content_script'));

let passed = 0;
let failed = 0;

async function check(testName, testFn) {
  try {
    await testFn();
    console.log(`  PASS: ${testName}`);
    passed++;
  } catch (error) {
    console.error(`  FAIL: ${testName}`);
    console.error(`        ${error.message}`);
    failed++;
  }
}

async function runTests() {
  console.log('\nLocKeep - Content Script Tests\n');

  await check('Google sign-in prefers exact-host credentials', async () => {
    const contentScript = new LocKeepContentScript();
    const requestedOrigins = [];
    const exactEntries = [
      { id: 'accounts-1', username: 'first@example.com', url: 'https://accounts.google.com' },
      { id: 'accounts-2', username: 'second@example.com', url: 'https://accounts.google.com' }
    ];

    contentScript.sendMessageToBackground = async message => {
      requestedOrigins.push(message.domain);
      return message.domain === 'https://accounts.google.com'
        ? { success: true, data: { entries: [
          ...exactEntries,
          { id: 'google-root-1', username: 'first@example.com', url: 'https://google.com' }
        ] } }
        : { success: true, data: { entries: [
          ...exactEntries,
          { id: 'mail-1', username: 'first@example.com', url: 'https://mail.google.com' }
        ] } };
    };

    await contentScript._fetchCredentials();

    assert.deepStrictEqual(requestedOrigins, ['https://accounts.google.com']);
    assert.deepStrictEqual(contentScript.credentials, exactEntries);
  });

  await check('Google sign-in falls back to parent-domain credentials', async () => {
    const contentScript = new LocKeepContentScript();
    const requestedOrigins = [];
    const fallbackEntries = [
      { id: 'mail-1', username: 'first@example.com', url: 'https://mail.google.com' }
    ];

    contentScript.sendMessageToBackground = async message => {
      requestedOrigins.push(message.domain);
      return message.domain === 'https://accounts.google.com'
        ? { success: true, data: { entries: [] } }
        : { success: true, data: { entries: fallbackEntries } };
    };

    await contentScript._fetchCredentials();

    assert.deepStrictEqual(requestedOrigins, [
      'https://accounts.google.com',
      'https://google.com'
    ]);
    assert.deepStrictEqual(contentScript.credentials, fallbackEntries);
  });

  await check('Repeated credential IDs are shown only once', async () => {
    const contentScript = new LocKeepContentScript();
    contentScript.sendMessageToBackground = async () => ({
      success: true,
      data: {
        entries: [
          { id: 'same-id', username: 'first@example.com', url: 'https://accounts.google.com' },
          { id: 'same-id', username: 'first@example.com', url: 'https://accounts.google.com' }
        ]
      }
    });

    await contentScript._fetchCredentials();

    assert.strictEqual(contentScript.credentials.length, 1);
  });

  console.log(`\nResults: ${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}

runTests().catch(error => {
  console.error('Content script test runner failed:', error);
  process.exit(1);
});
