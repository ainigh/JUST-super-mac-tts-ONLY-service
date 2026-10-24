// Super Face: the Electron main process. A menu bar icon; a frameless, transparent window with the
// character in it, head to toes, on standby as the app opens (listening, ready for anything); the
// chat beside it, shown and hidden by a click on the character; the HTTP API on 127.0.0.1:8769.
// The character's page does the speaking (HeadTTS), the moving (TalkingHead) and the hearing
// (Moonshine); this process holds the assistant (the core: the model, the tools, the schedule,
// memory), owns the windows, and answers the API.

import { app, BrowserWindow, Menu, Tray, clipboard, globalShortcut, ipcMain, nativeImage, screen, shell, systemPreferences } from 'electron';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApi } from './src/main/api.mjs';
import { createCore } from './src/main/core.mjs';
import { iconPixels } from './src/main/icon.mjs';
import { Settings } from './src/main/settings.mjs';
import { Speech } from './src/main/speech.mjs';
import { Updater } from './src/main/updater.mjs';
import { MOODS } from './src/shared/catalog.mjs';
import { CHARACTERS, SIZES, characterOf } from './src/shared/characters.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
const AVATARS = Object.fromEntries(CHARACTERS.map((c) => [c.id, `${c.name} (${c.body === 'F' ? 'woman' : 'man'})`]));
const CHAT = [360, 600]; // the chat window: width, and height at most
const STATIC_PORT = 18769; // the page's address stays the same, so what it downloads stays cached
const VIEWS = { full: 'Head to toes', mid: 'Waist up', upper: 'Head and shoulders', head: 'Face' };

if (!app.requestSingleInstanceLock()) app.quit();
app.setName('Super Face');
app.dock?.hide();

let win = null;
let chat = null;
let tray = null;
let rendererUrl = null;
let apiServer = null;
let apiState = 'stopped';
let hideTimer = null;
let face = { avatar: 'loading', tts: { state: 'not_loaded' }, backend: null };
const settings = new Settings(path.join(app.getPath('userData'), 'settings.json'));

// ---------------------------------------------------------------- the renderer: commands and replies

let nextCmd = 0;
const pending = new Map();

function send(type, data) {
  win?.webContents.send('cmd', { id: ++nextCmd, type, data });
  return nextCmd;
}

/** A command the renderer answers. */
function ask(type, data, timeout = 120_000) {
  return new Promise((resolve, reject) => {
    if (!win) return reject(new Error('the avatar window is closed'));
    const id = send(type, data);
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`${type} took too long`));
    }, timeout);
    pending.set(id, { resolve, reject, timer });
  });
}

ipcMain.on('reply', (_e, { id, ok, result, error }) => {
  const p = pending.get(id);
  if (!p) return;
  pending.delete(id);
  clearTimeout(p.timer);
  if (ok) p.resolve(result);
  else p.reject(new Error(error));
});

const speech = new Speech({ send: (type, data) => send(type, data) });
const core = createCore({
  settings,
  speech,
  dataDir: app.getPath('userData'),
  host: {
    show: () => show(),
    resize: (name) => (win ? resize(name) : settings.set({ size: name })),
    face: () => face,
    about: () => ({
      version: VERSION,
      os: `macOS ${process.getSystemVersion?.() || ''} (${process.platform})`.trim(),
      arch: process.arch,
      electron: process.versions.electron,
      chrome: process.versions.chrome,
    }),
    copy: (text) => (clipboard.writeText(text), true),
    retryVoice: () => ask('retryVoice', {}, 10 * 60_000),
  },
});

// What the core says goes to the chat (and the speaking state, so it can offer to stop).
let lastPhase = 'idle';
core.subscribe((ev) => {
  chat?.webContents.send('ui:event', ev);
  if (ev.type === 'assistant') {
    const phase = ev.state.phase;
    if (phase === 'thinking' && lastPhase !== 'thinking') send('attend', { state: 'thinking' });
    lastPhase = phase;
  }
});
speech.subscribe((ev) => {
  if (['started', 'ended', 'stopped', 'failed'].includes(ev.type)) {
    chat?.webContents.send('ui:event', { type: 'speech', speaking: speech.speaking || speech.queued > 0 });
    updateEars();
  }
});

