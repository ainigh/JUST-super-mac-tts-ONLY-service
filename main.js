// Avatar Desk — Electron main process.
// Serves the renderer over http://127.0.0.1:<random port> (Super Voice and Ollama
// both accept browser requests from localhost origins, but not from file://),
// opens a frameless transparent window, and owns shortcuts, menu and settings.

const { app, BrowserWindow, ipcMain, globalShortcut, Menu, screen, session, systemPreferences } = require('electron');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = __dirname;
const SERVED = ['renderer', 'node_modules']; // nothing else is reachable over http
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.glb': 'model/gltf-binary',
  '.bin': 'application/octet-stream',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

const SIZES = { Small: [320, 480], Medium: [420, 640], Large: [560, 840] };

let win = null;
let baseUrl = null;
let clickThrough = false;

// ---------- settings (a JSON file in the app's userData folder) ----------

const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');

function readSettings() {
  try {
    return JSON.parse(fs.readFileSync(settingsFile(), 'utf8'));
  } catch {
    return {};
  }
}

function writeSettings(patch) {
  const next = { ...readSettings(), ...patch };
  fs.mkdirSync(path.dirname(settingsFile()), { recursive: true });
  fs.writeFileSync(settingsFile(), JSON.stringify(next, null, 2));
  return next;
}

// ---------- local static server ----------

function startServer() {
  const server = http.createServer((req, res) => {
    let rel;
    try {
      rel = decodeURIComponent(new URL(req.url, 'http://x').pathname).replace(/^\/+/, '');
    } catch {
      res.writeHead(400).end();
      return;
    }
    if (rel === '') rel = 'renderer/index.html';
    const file = path.normalize(path.join(ROOT, rel));
    const allowed = SERVED.some((dir) => file.startsWith(path.join(ROOT, dir) + path.sep));
    if (!allowed) {
      res.writeHead(404).end();
      return;
    }
    fs.readFile(file, (err, data) => {
      if (err) {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(200, {
        'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
        'Cache-Control': 'no-cache',
      });
      res.end(data);
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`));
  });
}

// ---------- window ----------

function createWindow() {
  const s = readSettings();
  const area = screen.getPrimaryDisplay().workArea;
  const width = s.bounds?.width ?? 420;
  const height = s.bounds?.height ?? 640;

  win = new BrowserWindow({
    width,
    height,
    x: s.bounds?.x ?? area.x + area.width - width - 24,
    y: s.bounds?.y ?? area.y + area.height - height,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    resizable: false, // transparent windows don't resize reliably; use the Size menu
    alwaysOnTop: s.alwaysOnTop ?? true,
    fullscreenable: false,
    title: 'Avatar Desk',
    webPreferences: {
      preload: path.join(ROOT, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      autoplayPolicy: 'no-user-gesture-required',
      backgroundThrottling: false,
    },
  });
  win.setAlwaysOnTop(s.alwaysOnTop ?? true, 'floating');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  const saveBounds = () => win && writeSettings({ bounds: win.getBounds() });
  win.on('moved', saveBounds);
  win.on('resized', saveBounds);
  win.on('closed', () => (win = null));

  win.loadURL(`${baseUrl}/renderer/index.html`);
}

function setClickThrough(on) {
  clickThrough = on;
  win?.setIgnoreMouseEvents(on, { forward: true });
  win?.webContents.send('click-through', on);
}

function send(channel, ...args) {
  win?.webContents.send(channel, ...args);
}

// ---------- IPC ----------

ipcMain.handle('settings:get', () => readSettings());
ipcMain.handle('settings:set', (_e, patch) => writeSettings(patch));

let dragStart = null;
ipcMain.on('drag:start', () => {
  if (win) dragStart = win.getPosition();
});
ipcMain.on('drag:move', (_e, dx, dy) => {
  if (win && dragStart) win.setPosition(Math.round(dragStart[0] + dx), Math.round(dragStart[1] + dy));
});
ipcMain.on('drag:end', () => {
  dragStart = null;
  if (win) writeSettings({ bounds: win.getBounds() });
});

ipcMain.on('menu:show', () => {
  if (!win) return;
  const onTop = win.isAlwaysOnTop();
  const view = readSettings().cameraView ?? 'upper';
  Menu.buildFromTemplate([
    { label: 'Settings…', click: () => send('menu', 'settings') },
    { label: 'New conversation', click: () => send('menu', 'clear') },
    { type: 'separator' },
    {
      label: 'Framing',
      submenu: ['head', 'upper', 'mid', 'full'].map((v) => ({
        label: { head: 'Face', upper: 'Head and shoulders', mid: 'Waist up', full: 'Full body' }[v],
        type: 'radio',
        checked: v === view,
        click: () => send('menu', 'view', v),
      })),
    },
    {
      label: 'Size',
      submenu: Object.entries(SIZES).map(([name, [w, h]]) => ({
        label: name,
        type: 'radio',
        checked: win.getSize()[0] === w,
        click: () => {
          // Grow or shrink around the bottom edge, where the avatar stands.
          const b = win.getBounds();
          win.setBounds({ x: b.x + Math.round((b.width - w) / 2), y: b.y + b.height - h, width: w, height: h });
          writeSettings({ bounds: win.getBounds() });
        },
      })),
    },
    {
      label: 'Keep on top',
      type: 'checkbox',
      checked: onTop,
      click: () => {
        win.setAlwaysOnTop(!onTop, 'floating');
        writeSettings({ alwaysOnTop: !onTop });
      },
    },
    { label: 'Let clicks pass through  (⌘⇧H to undo)', click: () => setClickThrough(true) },
    { type: 'separator' },
    { label: 'Reload', click: () => win.reload() },
    { label: 'Developer tools', click: () => win.webContents.openDevTools({ mode: 'detach' }) },
    { label: 'Quit Avatar Desk', role: 'quit' },
  ]).popup({ window: win });
});

// ---------- app ----------

app.whenReady().then(async () => {
  // Microphone: macOS asks once; the renderer's getUserMedia is then allowed.
  if (process.platform === 'darwin') {
    try {
      await systemPreferences.askForMediaAccess('microphone');
    } catch {
      /* the user can grant it later in System Settings */
    }
  }
  session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => cb(permission === 'media'));
  session.defaultSession.setPermissionCheckHandler((_wc, permission) => permission === 'media');

  baseUrl = await startServer();
  createWindow();

  // ⌘⇧Space: start listening / stop and send — works while you're in other apps.
  globalShortcut.register('CommandOrControl+Shift+Space', () => send('shortcut', 'talk'));
  // ⌘⇧H: let clicks pass through the avatar, or take them again.
  globalShortcut.register('CommandOrControl+Shift+H', () => setClickThrough(!clickThrough));
  // ⌘⇧A: hide or show the avatar.
  globalShortcut.register('CommandOrControl+Shift+A', () => {
    if (!win) return;
    if (win.isVisible()) win.hide();
    else win.showInactive();
  });

  app.on('activate', () => {
    if (!win) createWindow();
  });
});

app.on('will-quit', () => globalShortcut.unregisterAll());
app.on('window-all-closed', () => app.quit());
