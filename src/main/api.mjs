// The HTTP API (see API.md): requests in, answers out. The face (the window and the renderer) and
// the speech record are handed in, so this is tested without Electron.

import { characterOf } from '../shared/characters.mjs';
import { LOOKS, TURNS, catalogJSON, expressionName, gestureName, headName, moodName, poseName } from '../shared/catalog.mjs';
import { VOICES, resolveVoice, voiceJSON } from '../shared/voices.mjs';
import { direct, merge } from '../shared/director.mjs';
import { parse } from '../shared/text.mjs';
import { recordJSON } from './speech.mjs';
import { statusPage } from './status-page.mjs';

export const MAX_TEXT = 20_000;
const MAX_BODY = 1024 * 1024;

export class HTTPError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

const ROUTES = {
  '/': 'GET',
  '/index.html': 'GET',
  '/favicon.ico': 'GET',
  '/api.md': 'GET',
  '/api/health': 'GET',
  '/api/voices': 'GET',
  '/api/catalog': 'GET',
  '/api/expressions': 'POST',
  '/api/speak': 'POST',
  '/api/stop': 'POST',
  '/api/express': 'POST',
  '/api/show': 'POST',
  '/api/hide': 'POST',
  '/api/toggle': 'POST',
  '/api/said': 'GET',
  '/api/echo': 'POST',
  '/api/events': 'GET',
  '/api/tts': 'POST',
  '/api/settings': 'GET POST',
  '/api/update': 'GET POST',
  '/api/assistant': 'GET',
  '/api/chat': 'GET POST',
  '/api/chat/new': 'POST',
  '/api/chat/clear': 'POST',
  '/api/trace/model': 'GET',
  '/api/trace/calls': 'GET',
  '/api/cancel': 'POST',
  '/api/peter': 'POST',
  '/api/heard': 'POST',
  '/api/tools': 'GET POST',
  '/api/schedules': 'GET POST',
  '/api/schedules/cancel': 'POST',
  '/api/memory': 'GET POST',
  '/api/errors': 'GET',
};

/** Settings a client may change through POST /api/settings, and how each is checked. */
const SETTABLE = {
  avatar: (v, ctx) => (ctx.avatars.includes(v) ? v : bad(`avatar is one of ${ctx.avatars.join(', ')}`)),
  voice: (v) => resolveVoice(v)?.id ?? bad(`no voice named ${v}`, 'unknown_voice'),
  speed: (v) => speedOf(v),
  mood: (v) => moodName(v) ?? bad(`no mood named ${v}`, 'unknown_name'),
  // "model" is what it was once: the words decide now.
  expressions: (v) => (v === 'model' ? 'rules' : ['rules', 'off'].includes(v) ? v : bad('expressions is rules or off')),
  captions: (v) => !!v,
  hideAfter: (v) => (Number.isFinite(+v) && +v >= 0 && +v <= 3600 ? +v : bad('hideAfter is seconds, 0 to 3600')),
  ollamaUrl: (v) => (/^https?:\/\/[^\s]+$/.test(String(v)) ? String(v).replace(/\/+$/, '') : bad('ollamaUrl is an http address')),
  toolRunUrl: (v) => (/^https?:\/\/[^\s]+$/.test(String(v)) ? String(v).replace(/\/+$/, '') : bad('toolRunUrl is an http address')),
  model: (v) => String(v ?? '').trim(),
  think: (v) => !!v,
  listening: (v) => !!v,
  listenWhileSpeaking: (v) => !!v,
  busyTone: (v) => !!v,
};

function bad(message, code = 'bad_request') {
  throw new HTTPError(400, code, message);
}

function speedOf(v, fallback) {
  if (v === undefined || v === null) {
    if (fallback !== undefined) return fallback;
    bad('speed must be a number', 'bad_speed');
  }
  const n = typeof v === 'string' ? Number(v) : v;
  if (typeof n !== 'number' || !Number.isFinite(n)) bad('speed must be a number', 'bad_speed');
  if (n < 0.5 || n > 2) bad('speed must be between 0.5 and 2', 'bad_speed');
  return n;
}

/** The host a request names is this machine (a website can't reach us by pointing a name at 127.0.0.1). */
export function localHost(host) {
  if (!host) return true;
  const h = host.replace(/:\d+$/, '').replace(/^\[|\]$/g, '').toLowerCase();
  return h === '127.0.0.1' || h === 'localhost' || h === '::1';
}