/** The ears are on while the character is shown, it has loaded, and listening is on; paused while it talks, if so set. */
let earsSent = null;
function updateEars() {
  const s = settings.get();
  const on = !!(s.listening && win?.isVisible() && face.avatar === 'ready');
  const paused = !s.listenWhileSpeaking && (speech.speaking || speech.queued > 0);
  const key = `${on}/${paused}`;
  if (key === earsSent) return;
  earsSent = key;
  send('ears', { on, paused });
}

ipcMain.on('event', (_e, ev) => {
  if (ev.type === 'state') {
    const was = face;
    face = { ...face, ...ev.state };
    refreshMenu();
    if (face.avatar === 'failed' && was.avatar !== 'failed') {
      // Shown, so what went wrong can be read on it (and nobody waits on it to speak).
      console.error('Super Face: the avatar did not load:', face.message);
      for (const id of [...speech.order]) speech.finish(id, 'failed', `the avatar didn't load: ${face.message || ''}`);
      show();
    }
    if (face.avatar === 'ready' && face.tts.state === 'ready' && !settings.get().welcomed) welcome();
    if (face.avatar === 'loading' && was.avatar !== 'loading') earsSent = null; // the page started again
    updateEars();
    // The chat shows how the avatar and the voice are doing (and says when the voice didn't load).
    if (face.avatar !== was.avatar || face.tts.state !== was.tts?.state) chat?.webContents.send('ui:event', { type: 'status', status: core.status() });
    return;
  }
  if (ev.type === 'ears') {
    core.setEars(ev.state);
    return;
  }
  if (ev.type === 'heard') {
    core.heard(ev);
    return;
  }
  if (ev.type === 'error') {
    core.reportError(ev);
    return;
  }
  speech.event(ev);
  if (ev.type === 'started') {
    clearTimeout(hideTimer);
    setTrayIcon(true);
  }
  if (ev.type === 'ended') afterSpeaking();
});

speech.subscribe((ev) => {
  if (ev.type === 'stopped' || ev.type === 'failed') afterSpeaking();
});

/** The first time it's ready: it shows itself and says hello, so it's plain that it works. */
function welcome() {
  settings.set({ welcomed: true });
  show();
  const c = characterOf(settings.get().avatar);
  core.speakAs(`Hi! I'm ${c.name}. 👋 Just talk to me, I'm listening. Click me to open our chat, and drag me anywhere.`);
}

function afterSpeaking() {
  if (speech.speaking || speech.queued) return;
  setTrayIcon(false);
  const after = settings.get().hideAfter;
  clearTimeout(hideTimer);
  if (after > 0) hideTimer = setTimeout(() => !speech.speaking && hide(), after * 1000);
}

ipcMain.handle('settings:get', () => ({ ...settings.get(), avatars: AVATARS, version: VERSION }));
ipcMain.handle('direct', (_e, texts, who) => core.direct(texts, who));
ipcMain.handle('ui', async (_e, name, args) => {
  const fn = core.actions[name];
  if (!fn) throw new Error(`no action called ${name}`);
  return fn(args || {});
});
ipcMain.on('chat:toggle', () => toggleChat());
ipcMain.on('chat:hide', () => chat?.hide());
ipcMain.handle('settings:set', (_e, patch) => settings.set(patch));
ipcMain.on('menu:show', () => menu().popup({ window: win }));
let dragStart = null;
ipcMain.on('drag:start', () => win && (dragStart = win.getPosition()));
ipcMain.on('drag:move', (_e, dx, dy) => {
  if (win && dragStart) win.setPosition(Math.round(dragStart[0] + dx), Math.round(dragStart[1] + dy));
});
ipcMain.on('drag:end', () => {
  dragStart = null;
  if (win) settings.set({ bounds: win.getBounds() });
  placeChat();
});

