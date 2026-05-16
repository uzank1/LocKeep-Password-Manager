/**
 * ============================================================================
 * LOCKEEP PASSWORD MANAGER — Native Messaging Host
 * ============================================================================
 * Standalone Node.js process that bridges the Chrome extension with the
 * Electron desktop app via stdin/stdout (Chrome Native Messaging protocol)
 * and a local named pipe (to communicate with the running Electron app).
 *
 * SECURITY (E2EE):
 * - Ephemeral ECDH key exchange (P-256) on connection.
 * - All commands after handshake are encrypted with AES-256-GCM.
 *
 * COMMANDS:
 * - HANDSHAKE           → setup ECDH shared secret
 * - ENCRYPTED           → encrypted payload containing actual commands
 *
 * COMMUNICATION WITH ELECTRON APP:
 * Uses a local TCP connection on 127.0.0.1 (loopback only) with a
 * random port stored in a lock file.
 * ============================================================================
 */

'use strict';

const net = require('net');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ─── Configuration ──────────────────────────────────────────────────────────

const APP_DATA_DIR = path.join(
  process.env.APPDATA || path.join(process.env.HOME || '', 'AppData', 'Roaming'),
  'LocKeepPasswordManager'
);
const PORT_FILE = path.join(APP_DATA_DIR, '.ipc-port');

// ─── E2EE State ─────────────────────────────────────────────────────────────

let _ecdh = null;
let _sharedSecret = null;
let _stdinBuffer = Buffer.alloc(0);

// ─── Windows: Set stdin/stdout to binary mode ──────────────────────────────

if (process.platform === 'win32') {
  process.stdin.resume();
  process.stdout.setDefaultEncoding('binary');
}

// ─── Native Messaging I/O ───────────────────────────────────────────────────

function readMessage() {
  return new Promise((resolve, reject) => {
    const checkBuffer = () => {
      if (_stdinBuffer.length >= 4) {
        const messageLength = _stdinBuffer.readUInt32LE(0);
        if (messageLength === 0 || messageLength > 1024 * 1024) {
          reject(new Error(`Invalid message length: ${messageLength}`));
          return true;
        }
        if (_stdinBuffer.length >= 4 + messageLength) {
          const json = _stdinBuffer.slice(4, 4 + messageLength).toString('utf-8');
          _stdinBuffer = _stdinBuffer.slice(4 + messageLength);
          try { resolve(JSON.parse(json)); }
          catch (e) { reject(new Error('Invalid JSON: ' + e.message)); }
          return true;
        }
      }
      return false;
    };

    if (checkBuffer()) return;

    const onData = (chunk) => {
      _stdinBuffer = Buffer.concat([_stdinBuffer, chunk]);
      if (checkBuffer()) {
        process.stdin.removeListener('data', onData);
      }
    };

    process.stdin.on('data', onData);
  });
}

function writeMessage(message) {
  const json = JSON.stringify(message);
  const body = Buffer.from(json, 'utf-8');
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length, 0);
  process.stdout.write(Buffer.concat([header, body]));
}

// ─── E2EE Encryption / Decryption ───────────────────────────────────────────

function encryptPayload(payload) {
  if (!_sharedSecret) throw new Error('E2EE not initialized');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', _sharedSecret, iv);

  let ciphertext = cipher.update(Buffer.from(JSON.stringify(payload), 'utf8'));
  ciphertext = Buffer.concat([ciphertext, cipher.final()]);
  const tag = cipher.getAuthTag();

  // Combine ciphertext and tag (WebCrypto format)
  const combined = Buffer.concat([ciphertext, tag]);

  return {
    iv: iv.toString('base64'),
    data: combined.toString('base64')
  };
}

function decryptPayload(ivBase64, dataBase64) {
  if (!_sharedSecret) throw new Error('E2EE not initialized');
  const iv = Buffer.from(ivBase64, 'base64');
  const combined = Buffer.from(dataBase64, 'base64');

  const ciphertext = combined.slice(0, combined.length - 16);
  const tag = combined.slice(combined.length - 16);

  const decipher = crypto.createDecipheriv('aes-256-gcm', _sharedSecret, iv);
  decipher.setAuthTag(tag);

  let plaintext = decipher.update(ciphertext, undefined, 'utf8');
  plaintext += decipher.final('utf8');

  return JSON.parse(plaintext);
}

// ─── IPC Client (connects to Electron app) ──────────────────────────────────