/** A browser origin that may call: this machine's pages, and those added in settings. */
export function allowedOrigin(origin, extra = []) {
  if (!origin) return true;
  if (/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(origin)) return true;
  if (origin === 'null' || origin.startsWith('file://')) return false;
  return extra.some((g) => g === '*' || new RegExp(`^${g.split('*').map((p) => p.replace(/[.+?^${}()|[\]\\/]/g, '\\$&')).join('.*')}$`, 'i').test(origin));
}

/**
 * @param {object} o
 * @param {import('./speech.mjs').Speech} o.speech
 * @param {object} o.face - status(), show(), hide(), toggle(), express(d), tts(d)
 * @param {{get: () => object, set: (patch: object) => object}} o.settings
 * @param {string} o.version
 * @param {object} [o.updater] - state(), check(), install()
 * @param {() => string} [o.docs] - API.md
 * @param {string[]} [o.avatars]
 * @param {number} [o.readyWait] - ms a speak waits for the avatar to finish starting
 * @param {ReturnType<import('./core.mjs').createCore>} [o.core] - the assistant and its tools
 */
export function createApi({ speech, face, settings, version, updater = null, docs = () => '', avatars = [], readyWait = 15_000, core = null }) {
  const started = Date.now();

  async function handle(req, res) {
    const s = settings.get();
    const url = new URL(req.url, 'http://x');
    let path = url.pathname;
    if (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1);
    const origin = req.headers.origin;
    const cors = {};
    if (origin && allowedOrigin(origin, s.origins || [])) {
      cors['Access-Control-Allow-Origin'] = origin;
      cors['Access-Control-Allow-Methods'] = 'GET, POST, OPTIONS';
      cors['Access-Control-Allow-Headers'] = 'Content-Type, Authorization';
      cors.Vary = 'Origin';
    }
    try {
      if (!localHost(req.headers.host)) throw new HTTPError(403, 'forbidden', 'only this machine may call Super Face');
      if (origin && !cors['Access-Control-Allow-Origin']) throw new HTTPError(403, 'forbidden', `origin ${origin} isn't allowed`);
      if (req.method === 'OPTIONS') return send(res, 204, null, cors);

      let route = path;
      let speakId = null;
      const m = path.match(/^\/api\/speak\/([\w-]+)$/);
      if (m) {
        route = '/api/speak/:id';
        speakId = m[1];
      }
      const methods = route === '/api/speak/:id' ? 'GET' : ROUTES[route];
      if (!methods) throw new HTTPError(404, 'not_found', `no such route: ${path}; the routes: ${Object.keys(ROUTES).join(' ')} /api/speak/{id}`);
      const method = req.method === 'HEAD' ? 'GET' : req.method;
      if (!methods.split(' ').includes(method)) throw new HTTPError(405, 'bad_request', `${path} takes ${methods.replace(' ', ' or ')}`, { allow: methods });

      const out = await route_(route, method, req, res, url, s, speakId);
      if (out === undefined) return; // streamed
      const [status, body, headers = {}] = out;
      return send(res, status, body, { ...cors, ...headers });
    } catch (err) {
      const e = err instanceof HTTPError ? err : new HTTPError(500, 'failed', err?.message || String(err));
      const headers = { ...cors };
      if (e.code === 'model_loading' || e.code === 'not_ready') headers['Retry-After'] = '5';
      if (e.extra.allow) headers.Allow = e.extra.allow.replace(' ', ', ');
      const { allow: _a, ...extra } = e.extra;
      return send(res, e.status, { error: e.message, code: e.code, ...extra }, headers);
    }
  }

  async function route_(route, method, req, res, url, s, speakId) {
    switch (route) {
      case '/':
      case '/index.html':
        return [200, statusPage(s.port), { 'Content-Type': 'text/html; charset=utf-8' }];
      case '/favicon.ico':
        return [204, null];
      case '/api.md':
        return [200, docs().replaceAll('127.0.0.1:8769', `127.0.0.1:${s.port}`), { 'Content-Type': 'text/markdown; charset=utf-8' }];
      case '/api/health':
        return [200, health(s)];
      case '/api/voices':
        return [200, { default: s.voice, speed: s.speed, voices: VOICES.map(voiceJSON) }];
      case '/api/catalog':
        return [200, catalogJSON()];
      case '/api/expressions': {
        // What the character would show for this text, sentence by sentence, with nothing said.
        const b = await body(req);
        const list = parse(textOf(b)).sentences;
        const mood = moodName(b.mood) || s.mood;
        const auto = direct(list.map((x) => x.text), { mood });
        return [200, { mood, sentences: list.map((x, i) => ({ text: x.text, ...merge({ auto: auto[i], cues: x.cues }), kinds: auto[i].kinds })) }];
      }
      case '/api/speak':
        return speak(await body(req), s);
      case '/api/speak/:id': {
        const rec = speech.get(speakId);
        if (!rec) throw new HTTPError(404, 'not_found', `no utterance ${speakId} (only the last 200 are kept)`);
        if (url.searchParams.get('wait') === 'true') await speech.wait(speakId);
        return [200, { ok: true, ...recordJSON(speech.get(speakId)) }];
      }
      case '/api/stop': {
        const b = await body(req, true);
        return [200, { ok: true, stopped: speech.stop(b.source || undefined) }];
      }
      case '/api/express': {
        const d = direction(await body(req));
        if (!Object.keys(d).length) bad('send at least one of mood, expression, gesture, head, pose, look, turn');
        const b = d;
        if (b.show !== false) face.show();
        delete b.show;
        await face.express(b);
        return [200, { ok: true, ...b }];
      }
      case '/api/show':
        face.show();
        return [200, { ok: true, visible: true }];
      case '/api/hide':
        face.hide();
        return [200, { ok: true, visible: false }];
      case '/api/toggle':
        return [200, { ok: true, visible: face.toggle() }];
      case '/api/said': {
        const seconds = Math.min(300, Math.max(1, Number(url.searchParams.get('seconds')) || 30));
        return [200, { speaking: speech.speaking, current: speech.current, lines: speech.said(seconds) }];
      }
      case '/api/echo': {
        const b = await body(req);
        const text = typeof b.text === 'string' ? b.text : '';
        if (!text.trim()) throw new HTTPError(400, 'missing_text', 'missing text: what was heard');
        const at = b.at === undefined ? Date.now() : Number(b.at);
        const seconds = b.seconds === undefined ? 10 : Number(b.seconds);
        if (!Number.isFinite(at) || !Number.isFinite(seconds)) bad('at is milliseconds since 1970, seconds a number');
        return [200, speech.echo(text, { at, seconds: Math.min(120, Math.max(0, seconds)) })];
      }
      case '/api/events':
        events(req, res, s);
        return undefined;
      case '/api/tts':
        return tts(await body(req), s);
      case '/api/settings': {
        if (method === 'GET') return [200, publicSettings(s)];
        const patch = await body(req);
        const clean = {};
        for (const [k, v] of Object.entries(patch)) {
          if (!SETTABLE[k]) bad(`${k} can't be set here; these can: ${Object.keys(SETTABLE).join(', ')}`);
          clean[k] = SETTABLE[k](v, { avatars });
        }
        // The character is its voice: choosing one chooses the other.
        if (clean.avatar && !('voice' in clean)) clean.voice = characterOf(clean.avatar).voice;
        return [200, publicSettings(settings.set(clean))];
      }
      case '/api/assistant':
        return [200, needCore().status()];
      case '/api/chat': {
        const c = needCore();
        if (method === 'GET') {
          const limit = Math.min(300, Math.max(1, Number(url.searchParams.get('limit')) || 50));
          return [200, { entries: c.actions.log().slice(-limit), state: c.assistant.state() }];
        }
        const b = await body(req);
        const text = typeof b.text === 'string' ? b.text : '';
        if (!text.trim()) throw new HTTPError(400, 'missing_text', 'missing text: what to ask');
        if (text.length > MAX_TEXT) throw new HTTPError(413, 'too_large', `text is over ${MAX_TEXT} characters`);
        const entry = c.assistant.say(text, { how: 'api' });
        if (b.show !== false) face.show();
        if (!b.wait) return [202, { ok: true, id: entry.id }];
        const reply = await waitForReply(c, entry);
        return [200, { ok: true, id: entry.id, ...reply }];
      }
      case '/api/chat/new':
        needCore().actions.newChat();
        return [200, { ok: true }];
      case '/api/chat/clear':
        needCore().actions.clearChat();
        return [200, { ok: true }];
      case '/api/trace/model':
      case '/api/trace/calls': {
        const limit = Math.min(80, Math.max(1, Number(url.searchParams.get('limit')) || 20));
        return [200, { items: needCore().actions.trace({ log: route.split('/').pop() }).items.slice(-limit) }];
      }
      case '/api/cancel':
        return [200, needCore().actions.cancel()];
      case '/api/peter': {
        // Tool Mac Tool Run, calling back: a run asked of Peter is over (text, or JSON with its entries).
        const b = await body(req);
        const text = typeof b.text === 'string' ? b.text : '';
        if (!text.trim()) throw new HTTPError(400, 'missing_text', 'missing text: what Peter says');
        if (text.length > MAX_TEXT) throw new HTTPError(413, 'too_large', `text is over ${MAX_TEXT} characters`);
        return [202, needCore().actions.peterNews({ text, entries: b.entries })];
      }
      case '/api/heard': {
        const c = needCore();
        const b = await body(req);
        const text = typeof b.text === 'string' ? b.text : '';
        if (!text.trim()) throw new HTTPError(400, 'missing_text', 'missing text: what was heard');
        const at = b.at === undefined ? Date.now() : Number(b.at);
        return [200, { ok: true, ...c.heard({ text, at, seconds: Number(b.seconds) || 0 }) }];
      }
      case '/api/tools':
        return [200, method === 'POST' ? await needCore().refreshTools() : needCore().actions.tools()];
      case '/api/schedules': {
        const c = needCore();
        if (method === 'GET') return [200, { schedules: c.actions.schedules() }];
        const b = await body(req);
        const { dueFrom } = await import('./scheduler.mjs');
        const due = dueFrom(b);
        if (!Number.isFinite(due)) bad('say when: in_minutes, or at (a local date and time, e.g. "2026-10-24 17:30")');
        try {
          const t = c.scheduler.add({ task: b.task, due });
          return [201, { ok: true, ...t }];
        } catch (err) {
          bad(err.message);
        }
        break;
      }
      case '/api/schedules/cancel': {
        const b = await body(req);
        if (b.id === undefined) bad('send the id (or "all")');
        const gone = needCore().scheduler.cancel(b.id);
        return [200, { ok: gone.length > 0, cancelled: gone.map((t) => t.id) }];
      }
      case '/api/memory': {
        const c = needCore();
        // What it has learned, as kept in Tool Mac Tool Run: its playbook and the standing
        // instructions (the library), what MEMORY has on the user.
        if (method === 'POST') {
          const b = await body(req);
          if (typeof b.instructions === 'string') await c.notes.setInstructions(b.instructions);
          if (b.forget) await c.notes.forget(typeof b.forget === 'string' ? b.forget : b.forget.note);
        }
        return [200, (await c.notes.refresh()).json()];
      }
      case '/api/errors': {
        const c = needCore();
        return [200, c.actions.errors()];
      }
      case '/api/update': {
        if (!updater) throw new HTTPError(503, 'unavailable', 'updates are only available in the app');
        if (method === 'POST') {
          const b = await body(req, true);
          if (b.install) await updater.install();
          else await updater.check(true);
        }
        return [200, updater.state()];
      }
    }
    throw new HTTPError(404, 'not_found', 'no such route');
  }

  function needCore() {
    if (!core) throw new HTTPError(503, 'unavailable', 'the assistant is only available in the app');
    return core;
  }

  /** Waits for the request's turn to end, and gives what was said in answer. */
  async function waitForReply(c, entry) {
    const start = c.assistant.log.indexOf(entry);
    for (let i = 0; i < 6000; i++) {
      await new Promise((r) => setTimeout(r, 100));
      const pending = c.assistant.inbox.some((x) => x.entry === entry);
      if (!pending && !c.assistant.busy) break;
    }
    const after = c.assistant.log.slice(start + 1);
    const said = after.filter((e) => e.kind === 'assistant' && !e.hidden && e.text).map((e) => e.text);
    return {
      reply: said.join(' '),
      tools: after.filter((e) => e.kind === 'tool').map((e) => ({ name: e.name, state: e.state, result: e.result })),
      error: after.find((e) => e.kind === 'error')?.text,
    };
  }

  function health(s) {
    const f = face.status();
    return {
      ok: true,
      service: 'superface',
      version,
      port: s.port,
      uptime: Math.round((Date.now() - started) / 1000),
      visible: f.visible,
      speaking: speech.speaking,
      queued: speech.queued,
      avatar: f.avatar,
      ...(f.message ? { message: f.message } : {}),
      ready: f.avatar === 'ready' && f.tts?.state === 'ready',
      models: { tts: f.tts },
      expressions: s.expressions,
      ...(core ? { assistant: core.assistant.state(), ears: core.status().ears, character: core.character().name } : {}),
    };
  }

  /**
   * Speaks only when it can: the avatar shown and the voice loaded. While they're starting it
   * waits (a few seconds, as when the app has just opened); anything else is said at once, so a
   * caller isn't left waiting on an avatar that will never speak, and can say it another way.
   */
  async function readyToSpeak() {
    const until = Date.now() + readyWait;
    for (;;) {
      const f = face.status();
      const t = f.tts || {};
      if (f.avatar === 'failed') throw new HTTPError(503, 'avatar_failed', `the avatar didn't load: ${f.message || t.message || 'unknown error'}`);
      if (t.state === 'failed') throw new HTTPError(503, 'model_failed', `the voice model didn't load: ${t.message || 'unknown error'}`);
      if (t.state === 'downloading') {
        throw new HTTPError(503, 'model_loading', 'getting the voices ready (downloading, the first time only)', { progress: t.progress ?? 0 });
      }
      if (f.avatar === 'ready' && t.state === 'ready') return;
      if (Date.now() >= until) throw new HTTPError(503, 'not_ready', 'the avatar is still starting: try again in a moment');
      await new Promise((r) => setTimeout(r, 200));
    }
  }

  function textOf(b) {
    const text = b.text ?? b.input;
    if (typeof text !== 'string' || !text.trim()) throw new HTTPError(400, 'missing_text', 'missing text');
    if (text.length > MAX_TEXT) throw new HTTPError(413, 'too_large', `text is over ${MAX_TEXT} characters`);
    return text;
  }

  function voiceOf(b, s) {
    const v = resolveVoice(b.voice, s.voice);
    if (!v) throw new HTTPError(400, 'unknown_voice', `no voice named ${b.voice}; the voices: ${VOICES.map((x) => x.name).join(', ')} (or f1-f4, m1-m4)`);
    return v.id;
  }

  async function speak(b, s) {
    const text = textOf(b);
    await readyToSpeak();
    const u = {
      text,
      voice: voiceOf(b, s),
      speed: speedOf(b.speed, s.speed),
      ...direction(b),
      source: typeof b.source === 'string' ? b.source.slice(0, 40) : '',
      who: typeof b.who === 'string' ? b.who.slice(0, 40) : '',
      interrupt: !!b.interrupt,
      auto: b.auto !== false, // pick expressions for what the caller left out
    };
    const show = u.show !== false;
    delete u.show;
    if (show) face.show();
    const rec = speech.enqueue(u);
    if (b.wait) {
      const done = await speech.wait(rec.id);
      return [200, { ok: done?.state === 'done', ...recordJSON(done) }];
    }
    return [202, { ok: true, id: rec.id, queued: speech.queued }];
  }

  async function tts(b, s) {
    const text = textOf(b);
    await readyToSpeak();
    const format = String(b.format || 'wav').toLowerCase();
    if (!['wav', 'pcm', 'json'].includes(format)) bad('format is wav, pcm or json');
    const voice = voiceOf(b, s);
    const r = await face.tts({ text, voice, speed: speedOf(b.speed, s.speed) });
    const pcm = Buffer.from(r.pcm);
    const headers = { 'X-Voice': voice, 'X-Sample-Rate': String(r.sampleRate), 'X-Duration': String(Math.round((pcm.length / 2 / r.sampleRate) * 100) / 100) };
    if (format === 'json') {
      const { pcm: _p, ...timing } = r;
      return [200, { ...timing, voice, audio: wav(pcm, r.sampleRate).toString('base64'), audioEncoding: 'wav' }, headers];
    }
    if (format === 'pcm') return [200, pcm, { ...headers, 'Content-Type': 'audio/pcm' }];
    return [200, wav(pcm, r.sampleRate), { ...headers, 'Content-Type': 'audio/wav' }];
  }

  function events(req, res, s) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      ...(req.headers.origin && allowedOrigin(req.headers.origin, s.origins || []) ? { 'Access-Control-Allow-Origin': req.headers.origin } : {}),
    });
    const write = (e) => res.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
    write({ type: 'hello', speaking: speech.speaking, current: speech.current, at: Date.now() });
    const off = speech.subscribe(write);
    // The traces (every prompt in full, every request) are the chat's, and /api/trace/*'s: not sent here.
    const offCore = core ? core.subscribe((e) => e.type !== 'trace' && write(e)) : () => {};
    const ping = setInterval(() => res.write(': ping\n\n'), 15000);
    req.on('close', () => {
      off();
      offCore();
      clearInterval(ping);
    });
  }

  return handle;
}

