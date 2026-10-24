// Super Face: the Electron main process. A menu bar icon; a frameless, transparent window with the
// avatar in it, head to toes, hidden until it's called (a click on the icon, or a client's call);
// the HTTP API on 127.0.0.1:8769. The renderer does the speaking (HeadTTS) and the moving
// (TalkingHead); this process keeps the record of it, owns the window, and answers the API.

import { app, BrowserWindow, Menu, Tray, clipboard, globalShortcut, ipcMain, nativeImage, screen, shell } from 'electron';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApi } from './src/main/api.mjs';
import { iconPixels } from './src/main/icon.mjs';
import { Settings } from './src/main/settings.mjs';
import { Speech } from './src/main/speech.mjs';
import { Updater } from './src/main/updater.mjs';
import { MOODS } from './src/shared/catalog.mjs';
import { VOICES } from './src/shared/voices.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
const AVATARS = { brunette: 'Brunette (woman)', david: 'David (man)' };
const SIZES = { Small: [260, 560], Medium: [340, 720], Large: [440, 920] };
const VIEWS = { full: 'Head to toes', mid: 'Waist up', upper: 'Head and shoulders', head: 'Face' };

if (!app.requestSingleInstanceLock()) app.quit();
app.setName('Super Face');
app.dock?.hide();

let win = null;
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

ipcMain.on('event', (_e, ev) => {
  if (ev.type === 'state') {
    face = { ...face, ...ev.state };
    refreshMenu();
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

function afterSpeaking() {
  if (speech.speaking || speech.queued) return;
  setTrayIcon(false);
  const after = settings.get().hideAfter;
  clearTimeout(hideTimer);
  if (after > 0) hideTimer = setTimeout(() => !speech.speaking && hide(), after * 1000);
}

ipcMain.handle('settings:get', () => ({ ...settings.get(), avatars: AVATARS, version: VERSION }));
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
});

// What the renderer is told when a setting it uses changes.
settings.onChange((s, before) => {
  const changed = ['avatar', 'view', 'voice', 'speed', 'mood', 'expressions', 'superVoiceUrl', 'captions'].filter((k) => s[k] !== before[k]);
  if (changed.length) send('settings', Object.fromEntries(changed.map((k) => [k, s[k]])));
  if (s.port !== before.port || s.serving !== before.serving) serve();
  if (s.alwaysOnTop !== before.alwaysOnTop) win?.setAlwaysOnTop(s.alwaysOnTop, 'floating');
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
  win.on('moved', () => settings.set({ bounds: win.getBounds() }));
  win.on('closed', () => (win = null));
  win.on('show', refreshMenu);
  win.on('hide', refreshMenu);
  win.webContents.on('render-process-gone', (_e, d) => {
    console.error('Super Face: the avatar crashed:', d.reason);
    for (const id of [...speech.order]) speech.finish(id, 'failed', 'the avatar crashed');
    setTimeout(() => win?.reload(), 1000);
  });
  win.loadURL(`${rendererUrl}/renderer/index.html`);
}

const inside = (b, a) => b.x >= a.x - 50 && b.y >= a.y - 50 && b.x + b.width <= a.x + a.width + 50 && b.y + b.height <= a.y + a.height + 50;

function show() {
  clearTimeout(hideTimer);
  if (!win) createWindow();
  if (!win.isVisible()) win.showInactive();
}

function hide() {
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
  win.setBounds({ x: b.x + Math.round((b.width - w) / 2), y: b.y + b.height - h, width: w, height: h });
  settings.set({ size: name, bounds: win.getBounds() });
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

function startStatic() {
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
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`)));
}

// ---------------------------------------------------------------- the API

const faceApi = {
  status: () => ({ visible: !!win?.isVisible(), avatar: face.avatar, tts: face.tts, backend: face.backend }),
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

const handle = createApi({ speech, face: faceApi, settings, version: VERSION, updater, docs, avatars: Object.keys(AVATARS) });

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
    face.tts.state === 'ready'
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
  return Menu.buildFromTemplate([
    { label: visible ? 'Hide the avatar' : 'Show the avatar', accelerator: 'CommandOrControl+Shift+A', click: toggle },
    { label: 'Say hello', click: () => {
        show();
        speech.enqueue({ text: 'Hi! I am Super Face. Send me words and I will say them, with feeling.', voice: s.voice, speed: s.speed, gesture: 'handup', auto: true, source: 'menu' });
      },
    },
    { label: 'Stop talking', enabled: speech.speaking || speech.queued > 0, click: () => speech.stop() },
    { type: 'separator' },
    { label: ttsLine, enabled: false },
    radio('Avatar', AVATARS, s.avatar, (k) => settings.set({ avatar: k })),
    radio('Framing', VIEWS, s.view, (k) => settings.set({ view: k })),
    radio('Voice', Object.fromEntries(VOICES.map((v) => [v.id, `${v.name} · ${v.female ? 'woman' : 'man'}${v.id.startsWith('b') ? ', UK' : ''}`])), s.voice, (k) => settings.set({ voice: k })),
    radio('Speed', { 0.8: 'Slower', 0.9: 'A little slower', 1: 'Normal', 1.1: 'A little faster', 1.25: 'Faster' }, String(s.speed), (k) => settings.set({ speed: Number(k) })),
    radio('Mood at rest', Object.fromEntries(Object.keys(MOODS).filter((m) => m !== 'sleep').map((m) => [m, m[0].toUpperCase() + m.slice(1)])), s.mood, (k) => settings.set({ mood: k })),
    radio('Expressions', { model: "From Super Voice's model", rules: 'From the words only', off: 'Only when asked' }, s.expressions, (k) => settings.set({ expressions: k })),
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
  rendererUrl = await startStatic();
  tray = new Tray(nativeImage.createEmpty());
  setTrayIcon(false);
  tray.setToolTip('Super Face');
  // A click shows or hides the avatar; a right-click (or ⌃-click) opens the menu.
  tray.on('click', (e) => (e.ctrlKey ? tray.popUpContextMenu(menu()) : toggle()));
  tray.on('right-click', () => tray.popUpContextMenu(menu()));
  createWindow();
  serve();
  updater.start();
  globalShortcut.register('CommandOrControl+Shift+A', toggle);
});

app.on('will-quit', () => globalShortcut.unregisterAll());
app.on('window-all-closed', () => {
  /* it lives in the menu bar */
});

