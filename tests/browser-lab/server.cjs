'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { cases } = require('./catalog');
const directory = __dirname;
const extension = path.resolve(directory, '../../extension');
const resultsDirectory = path.resolve(directory, '../../dist/browser-lab');
const assets = ['catalog.js', 'lab.js', 'lab.css', 'fixture.js', 'case.css', 'bridge.js', 'popup-shim.js'];
const defaultProfiles = { 'empty-vault': 'empty', 'locked-vault': 'locked', 'offline-app': 'offline',
  'slow-connection': 'slow', 'recover-connection': 'offline' };
const types = { '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8', '.png': 'image/png', '.json': 'application/json; charset=utf-8' };
function jsonForScript(value) { return JSON.stringify(value).replace(/</g, '\\u003c'); }
function handler(secondPort) {
  return (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    if (!['GET', 'HEAD'].includes(request.method)) { response.writeHead(405); response.end(); return; }
    let url;
    try { url = new URL(request.url, 'http://127.0.0.1'); } catch { response.writeHead(400); response.end(); return; }
    const send = (body, type = 'text/html; charset=utf-8') => {
      response.writeHead(200, { 'Content-Type': type }); response.end(request.method === 'HEAD' ? undefined : body);
    };
    const file = filename => send(fs.readFileSync(filename), types[path.extname(filename)] || 'application/octet-stream');
    try {
      if (url.pathname === '/' || url.pathname === '/index.html') return file(path.join(directory, 'index.html'));
      if (assets.includes(url.pathname.slice(1))) return file(path.join(directory, url.pathname.slice(1)));
      if (url.pathname === '/health') return send(JSON.stringify({ ok: true, scenarios: cases.length }), types['.json']);
      if (url.pathname.startsWith('/results/')) {
        const name = url.pathname.slice('/results/'.length) || 'report.html';
        const allowed = ['report.html', 'results.json', 'dashboard.png', ...cases.map(item => item.id + '.png')];
        const target = path.join(resultsDirectory, name);
        if (!allowed.includes(name) || !fs.existsSync(target)) { response.writeHead(404); response.end('Henüz sonuç raporu yok.'); return; }
        return file(target);
      }
      if (url.pathname === '/popup.html') {
        let html = fs.readFileSync(path.join(extension, 'popup/popup.html'), 'utf8');
        html = html.replace('href="popup.css"', 'href="/extension/popup/popup.css"')
          .replace('src="../autofill_diagnostics.js"', 'src="/extension/autofill_diagnostics.js"')
          .replace('src="popup.js"', 'src="/extension/popup/popup.js"')
          .replace('<script src="/extension/autofill', '<script src="/popup-shim.js"></script><script src="/extension/autofill');
        return send(html);
      }
      if (url.pathname.startsWith('/extension/')) {
        const relative = decodeURIComponent(url.pathname.slice('/extension/'.length));
        const target = path.resolve(extension, relative);
        if (!target.startsWith(extension + path.sep) || !fs.existsSync(target) || !fs.statSync(target).isFile()) {
          response.writeHead(404); response.end(); return;
        }
        return file(target);
      }
      if (url.pathname.startsWith('/case/')) {
        const id = url.pathname.split('/')[2];
        const scenario = cases.find(item => item.id === id || item.path === url.pathname);
        if (!scenario) { response.writeHead(404); response.end('Senaryo bulunamadı.'); return; }
        const native = url.searchParams.get('mode') === 'native';
        const config = { scenario, native, profile: url.searchParams.get('profile') || defaultProfiles[scenario.id] || 'available',
          language: ['tr', 'en', 'de'].includes(url.searchParams.get('lang')) ? url.searchParams.get('lang') : 'tr',
          session: (url.searchParams.get('session') || id).slice(0, 80), secondPort,
          child: url.searchParams.get('child') === '1', result: url.searchParams.get('result') === '1',
          theme: url.searchParams.get('theme') === 'dark' ? 'dark' : 'light',
          extensionVersion: JSON.parse(fs.readFileSync(path.join(extension, 'manifest.json'), 'utf8')).version,
          allFrames: JSON.parse(fs.readFileSync(path.join(extension, 'manifest.json'), 'utf8')).content_scripts[0].all_frames };
        return send(`<!doctype html><html lang="tr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>LocKeep Lab · ${scenario.title}</title><link rel="stylesheet" href="/case.css"><script>window.LAB_CONFIG=${jsonForScript(config)}</script><script defer src="/fixture.js"></script>${native ? '' : '<link rel="stylesheet" href="/extension/content_styles.css"><script defer src="/bridge.js"></script><script defer src="/extension/autofill_diagnostics.js"></script><script defer src="/extension/content_script.js"></script>'}</head><body><main id="fixture"></main></body></html>`);
      }
      response.writeHead(404); response.end('Bulunamadı.');
    } catch { response.writeHead(500); response.end('Yerel test sayfası hazırlanamadı.'); }
  };
}
async function createLabServer({ port = 4318 } = {}) {
  const servers = [http.createServer(handler(port + 1)), http.createServer(handler(port + 1))];
  try {
    for (let index = 0; index < servers.length; index++) {
      await new Promise((resolve, reject) => { servers[index].once('error', reject); servers[index].listen(port + index, '127.0.0.1', resolve); });
    }
  } catch (error) { servers.forEach(server => server.close()); throw error; }
  return { url: `http://127.0.0.1:${port}`, close: () => Promise.all(servers.map(server => new Promise(resolve => {
    server.close(resolve); server.closeAllConnections?.();
  }))) };
}
module.exports = { createLabServer };
if (require.main === module) {
  const port = Number(process.env.LOCKEEP_LAB_PORT || 4318);
  if (!Number.isInteger(port) || port < 1024 || port > 65534) throw new Error('Invalid lab port.');
  createLabServer({ port }).then(lab => {
    console.log(`LocKeep Browser Lab: ${lab.url} (${cases.length} scenarios; loopback only)`);
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => { await lab.close(); process.exit(0); });
  }).catch(error => { console.error(error.code === 'EADDRINUSE' ? 'Lab port is already in use. Set LOCKEEP_LAB_PORT to a free port.' : error.message); process.exitCode = 1; });
}