/** The mood, expression, gesture, head movement, pose, look and turn a request asks for (checked). */
export function direction(b) {
  const d = {};
  const check = (key, fn, what) => {
    if (b[key] === undefined || b[key] === null || b[key] === '' || b[key] === 'none') return;
    const v = fn(b[key]);
    if (!v) throw new HTTPError(400, 'unknown_name', `no ${what} named ${b[key]} (GET /api/catalog lists them)`);
    d[key] = v;
  };
  check('mood', moodName, 'mood');
  check('expression', expressionName, 'expression');
  check('gesture', gestureName, 'gesture');
  check('head', headName, 'head movement');
  check('pose', poseName, 'pose');
  if (b.look !== undefined) {
    if (!LOOKS.includes(b.look)) bad(`look is ${LOOKS.join(', ')}`);
    d.look = b.look;
  }
  if (b.turn !== undefined) {
    if (!TURNS.includes(b.turn)) bad(`turn is ${TURNS.join(', ')}`);
    d.turn = b.turn;
  }
  if (b.duration !== undefined) {
    const n = Number(b.duration);
    if (!Number.isFinite(n) || n <= 0 || n > 60) bad('duration is seconds, up to 60');
    d.duration = n;
  }
  if (b.show !== undefined) d.show = !!b.show;
  return d;
}