// What the renderer is told when a setting it uses changes.
settings.onChange((s, before) => {
  const changed = ['avatar', 'view', 'voice', 'speed', 'mood', 'expressions', 'captions'].filter((k) => s[k] !== before[k]);
  if (changed.length) send('settings', Object.fromEntries(changed.map((k) => [k, s[k]])));
  if (s.port !== before.port || s.serving !== before.serving) serve();
  if (s.alwaysOnTop !== before.alwaysOnTop) win?.setAlwaysOnTop(s.alwaysOnTop, 'floating');
  if (s.listening !== before.listening || s.listenWhileSpeaking !== before.listenWhileSpeaking) updateEars();
  refreshMenu();
});

// ---------------------------------------------------------------- the window

function createWindow() {
  const s = settings.get();
  const area = screen.getPrimaryDisplay().workArea;
  const [w, h] = SIZES[s.size] || SIZES.Medium;
  const b = s.bounds && screen.getAllDisplays().some((d) => inside(s.bounds, d.workArea)) ? s.bounds : null;
  win = new BrowserWindow({
    width: b?.width ?? w,
    height: b?.height ?? Math.min(h, area.height),
    x: b?.x ?? area.x + area.width - w - 24,
    y: b?.y ?? area.y + area.height - Math.min(h, area.height),
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    resizable: false,
    alwaysOnTop: s.alwaysOnTop,
    fullscreenable: false,
    skipTaskbar: true,
    title: 'Super Face',
    webPreferences: {
      preload: path.join(ROOT, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      autoplayPolicy: 'no-user-gesture-required',
      backgroundThrottling: false,
    },
  });
  win.setAlwaysOnTop(s.alwaysOnTop, 'floating');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.on('moved', () => {
    settings.set({ bounds: win.getBounds() });
    placeChat();
  });
  win.on('closed', () => (win = null));
  win.on('show', () => {
    refreshMenu();
    updateEars();
  });
  win.on('hide', () => {
    refreshMenu();
    chat?.hide();
    updateEars();
  });
  win.webContents.on('render-process-gone', (_e, d) => {
    console.error('Super Face: the avatar crashed:', d.reason);
    core.reportError({ source: 'app', message: `The character's page stopped (${d.reason}, exit code ${d.exitCode}); it's reloaded` });
    for (const id of [...speech.order]) speech.finish(id, 'failed', 'the avatar crashed');
    setTimeout(() => win?.reload(), 1000);
  });
  win.loadURL(`${rendererUrl}/renderer/index.html`);
}

// ---------------------------------------------------------------- the chat, beside the character

function createChat() {
  chat = new BrowserWindow({
    width: CHAT[0],
    height: CHAT[1],
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    vibrancy: 'popover',
    visualEffectState: 'active',
    roundedCorners: true,
    resizable: true,
    minWidth: 300,
    minHeight: 360,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: settings.get().alwaysOnTop,
    parent: win || undefined, // it moves with the character
    title: 'Chat',
    webPreferences: { preload: path.join(ROOT, 'preload-chat.cjs'), contextIsolation: true, nodeIntegration: false },
  });
  chat.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  chat.on('closed', () => (chat = null));
  chat.loadURL(`${rendererUrl}/renderer/chat.html`);
}

/** Beside the character: on its left when there's room (it usually stands at the right), else its right. */
function placeChat() {
  if (!chat || !win) return;
  const b = win.getBounds();
  const area = screen.getDisplayMatching(b).workArea;
  const [w0] = chat.getSize();
  const w = Math.min(w0, area.width - b.width);
  const h = Math.min(CHAT[1], Math.max(400, b.height), area.height);
  let x = b.x - w - 8;
  if (x < area.x) x = b.x + b.width + 8;
  x = Math.max(area.x, Math.min(x, area.x + area.width - w));
  const y = Math.max(area.y, Math.min(b.y + b.height - h, area.y + area.height - h));
  chat.setBounds({ x: Math.round(x), y: Math.round(y), width: Math.round(w), height: Math.round(h) });
}

function showChat() {
  show();
  if (!chat) createChat();
  placeChat();
  chat.show();
  app.focus({ steal: true });
  chat.focus();
  chat.webContents.send('ui:event', { type: 'focus' });
}

function toggleChat() {
  if (chat?.isVisible()) chat.hide();
  else showChat();
}

const inside = (b, a) => b.x >= a.x - 50 && b.y >= a.y - 50 && b.x + b.width <= a.x + a.width + 50 && b.y + b.height <= a.y + a.height + 50;

function show() {
  clearTimeout(hideTimer);
  if (!win) createWindow();
  if (!win.isVisible()) win.showInactive();
}

function hide() {
  chat?.hide();
  win?.hide();
}

function toggle() {
  if (win?.isVisible()) {
    hide();
    return false;
  }
  show();
  return true;
}

function resize(name) {
  const [w, h] = SIZES[name];
  const b = win.getBounds();
  // Grow or shrink around the feet, where the avatar stands.
  const area = screen.getDisplayMatching(b).workArea;
  const height = Math.min(h, area.height);
  const x = Math.max(area.x, Math.min(b.x + Math.round((b.width - w) / 2), area.x + area.width - w));
  const y = Math.max(area.y, b.y + b.height - height);
  win.setBounds({ x, y, width: w, height });
  settings.set({ size: name, bounds: win.getBounds() });
  placeChat();
}

// ---------------------------------------------------------------- static files for the renderer

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.glb': 'model/gltf-binary',
  '.bin': 'application/octet-stream',
  '.txt': 'text/plain; charset=utf-8',
  '.png': 'image/png',
};
const SERVED = ['renderer', 'src/shared', 'node_modules'];