function sendToApp(command) {
  return new Promise((resolve, reject) => {
    let port;
    try {
      port = parseInt(fs.readFileSync(PORT_FILE, 'utf-8').trim(), 10);
    } catch {
      reject(new Error('Electron app is not running. Cannot read IPC port.'));
      return;
    }

    const client = net.createConnection({ host: '127.0.0.1', port }, () => {
      const data = JSON.stringify(command);
      const lengthBuf = Buffer.alloc(4);
      lengthBuf.writeUInt32LE(Buffer.byteLength(data, 'utf-8'), 0);
      client.write(lengthBuf);
      client.write(data, 'utf-8');
    });

    let responseBuf = Buffer.alloc(0);

    client.on('data', (chunk) => {
      responseBuf = Buffer.concat([responseBuf, chunk]);

      if (responseBuf.length >= 4) {
        const respLength = responseBuf.readUInt32LE(0);
        if (responseBuf.length >= 4 + respLength) {
          const json = responseBuf.slice(4, 4 + respLength).toString('utf-8');
          client.destroy();
          try { resolve(JSON.parse(json)); }
          catch (e) { reject(new Error('Invalid response JSON')); }
        }
      }
    });

    client.on('error', (err) => reject(new Error('Cannot connect to Electron app: ' + err.message)));
    client.setTimeout(5000, () => {
      client.destroy();
      reject(new Error('Connection to Electron app timed out.'));
    });
  });
}

// ─── Command Handlers ───────────────────────────────────────────────────────

async function processCommand(command, data) {
  switch (command) {
    case 'PING':
      return { success: true, data: { status: 'alive', version: '1.0.0' } };
    case 'QUERY_CREDENTIALS': {
      try {
        const appRes = await sendToApp({ action: 'searchDomain', domain: data.domain });

        // KESİN ÇÖZÜM: Masaüstünden bir hata (örneğin "Vault is locked") geldiyse bunu ASLA YUTMA, direkt ilet!
        if (appRes && appRes.success === false) {
          return appRes;
        }

        // Eğer başarılıysa şifreleri gönder
        if (appRes && appRes.success && Array.isArray(appRes.data)) {
          return { success: true, data: { entries: appRes.data } };
        } else if (appRes && appRes.success && appRes.data && Array.isArray(appRes.data.entries)) {
          return appRes;
        }
        return { success: true, data: { entries: [] } };
      } catch (e) {
        // Uygulama çökerse de hatayı yutma
        return { success: false, error: e.message };
      }
    }
    case 'GET_CREDENTIAL': {
      try {
        const appRes = await sendToApp({ action: 'getCredential', id: data.id });
        if (appRes && appRes.success && appRes.data) {
          if (!appRes.data.entry) {
            return { success: true, data: { entry: appRes.data } };
          }
          return appRes;
        }
        return { success: false, error: 'Credential not found' };
      } catch (e) {
        return { success: false, error: e.message };
      }
    }
    case 'SAVE_CREDENTIAL':
      return await sendToApp({ action: 'addEntry', entry: data });
    case 'GENERATE_PASSWORD':
      return await sendToApp({ action: 'generatePassword', options: data || {} });
    case 'GET_LANGUAGE':
      return await sendToApp({ action: 'getLanguage' });
    default:
      return { success: false, error: `Unknown internal command: ${command}` };
  }
}

async function handleMessage(message) {
  const id = message._requestId || message.requestId || message.id;
  const { command, data } = message;

  try {
    if (command === 'HANDSHAKE') {
      // 1. Extension sends its public key
      const clientPubKeyBase64 = data.publicKey;

      // 2. Generate host ephemeral key pair
      _ecdh = crypto.createECDH('prime256v1');
      _ecdh.generateKeys();
      const hostPubKeyBase64 = _ecdh.getPublicKey('base64');

      // 3. Compute shared secret
      _sharedSecret = _ecdh.computeSecret(Buffer.from(clientPubKeyBase64, 'base64'));

      return { _requestId: id, success: true, data: { publicKey: hostPubKeyBase64 } };
    }
    else if (command === 'ENCRYPTED') {
      if (!_sharedSecret) throw new Error('E2EE Handshake not completed.');

      // Decrypt incoming payload
      const payload = decryptPayload(data.iv, data.data);

      // Process internal command
      const response = await processCommand(payload.command, payload.data);

      // Encrypt outgoing response
      const encryptedResp = encryptPayload(response);
      return { _requestId: id, success: true, encrypted: encryptedResp };
    }
    else {
      throw new Error(`Unencrypted commands are not allowed (got ${command}).`);
    }
  } catch (err) {
    return { _requestId: id, success: false, error: err.message };
  }
}

// ─── Main Loop ──────────────────────────────────────────────────────────────

async function main() {
  process.stderr.write('[NativeHost] Started E2EE Host. Waiting for messages...\n');

  while (true) {
    try {
      const message = await readMessage();
      const response = await handleMessage(message);
      writeMessage(response);
    } catch (err) {
      if (err.message.includes('Invalid message length') || !process.stdin.readable) {
        process.stderr.write('[NativeHost] stdin closed. Exiting.\n');
        process.exit(0);
      }
      writeMessage({ success: false, error: err.message });
    }
  }
}

process.stdin.on('end', () => {
  process.stderr.write('[NativeHost] stdin ended. Exiting.\n');
  process.exit(0);
});

main();
