/**
 * ============================================================================
 * LOCKEEP PASSWORD MANAGER — Native Host IPC Server
 * ============================================================================
 * Local TCP server on 127.0.0.1 that accepts connections from the native
 * messaging host process. Processes vault commands and returns results.
 *
 * The port is dynamically assigned and written to a lock file so the
 * native host can discover it.
 *
 * SECURITY: Binds ONLY to 127.0.0.1 (loopback) — not accessible from network.
 * ============================================================================
 */

'use strict';

const net  = require('net');
const fs   = require('fs');
const path = require('path');
const { app, BrowserWindow } = require('electron');

const vaultManager      = require('../vault/vaultManager');
const passwordGenerator = require('../vault/passwordGenerator');

// ─── State ──────────────────────────────────────────────────────────────────

let _server = null;
const PORT_FILE = path.join(app.getPath('appData'), 'LocKeepPasswordManager', '.ipc-port');

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Starts the local IPC server for native messaging host communication.
 * Binds exclusively to 127.0.0.1 (loopback) with a random OS-assigned port.
 *
 * @returns {Promise<number>} The port number the server is listening on
 */
function startServer() {
  return new Promise((resolve, reject) => {
    _server = net.createServer((socket) => {
      let buffer = Buffer.alloc(0);

      socket.on('data', (chunk) => {
        buffer = Buffer.concat([buffer, chunk]);

        // Read length-prefixed messages
        while (buffer.length >= 4) {
          const msgLength = buffer.readUInt32LE(0);
          if (buffer.length < 4 + msgLength) break; // Wait for more data

          const jsonStr = buffer.slice(4, 4 + msgLength).toString('utf-8');
          buffer = buffer.slice(4 + msgLength);

          // Process the command
          handleNativeCommand(jsonStr).then(response => {
            const respStr = JSON.stringify(response);
            const respBuf = Buffer.from(respStr, 'utf-8');
            const header = Buffer.alloc(4);
            header.writeUInt32LE(respBuf.length, 0);
            socket.write(Buffer.concat([header, respBuf]));
          }).catch(err => {
            const errResp = JSON.stringify({ success: false, error: err.message });
            const errBuf = Buffer.from(errResp, 'utf-8');
            const header = Buffer.alloc(4);
            header.writeUInt32LE(errBuf.length, 0);
            socket.write(Buffer.concat([header, errBuf]));
          });
        }
      });

      socket.on('error', () => { /* Client disconnected — ignore */ });
    });

    // Bind ONLY to loopback — never expose to network
    _server.listen(0, '127.0.0.1', () => {
      const port = _server.address().port;

      // Write port to file so native host can discover it
      const dir = path.dirname(PORT_FILE);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(PORT_FILE, String(port), 'utf-8');

      console.log(`[IPC Server] Listening on 127.0.0.1:${port}`);
      resolve(port);
    });

    _server.on('error', reject);
  });
}

/**
 * Stops the IPC server and cleans up the port file.
 */
function stopServer() {
  if (_server) {
    _server.close();
    _server = null;
  }
  // Remove port file
  try { fs.unlinkSync(PORT_FILE); } catch { /* fine */ }
}

// ─── Command Handler ────────────────────────────────────────────────────────

async function handleNativeCommand(jsonStr) {
  let command;
  try {
    command = JSON.parse(jsonStr);
  } catch {
    return { success: false, error: 'Invalid JSON.' };
  }

  if (!vaultManager.isUnlocked() && command.action !== 'ping') {
    return { success: false, error: 'Vault is locked.' };
  }

  switch (command.action) {
    case 'ping':
      return { success: true, data: { status: 'alive' } };

    case 'searchDomain':
      try {
        const entries = vaultManager.searchByDomain(command.domain || '');
        return { success: true, data: entries };
      } catch (err) {
        return { success: false, error: err.message };
      }

    case 'getCredential':
      try {
        const cred = vaultManager.getCredential(command.id);
        return cred
          ? { success: true, data: cred }
          : { success: false, error: 'Credential not found.' };
      } catch (err) {
        return { success: false, error: err.message };
      }

    case 'addEntry':
      try {
        const result = vaultManager.addEntry(command.entry || {});
        BrowserWindow.getAllWindows().forEach(win => {
          if (win && !win.isDestroyed()) {
            win.webContents.send('vault:updated');
          }
        });
        return { success: true, data: result };
      } catch (err) {
        return { success: false, error: err.message };
      }

    case 'generatePassword':
      try {
        const pw = passwordGenerator.generate(command.options || {});
        return { success: true, data: pw };
      } catch (err) {
        return { success: false, error: err.message };
      }

    case 'getLanguage':
      try {
        const settings = vaultManager.loadSettings();
        return { success: true, data: { language: settings.language || 'en' } };
      } catch (err) {
        return { success: false, error: err.message };
      }

    default:
      return { success: false, error: `Unknown action: ${command.action}` };
  }
}

module.exports = { startServer, stopServer };
