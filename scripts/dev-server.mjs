// Super Face without Electron: `npm run dev`, then open http://127.0.0.1:8769/renderer/index.html
// in Chrome. The page is the avatar; this server is the API and stands in for the main process
// (commands go to the page over Server-Sent Events). For working on the avatar in a browser.

import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApi } from '../src/main/api.mjs';
import { Settings } from '../src/main/settings.mjs';
import { Speech } from '../src/main/speech.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT) || 8769;
const settings = new Settings(path.join(os.tmpdir(), 'superface-dev-settings.json'));
settings.set({ port: PORT });

const pages = new Set();
let nextId = 0;
const pending = new Map();
let face = { avatar: 'loading', tts: { state: 'not_loaded' }, backend: null };
let visible = true;

function send(type, data) {
  const id = ++nextId;
  for (const res of pages) res.write(`data: ${JSON.stringify({ id, type, data })}\n\n`);
  return id;
}

function ask(type, data, timeout = 120_000) {
  return new Promise((resolve, reject) => {
    if (!pages.size) return reject(new Error('no avatar page is open'));
    const id = send(type, data);
    const timer = setTimeout(() => (pending.delete(id), reject(new Error(`${type} took too long`))), timeout);
    pending.set(id, { resolve, reject, timer });
  });
}

const speech = new Speech({ send });
settings.onChange((s, before) => {
  const changed = Object.keys(s).filter((k) => s[k] !== before[k] && k !== 'bounds');
  if (changed.length) send('settings', Object.fromEntries(changed.map((k) => [k, s[k]])));
});

const api = createApi({
  speech,
  settings,
  version: JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version + '-dev',
  docs: () => fs.readFileSync(path.join(ROOT, 'API.md'), 'utf8'),
  avatars: ['brunette', 'david'],
  face: {
    status: () => ({ visible, ...face }),
    show: () => (visible = true),
    hide: () => (visible = false),
    toggle: () => (visible = !visible),
    express: (d) => ask('express', d, 10_000),
    tts: async (d) => {
      const r = await ask('tts', d);
      return { ...r, pcm: r.pcmBase64 ? Buffer.from(r.pcm, 'base64') : r.pcm };
    },
  },
});

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.wasm': 'application/wasm', '.glb': 'model/gltf-binary', '.txt': 'text/plain' };

async function readJSON(req) {
  let s = '';
  for await (const c of req) s += c;
  return s ? JSON.parse(s) : {};
}

http
  .createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;
    if (p === '/dev/cmd') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
      res.write(': hello\n\n');
      pages.add(res);
      req.on('close', () => pages.delete(res));
      return;
    }
    if (p === '/dev/settings') {
      if (req.method === 'POST') settings.set(await readJSON(req));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(settings.get()));
    }
    if (p === '/dev/reply') {
      const { id, ok, result, error } = await readJSON(req);
      const w = pending.get(id);
      if (w) {
        pending.delete(id);
        clearTimeout(w.timer);
        ok ? w.resolve(result) : w.reject(new Error(error));
      }
      return res.writeHead(204).end();
    }
    if (p === '/dev/event') {
      const ev = await readJSON(req);
      if (ev.type === 'state') face = { ...face, ...ev.state };
      else speech.event(ev);
      if (process.env.VERBOSE) console.log('event', JSON.stringify(ev));
      return res.writeHead(204).end();
    }
    if (/^\/(renderer|src\/shared|node_modules)\//.test(p)) {
      const file = path.normalize(path.join(ROOT, decodeURIComponent(p)));
      if (!file.startsWith(ROOT)) return res.writeHead(404).end();
      return fs.readFile(file, (err, data) => {
        if (err) return res.writeHead(404).end();
        res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
        res.end(data);
      });
    }
    return api(req, res);
  })
  .listen(PORT, '127.0.0.1', () => console.log(`Super Face (dev): http://127.0.0.1:${PORT}/renderer/index.html — the API is on the same port`));