function publicSettings(s) {
  const { bounds: _b, ...rest } = s;
  return rest;
}

/** 16-bit mono PCM in a WAV file. */
export function wav(pcm, rate) {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0);
  h.writeUInt32LE(36 + pcm.length, 4);
  h.write('WAVE', 8);
  h.write('fmt ', 12);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write('data', 36);
  h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

/** The request's body: JSON (or plain text, as `text`). `optional`: an empty body is {}. */
async function body(req, optional = false) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > MAX_BODY) throw new HTTPError(413, 'too_large', 'the body is over 1 MB');
    chunks.push(c);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw.trim()) {
    if (optional) return {};
    throw new HTTPError(400, 'missing_text', 'send JSON, e.g. {"text": "Hello"}');
  }
  const type = String(req.headers['content-type'] || '');
  // JSON sent as text/plain (a browser's fetch with a string body) is still JSON when it parses
  // to an object with something to say.
  if (!type.includes('json') && raw.trimStart().startsWith('{')) {
    try {
      const o = JSON.parse(raw);
      if (o && typeof o === 'object' && !Array.isArray(o)) return o;
    } catch {
      if (type.startsWith('text/')) return { text: raw };
    }
  }
  if (type.includes('json') || (!type.startsWith('text/') && raw.trimStart().startsWith('{'))) {
    try {
      const o = JSON.parse(raw);
      if (!o || typeof o !== 'object' || Array.isArray(o)) throw new Error();
      return o;
    } catch {
      throw new HTTPError(400, 'bad_request', "the body isn't valid JSON");
    }
  }
  return { text: raw };
}

function send(res, status, body, headers = {}) {
  if (body === null || body === undefined) {
    res.writeHead(status, headers);
    return res.end();
  }
  if (Buffer.isBuffer(body)) {
    res.writeHead(status, { 'Content-Length': body.length, ...headers });
    return res.end(body);
  }
  if (typeof body === 'string') {
    const b = Buffer.from(body);
    res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Content-Length': b.length, ...headers });
    return res.end(b);
  }
  const b = Buffer.from(JSON.stringify(body));
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': b.length, ...headers });
  return res.end(b);
}
