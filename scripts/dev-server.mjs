// Super Face without Electron: `npm run dev`, then open http://127.0.0.1:8769/renderer/index.html
// in Chrome (the character, and its ears) and /renderer/chat.html (the chat). This server is the
// API and stands in for the main process: commands go to the page over Server-Sent Events, the
// chat's actions come in as POST /dev/ui/{name}. For working on it in a browser.

import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApi } from '../src/main/api.mjs';
import { createCore } from '../src/main/core.mjs';
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
  if (process.env.VERBOSE) console.log('cmd', id, type, JSON.stringify(data).slice(0, 120));
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
const dataDir = process.env.SUPERFACE_DATA || path.join(os.tmpdir(), 'superface-dev');
const core = createCore({
  settings,
  speech,
  dataDir,
  host: {
    show: () => (visible = true),
    face: () => face,
    about: () => ({ version: JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version + '-dev', os: `${os.type()} ${os.release()}`, arch: process.arch, electron: '(browser)', chrome: '(browser)' }),
    retryVoice: () => ask('retryVoice', {}, 10 * 60_000),
  },
});
const uiClients = new Set();
const toUi = (ev) => {
  for (const res of uiClients) res.write(`data: ${JSON.stringify(ev)}\n\n`);
};
core.subscribe(toUi);
speech.subscribe((ev) => {
  if (['started', 'ended', 'stopped', 'failed'].includes(ev.type)) toUi({ type: 'speech', speaking: speech.speaking || speech.queued > 0 });
});
let earsOn = null;
function updateEars() {
  const on = !!(settings.get().listening && visible && face.avatar === 'ready');
  if (on !== earsOn) send('ears', { on });
  earsOn = on;
}
settings.onChange((s, before) => {
  if (s.listening !== before.listening) updateEars();
  const changed = Object.keys(s).filter((k) => s[k] !== before[k] && k !== 'bounds');
  if (changed.length) send('settings', Object.fromEntries(changed.map((k) => [k, s[k]])));
});

const api = createApi({
  speech,
  settings,
  version: JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version + '-dev',
  docs: () => fs.readFileSync(path.join(ROOT, 'API.md'), 'utf8'),
  avatars: ['brunette', 'david', 'avaturn', 'avatarsdk'],
  core,
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
      if (ev.type === 'state') {
        if (ev.state.avatar === 'loading' && face.avatar !== 'loading') earsOn = null; // the page started again
        const was = face;
        face = { ...face, ...ev.state };
        if (face.avatar !== was.avatar || face.tts?.state !== was.tts?.state) toUi({ type: 'status', status: core.status() });
        updateEars();
      } else if (ev.type === 'ears') core.setEars(ev.state);
      else if (ev.type === 'heard') core.heard(ev);
      else if (ev.type === 'error') core.reportError(ev);
      else speech.event(ev);
      if (process.env.VERBOSE) console.log('event', JSON.stringify(ev));
      return res.writeHead(204).end();
    }
    if (p === '/dev/ui-events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
      res.write(': hello\n\n');
      uiClients.add(res);
      req.on('close', () => uiClients.delete(res));
      return;
    }
    const ui = p.match(/^\/dev\/ui\/(\w+)$/);
    if (ui) {
      const fn = core.actions[ui[1]];
      try {
        if (!fn) throw new Error(`no action called ${ui[1]}`);
        const out = await fn(await readJSON(req));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify(out ?? null));
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: err.message }));
      }
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
  .listen(PORT, '127.0.0.1', () => {
    core.start();
    console.log(`Super Face (dev): http://127.0.0.1:${PORT}/renderer/index.html and /renderer/chat.html — the API is on the same port`);
  });
