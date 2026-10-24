// The few things the avatar's page may ask the main process for, and hear from it.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('face', {
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (patch) => ipcRenderer.invoke('settings:set', patch),
  /** Commands from the main process: { id, type, data }. */
  onCommand: (fn) => ipcRenderer.on('cmd', (_e, cmd) => fn(cmd)),
  reply: (id, ok, result, error) => ipcRenderer.send('reply', { id, ok, result, error }),
  /** How speaking is going, and the page's state. */
  event: (ev) => ipcRenderer.send('event', ev),
  dragStart: () => ipcRenderer.send('drag:start'),
  dragMove: (dx, dy) => ipcRenderer.send('drag:move', dx, dy),
  dragEnd: () => ipcRenderer.send('drag:end'),
  showMenu: () => ipcRenderer.send('menu:show'),
  toggleChat: () => ipcRenderer.send('chat:toggle'),
});