function startStatic(port = STATIC_PORT) {
  const server = http.createServer((req, res) => {
    let rel;
    try {
      rel = decodeURIComponent(new URL(req.url, 'http://x').pathname).replace(/^\/+/, '');
    } catch {
      return res.writeHead(400).end();
    }
    const file = path.normalize(path.join(ROOT, rel));
    if (!SERVED.some((d) => file.startsWith(path.join(ROOT, d) + path.sep))) return res.writeHead(404).end();
    fs.readFile(file, (err, data) => {
      if (err) return res.writeHead(404).end();
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
      res.end(data);
    });
  });
  // The same port every time (the voices and the ears' models are cached by the page's address);
  // any free one if it's taken.
  return new Promise((resolve) => {
    server.once('error', () => server.listen(0, '127.0.0.1'));
    server.on('listening', () => resolve(`http://127.0.0.1:${server.address().port}`));
    server.listen(port, '127.0.0.1');
  });
}

// ---------------------------------------------------------------- the API

const faceApi = {
  status: () => ({ visible: !!win?.isVisible(), avatar: face.avatar, tts: face.tts, backend: face.backend, message: face.message }),
  show,
  hide,
  toggle,
  express: (d) => ask('express', d, 10_000),
  tts: (d) => ask('tts', d),
};

const updater = new Updater({
  version: VERSION,
  appPath: () => {
    const exe = app.getPath('exe');
    const i = exe.indexOf('.app/Contents/MacOS/');
    return app.isPackaged && i !== -1 ? exe.slice(0, i + 4) : null;
  },
  quit: () => app.quit(),
  onChange: () => refreshMenu(),
});

const docs = () => {
  try {
    return fs.readFileSync(path.join(ROOT, 'API.md'), 'utf8');
  } catch {
    return '# Super Face API\n\nAPI.md is missing from this build.';
  }
};

const handle = createApi({ speech, face: faceApi, settings, version: VERSION, updater, docs, avatars: Object.keys(AVATARS), core });

function serve() {
  const s = settings.get();
  if (apiServer) {
    apiServer.close();
    apiServer.closeAllConnections?.();
    apiServer = null;
    apiState = 'stopped';
  }
  if (!s.serving) return refreshMenu();
  apiServer = http.createServer((req, res) => handle(req, res));
  apiServer.on('error', (err) => {
    apiState = err.code === 'EADDRINUSE' ? `port ${s.port} is in use` : err.message;
    core.reportError({ source: 'api', message: `The API didn't start: ${apiState}` });
    console.error('Super Face API:', apiState);
    refreshMenu();
  });
  apiServer.listen(s.port, '127.0.0.1', () => {
    apiState = 'running';
    refreshMenu();
  });
}

// ---------------------------------------------------------------- the menu bar

function setTrayIcon(speaking) {
  if (!tray) return;
  const img = nativeImage.createFromBitmap(iconPixels(36, speaking), { width: 36, height: 36, scaleFactor: 2 });
  img.setTemplateImage(true);
  tray.setImage(img);
}

function radio(label, entries, current, set) {
  return { label, submenu: Object.entries(entries).map(([k, v]) => ({ label: v, type: 'radio', checked: k === current, click: () => set(k) })) };
}

function menu() {
  const s = settings.get();
  const u = updater.state();
  const visible = !!win?.isVisible();
  const ttsLine =
    face.avatar === 'failed'
      ? `The avatar didn't load: ${face.message || ''}`.slice(0, 70)
      : face.tts.state === 'ready'
      ? `Voice ready (${face.backend === 'webgpu' ? 'GPU' : 'CPU'})`
      : face.tts.state === 'downloading'
        ? `Getting the voices… ${Math.round((face.tts.progress || 0) * 100)}%`
        : face.tts.state === 'failed'
          ? `Voice didn't load: ${face.tts.message || ''}`.slice(0, 60)
          : 'Loading the voice…';
  const updateItem =
    u.state === 'available'
      ? { label: `Update to ${u.latest}`, click: () => updater.install() }
      : u.state === 'installing'
        ? { label: u.step || 'Updating…', enabled: false }
        : { label: u.state === 'checking' ? 'Checking for updates…' : u.state === 'failed' ? `Check for updates (${u.message})`.slice(0, 70) : 'Check for updates', enabled: u.state !== 'checking', click: () => updater.check(true) };
  const a = core.assistant.state();
  const ears = core.status().ears;
  const earsLine = !s.listening
    ? 'Not listening'
    : ears.state === 'failed'
      ? `Can't hear: ${ears.message || ''}`.slice(0, 70)
      : ears.state === 'loading'
        ? `Getting the ears ready…${ears.progress ? ` ${Math.round(ears.progress * 100)}%` : ''}`
        : ears.state === 'off'
          ? 'Listening while the character shows'
          : 'Listening';
  const tools = core.toolrun.catalog;
  return Menu.buildFromTemplate([
    { label: visible ? 'Hide the character' : 'Show the character', accelerator: 'CommandOrControl+Shift+A', click: toggle },
    { label: chat?.isVisible() ? 'Hide the chat' : 'Open the chat', click: toggleChat },
    { label: 'Listen', type: 'checkbox', checked: s.listening, click: () => settings.set({ listening: !s.listening }) },
    { label: a.busy ? 'Stop (cancel what it’s doing)' : 'Stop talking', enabled: a.busy || speech.speaking || speech.queued > 0, click: () => (a.busy ? core.assistant.cancel() : speech.stop()) },
    { type: 'separator' },
    { label: ttsLine, enabled: false },
    { label: earsLine, enabled: false },
    { label: a.error ? `Model: ${a.error}`.slice(0, 70) : `Model: ${a.model || 'the best Ollama has'}`, enabled: false },
    { label: tools.reachable && !tools.error ? `Tools: ${tools.scripts.length} scripts, ${tools.flows.length} flows` : 'Tools: Tool Mac Tool Run isn’t running', enabled: false },
    { type: 'separator' },
    radio('Character (and voice)', AVATARS, s.avatar, (k) => settings.set({ avatar: k, voice: characterOf(k).voice })),
    radio('Framing', VIEWS, s.view, (k) => settings.set({ view: k })),
    radio('Speed', { 0.8: 'Slower', 0.9: 'A little slower', 1: 'Normal', 1.1: 'A little faster', 1.25: 'Faster' }, String(s.speed), (k) => settings.set({ speed: Number(k) })),
    radio('Mood at rest', Object.fromEntries(Object.keys(MOODS).filter((m) => m !== 'sleep').map((m) => [m, m[0].toUpperCase() + m.slice(1)])), s.mood, (k) => settings.set({ mood: k })),
    radio('Expressions for other apps', { model: 'From the model', rules: 'From the words only', off: 'Only when asked' }, s.expressions, (k) => settings.set({ expressions: k })),
    radio('Size', Object.fromEntries(Object.keys(SIZES).map((k) => [k, k])), s.size, (k) => win && resize(k)),
    radio('Hide after talking', { 0: 'Never', 10: 'After 10 seconds', 30: 'After 30 seconds', 120: 'After 2 minutes' }, String(s.hideAfter), (k) => settings.set({ hideAfter: Number(k) })),
    { label: 'Captions', type: 'checkbox', checked: s.captions, click: () => settings.set({ captions: !s.captions }) },
    { label: 'Keep on top', type: 'checkbox', checked: s.alwaysOnTop, click: () => settings.set({ alwaysOnTop: !s.alwaysOnTop }) },
    { type: 'separator' },
    { label: s.serving ? (apiState === 'running' ? `API on 127.0.0.1:${s.port}` : `API: ${apiState}`) : 'API stopped', enabled: false },
    { label: s.serving ? 'Stop the API' : 'Start the API', click: () => settings.set({ serving: !s.serving }) },
    { label: 'Copy API URL', click: () => clipboard.writeText(`http://127.0.0.1:${s.port}`) },
    { label: 'Copy API docs', click: () => clipboard.writeText(docs().replaceAll('127.0.0.1:8769', `127.0.0.1:${s.port}`)) },
    { label: 'Try it…', enabled: apiState === 'running', click: () => shell.openExternal(`http://127.0.0.1:${s.port}/`) },
    { type: 'separator' },
    updateItem,
    { label: `Version ${VERSION}`, enabled: false },
    { label: 'Open at login', type: 'checkbox', checked: app.getLoginItemSettings().openAtLogin, click: (i) => app.setLoginItemSettings({ openAtLogin: i.checked }) },
    { label: 'Reload the avatar', click: () => win?.reload() },
    { label: 'Developer tools', click: () => win?.webContents.openDevTools({ mode: 'detach' }) },
    { label: 'Chat developer tools', enabled: !!chat, click: () => chat?.webContents.openDevTools({ mode: 'detach' }) },
    { label: 'Quit Super Face', role: 'quit' },
  ]);
}

let menuTimer = null;
function refreshMenu() {
  // Rebuilt at most a few times a second (progress reports come often).
  if (menuTimer) return;
  menuTimer = setTimeout(() => {
    menuTimer = null;
    if (!tray) return;
    tray.setToolTip(`Super Face${speech.speaking ? ' · speaking' : ''}`);
  }, 250);
}

// ---------------------------------------------------------------- go

app.on('second-instance', show);

app.whenReady().then(async () => {
  // The microphone: macOS asks the user once (Electron itself allows its pages everything they ask for).
  if (process.platform === 'darwin' && !process.env.SUPERFACE_NO_MIC) systemPreferences.askForMediaAccess('microphone').catch(() => {});
  rendererUrl = await startStatic();
  tray = new Tray(nativeImage.createEmpty());
  setTrayIcon(false);
  tray.setToolTip('Super Face');
  // A click shows or hides the avatar; a right-click (or ⌃-click) opens the menu.
  tray.on('click', (e) => (e.ctrlKey ? tray.popUpContextMenu(menu()) : toggle()));
  tray.on('right-click', () => tray.popUpContextMenu(menu()));
  createWindow();
  core.start();
  // On standby as it opens: shown, listening, ready for anything.
  if (settings.get().showAtLaunch) show();
  serve();
  setInterval(() => speech.watch(), 5000);
  updater.start();
  globalShortcut.register('CommandOrControl+Shift+A', toggle);
});

app.on('will-quit', () => globalShortcut.unregisterAll());
app.on('window-all-closed', () => {
  /* it lives in the menu bar */
});

